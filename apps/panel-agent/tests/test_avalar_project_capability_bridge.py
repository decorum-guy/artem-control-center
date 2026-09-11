from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.avalar_actions import (
    AVALAR_ACTION_IDS,
    AvalarActionExecutor,
    avalar_action_descriptor,
)
from panel_agent.http_integrations import HttpIntegrationAdapter
from panel_agent.integrations import IntegrationRuntime
from panel_agent.project_monitor import DeclarativeProjectMonitor
from panel_agent.project_registry import (
    ProjectConfigDocument,
    ProjectRegistry,
    stable_service_snapshot_id,
)
from panel_agent.settings import IntegrationSettings
from panel_agent.avalar_health import legacy_avalar_service_id


MAIN_ACTIONS = [
    "avalar.main.smoke",
    "avalar.main.restart",
    "avalar.main.deploy",
]
STAGE_ACTIONS = [
    "avalar.stage.smoke",
    "avalar.stage.restart",
    "avalar.stage.deploy",
]


def _document(projects: list[dict]) -> ProjectConfigDocument:
    return ProjectConfigDocument.model_validate({"version": 1, "projects": projects})


def _generic_project() -> dict:
    def service(service_id: str) -> dict:
        return {
            "id": service_id,
            "capabilities": {
                "monitor": {
                    "adapter": "http",
                    "url_env": f"{service_id.upper()}_HEALTH_URL",
                    "interval_seconds": 60,
                    "stale_after_seconds": 180,
                },
                "actions": [],
            },
            "presentation": {"widget": "core.generic-service"},
        }

    return {
        "id": "multi-project",
        "name": "Multi project",
        "enabled": True,
        "category": "external",
        "environments": [
            {"id": "production", "services": [service("api"), service("worker")]},
            {"id": "stage", "services": [service("api")]},
        ],
    }


def _avalar_project(
    *,
    main_actions: list[str] | None = None,
    stage_actions: list[str] | None = None,
    details: bool = True,
) -> dict:
    def service(environment: str, actions: list[str]) -> dict:
        target = "MAIN" if environment == "main" else "STAGE"
        capabilities: dict = {
            "monitor": {
                "adapter": "avalar",
                "url_env": f"PANEL_AVALAR_{target}_URL",
                "interval_seconds": 5,
                "stale_after_seconds": 15,
            },
            "actions": actions,
        }
        if details:
            capabilities["details"] = {"adapter": "avalar-ssh"}
        return {
            "id": "website",
            "capabilities": capabilities,
            "presentation": {"widget": "core.generic-service"},
        }

    return {
        "id": "avalar",
        "name": "AVALAR",
        "enabled": True,
        "category": "work",
        "environments": [
            {
                "id": "main",
                "services": [
                    service("main", main_actions if main_actions is not None else MAIN_ACTIONS)
                ],
            },
            {
                "id": "stage",
                "services": [
                    service("stage", stage_actions if stage_actions is not None else STAGE_ACTIONS)
                ],
            },
        ],
    }


class _AvalarTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.states = {"main": "healthy", "stage": "healthy"}
        self.calls: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        target = "main" if request.url.host == "main.test" else "stage"
        state = self.states[target]
        if state == "offline":
            raise httpx.ConnectError("offline", request=request)
        if request.url.path == "/health/live":
            return httpx.Response(200, json={"status": "live"}, request=request)
        if request.url.path == "/health/ready":
            if state == "degraded":
                return httpx.Response(503, json={"status": "down"}, request=request)
            return httpx.Response(200, json={"status": "ready"}, request=request)
        return httpx.Response(404, request=request)


class _Details:
    def details_for(self, service_id: str) -> dict:
        target = "main" if service_id == "avalar-site-main" else "stage"
        commit = "a" * 40 if target == "main" else "b" * 40
        return {
            "ok": True,
            "environment": "production" if target == "main" else "stage",
            "version": "2026.09.11",
            "commit": commit,
            "branch": target,
            "deployment_revision": commit,
            "deployed_at": "2026-09-11T10:00:00Z",
            "working_tree": "clean",
            "details_source": "live",
            "details_observed_at": "2026-09-11T10:01:00Z",
        }

    def details_for_url_env(self, url_env: str) -> dict:
        service_id = "avalar-site-main" if url_env.endswith("MAIN_URL") else "avalar-site-stage"
        return self.details_for(service_id)

    async def refresh(self) -> None:
        return None


def _settings(**overrides) -> IntegrationSettings:
    return IntegrationSettings(
        http_request_timeout_seconds=1,
        integration_unavailable_after_seconds=300,
        integration_max_backoff_seconds=120,
        avalar_main_url="https://main.test",
        avalar_stage_url="https://stage.test",
        **overrides,
    )


def _registry(project: dict) -> ProjectRegistry:
    document = _document([project])
    return ProjectRegistry(path=Path("<test>"), projects=tuple(document.projects))


def test_existing_monitor_only_http_and_multiple_environment_service_shape_remain_valid():
    document = _document([_generic_project()])
    assert len(document.projects[0].environments) == 2
    assert [service.id for service in document.projects[0].environments[0].services] == [
        "api",
        "worker",
    ]
    assert document.projects[0].environments[0].services[0].capabilities.actions == []


def test_avalar_project_accepts_registered_monitor_details_and_fixed_actions():
    document = _document([_avalar_project()])
    assert document.projects[0].category == "work"
    assert document.projects[0].environments[0].services[0].capabilities.monitor.adapter == "avalar"
    assert document.projects[0].environments[0].services[0].capabilities.details is not None
    assert document.projects[0].environments[1].services[0].capabilities.actions == STAGE_ACTIONS
    assert set(AVALAR_ACTION_IDS) == set(MAIN_ACTIONS + STAGE_ACTIONS)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("environments", 0, "services", 0, "capabilities", "monitor", "adapter"), "ssh"),
        (("environments", 0, "services", 0, "capabilities", "actions"), ["avalar.main.unknown"]),
    ],
)
def test_unknown_registered_capability_is_rejected(path, value):
    project = _avalar_project()
    current = project
    for key in path[:-1]:
        current = current[key]
    current[path[-1]] = value
    with pytest.raises(ValidationError):
        _document([project])


def test_arbitrary_ssh_details_configuration_is_rejected():
    project = _avalar_project()
    project["environments"][0]["services"][0]["capabilities"]["details"] = {
        "adapter": "avalar-ssh",
        "host": "browser-controlled-host",
        "command": "rm -rf /",
    }
    with pytest.raises(ValidationError):
        _document([project])


@pytest.mark.parametrize(
    ("environment_index", "actions"),
    [(0, ["avalar.stage.restart"]), (1, ["avalar.main.deploy"])],
)
def test_registered_action_target_must_match_environment(environment_index, actions):
    project = _avalar_project()
    project["environments"][environment_index]["services"][0]["capabilities"]["actions"] = actions
    with pytest.raises(ValidationError, match="target"):
        _document([project])


def test_duplicate_registered_action_ids_are_rejected():
    project = _avalar_project(main_actions=["avalar.main.smoke"], stage_actions=[])
    duplicate_service = {
        "id": "worker",
        "capabilities": {
            "monitor": {
                "adapter": "avalar",
                "url_env": "PANEL_AVALAR_MAIN_URL",
                "interval_seconds": 5,
                "stale_after_seconds": 15,
            },
            "actions": ["avalar.main.smoke"],
        },
        "presentation": {"widget": "core.generic-service"},
    }
    project["environments"][0]["services"].append(duplicate_service)
    with pytest.raises(ValidationError, match="duplicate registered action"):
        _document([project])


def test_registry_avalar_health_matches_legacy_mapping_and_details_are_sanitized(monkeypatch):
    monkeypatch.setenv("PANEL_AVALAR_MAIN_URL", "https://main.test")
    monkeypatch.setenv("PANEL_AVALAR_STAGE_URL", "https://stage.test")
    transport = _AvalarTransport()
    details = _Details()
    registry_monitor = DeclarativeProjectMonitor(
        _registry(_avalar_project()),
        _settings(),
        transport=transport,
        details_provider=details,
        action_availability_provider=lambda action_id: action_id.endswith("smoke"),
    )
    legacy = HttpIntegrationAdapter(_settings(), transport=transport)

    async def exercise() -> None:
        await legacy.refresh()
        await registry_monitor.refresh()

        legacy_by_environment = {
            service.presentation.environment: service for service in legacy.services()
            if service.presentation and service.presentation.group == "AVALAR"
        }
        registry_by_environment = {
            service.presentation.environment: service for service in registry_monitor.services()
            if service.presentation and service.presentation.group == "AVALAR"
        }
        assert registry_by_environment["main"].health == legacy_by_environment["production"].health
        assert registry_by_environment["main"].summary == legacy_by_environment["production"].summary
        assert registry_by_environment["stage"].health == legacy_by_environment["stage"].health
        assert registry_by_environment["stage"].summary == legacy_by_environment["stage"].summary

        main = registry_by_environment["main"]
        assert main.id == "avalar.main.website"
        assert main.data["version"] == "2026.09.11"
        assert main.data["commit"] == "a" * 40
        assert main.data["detailsAvailable"] is True
        assert [action.id for action in main.actions] == MAIN_ACTIONS
        assert main.actions[0].enabled is True
        assert main.actions[1].enabled is False
        serialized = json.dumps(main.model_dump(mode="json"), sort_keys=True)
        for forbidden in ("browser-controlled-host", "rm -rf /", "password", "token", "ssh_host"):
            assert forbidden not in serialized

    asyncio.run(exercise())


def test_avalar_main_failure_does_not_affect_stage(monkeypatch):
    monkeypatch.setenv("PANEL_AVALAR_MAIN_URL", "https://main.test")
    monkeypatch.setenv("PANEL_AVALAR_STAGE_URL", "https://stage.test")
    transport = _AvalarTransport()
    transport.states["main"] = "offline"
    monitor = DeclarativeProjectMonitor(
        _registry(_avalar_project()),
        _settings(),
        transport=transport,
    )

    async def exercise() -> None:
        assert await monitor.refresh() is False
        services = {service.presentation.environment: service for service in monitor.services() if service.presentation}
        assert services["main"].health == "offline"
        assert services["stage"].health == "healthy"

    asyncio.run(exercise())


def test_avalar_cached_stale_and_unavailable_semantics_are_bounded(monkeypatch):
    monkeypatch.setenv("PANEL_AVALAR_MAIN_URL", "https://main.test")
    monkeypatch.setenv("PANEL_AVALAR_STAGE_URL", "https://stage.test")
    transport = _AvalarTransport()
    clock = [100.0]
    monitor = DeclarativeProjectMonitor(
        _registry(_avalar_project(stage_actions=[])),
        _settings(),
        transport=transport,
        clock=lambda: clock[0],
    )

    async def exercise() -> None:
        await monitor.refresh()
        transport.states["main"] = "offline"
        clock[0] = 110.0
        await monitor.refresh(["avalar.main.website"])
        assert monitor.services()[0].source == "cached"
        assert monitor.services()[0].health == "degraded"
        clock[0] = 120.0
        await monitor.refresh(["avalar.main.website"])
        assert monitor.services()[0].source == "stale"
        assert monitor.services()[0].health == "stale"
        clock[0] = 500.0
        await monitor.refresh(["avalar.main.website"])
        assert monitor.services()[0].source == "unavailable"
        assert monitor.services()[0].health == "offline"

    asyncio.run(exercise())


def test_action_gate_state_controls_registry_descriptor_and_executor_is_fixed(tmp_path):
    settings = _settings(
        writes_enabled=True,
        avalar_actions_enabled=True,
        avalar_smoke_enabled=True,
        avalar_main_deploy_enabled=False,
        avalar_action_ssh_host="avalar-control",
        avalar_action_remote_script="control-center",
    )
    access = AccessPolicyStore(tmp_path / "policy.json")
    access.set_pin("2468")
    access.set_profile("full", pin="2468")

    async def exercise() -> None:
        executor = AvalarActionExecutor(settings, access, details_provider=_Details())
        assert executor.command_runner.__name__ == "_run_fixed_command"
        assert executor.action_available("avalar.main.smoke") is True
        assert executor.action_available("avalar.main.deploy") is False
        assert avalar_action_descriptor("avalar.main.deploy").enabled is False
        monitor = DeclarativeProjectMonitor(
            _registry(_avalar_project(main_actions=["avalar.main.smoke", "avalar.main.deploy"], stage_actions=[])),
            settings,
            action_availability_provider=executor.action_available,
        )
        services = monitor.services()
        actions = {action.id: action for action in services[0].actions}
        assert actions["avalar.main.smoke"].enabled is True
        assert actions["avalar.main.deploy"].enabled is False

    asyncio.run(exercise())


def test_legacy_avalar_materialization_is_unchanged_without_registry_project():
    runtime = IntegrationRuntime(
        _settings(),
        project_registry=ProjectRegistry.empty(Path("<test>")),
    )

    async def exercise() -> None:
        try:
            ids = {service.id for service in runtime.services()}
            assert {"avalar-site-main", "avalar-site-stage"}.issubset(ids)
            assert "avalar.main.website" not in ids
        finally:
            await runtime.close()

    asyncio.run(exercise())


def test_pr_b_identity_mapping_is_explicit_and_deterministic():
    assert legacy_avalar_service_id("main") == "avalar-site-main"
    assert legacy_avalar_service_id("stage") == "avalar-site-stage"
    assert stable_service_snapshot_id("avalar", "main", "website") == "avalar.main.website"
    assert stable_service_snapshot_id("avalar", "stage", "website") == "avalar.stage.website"
