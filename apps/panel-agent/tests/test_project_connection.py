from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_middleware import AccessPolicyMiddleware
from panel_agent.access_policy import AccessPolicyStore
from panel_agent.project_monitor import DeclarativeProjectMonitor, probe_declarative_http_monitor
from panel_agent.project_registry import ProjectConfigDocument, ProjectRegistry, load_project_registry
from panel_agent.project_registry_api import build_project_registry_router
from panel_agent.project_registry_store import ProjectRegistryStore
from panel_agent.settings import IntegrationSettings


def _project(
    *,
    project_id: str = "external-api",
    environment_id: str = "production",
    service_id: str = "api",
    url_env: str = "EXTERNAL_API_HEALTH_URL",
) -> dict:
    return {
        "id": project_id,
        "name": "External API",
        "enabled": True,
        "category": "external",
        "environments": [{
            "id": environment_id,
            "services": [{
                "id": service_id,
                "capabilities": {
                    "monitor": {
                        "adapter": "http",
                        "url_env": url_env,
                        "interval_seconds": 5,
                        "stale_after_seconds": 15,
                    },
                    "actions": [],
                },
                "presentation": {"widget": "core.generic-service"},
            }],
        }],
    }


def _payload(project: dict | None = None, **overrides) -> dict:
    value = {
        "project": project or _project(),
        "environmentId": "production",
        "serviceId": "api",
    }
    value.update(overrides)
    return value


class _Transport(httpx.AsyncBaseTransport):
    def __init__(self, handler):
        self.handler = handler
        self.calls: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return await self.handler(request)


class _Runtime:
    def __init__(self) -> None:
        self.registries = []

    async def replace_project_registry(self, registry) -> None:
        self.registries.append(registry)


def _settings() -> IntegrationSettings:
    return IntegrationSettings(
        http_request_timeout_seconds=1,
        integration_unavailable_after_seconds=300,
        integration_max_backoff_seconds=120,
    )


def _client(
    tmp_path,
    transport: _Transport,
    *,
    access_profile: str = "read_only",
    registry_path=None,
):
    path = registry_path or tmp_path / "projects.yaml"
    access = AccessPolicyStore(tmp_path / "access-policy.json")
    if access_profile == "standard":
        access.set_profile("standard")
    elif access_profile == "full":
        access.set_pin("2468")
        access.set_profile("full", pin="2468")

    runtime = _Runtime()
    rebuild_calls = []

    async def snapshot_rebuild():
        rebuild_calls.append(True)

    app = FastAPI()
    app.add_middleware(AccessPolicyMiddleware, store=access)
    app.include_router(
        build_project_registry_router(
            ProjectRegistryStore(path),
            runtime,
            snapshot_rebuild=snapshot_rebuild,
            writes_allowed=lambda: True,
            connection_test_settings=_settings(),
            connection_test_transport=transport,
        )
    )
    return access, runtime, rebuild_calls, TestClient(app)


def _write_registry(path, project: dict) -> None:
    path.write_text(
        yaml.safe_dump({"version": 1, "revision": 4, "projects": [project]}, sort_keys=False),
        encoding="utf-8",
    )


@pytest.mark.parametrize("status_code", [200, 204])
def test_canonical_project_config_is_accepted_and_uses_only_selected_monitor(monkeypatch, tmp_path, status_code):
    endpoint = "https://monitor.example.test/health"
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", endpoint)

    async def handler(request):
        assert request.method == "GET"
        assert str(request.url) == endpoint
        return httpx.Response(status_code, content=b"body-secret", headers={"X-Secret": "header-secret"})

    transport = _Transport(handler)
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    response = client.post(
        "/api/v1/settings/projects/test-connection",
        json=_payload(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "schemaVersion": "project.connection-test.v1",
        "result": "reachable",
        "reachable": True,
        "httpStatus": status_code,
        "latencyMs": body["latencyMs"],
        "projectId": "external-api",
        "environmentId": "production",
        "serviceId": "api",
    }
    assert isinstance(body["latencyMs"], int)
    assert 0 <= body["latencyMs"] <= 30_000
    serialized = json.dumps(body)
    assert endpoint not in serialized
    assert "body-secret" not in serialized
    assert "header-secret" not in serialized
    assert "urlEnv" not in body
    assert "location" not in response.headers
    assert "x-secret" not in response.headers
    assert len(transport.calls) == 1


def test_unknown_environment_and_service_are_rejected_without_network(tmp_path):
    transport = _Transport(lambda request: _unexpected_request(request))
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    unknown_environment = client.post(
        "/api/v1/settings/projects/test-connection",
        json=_payload(environmentId="staging"),
    )
    unknown_service = client.post(
        "/api/v1/settings/projects/test-connection",
        json=_payload(serviceId="worker"),
    )
    ambiguous_project = _project()
    ambiguous_project["environments"].append(_project()["environments"][0])
    ambiguous_environment = client.post(
        "/api/v1/settings/projects/test-connection",
        json=_payload(ambiguous_project),
    )

    assert unknown_environment.status_code == 422
    assert unknown_environment.json() == {"detail": "unknown_environment"}
    assert unknown_service.status_code == 422
    assert unknown_service.json() == {"detail": "unknown_service"}
    assert ambiguous_environment.status_code == 422
    assert ambiguous_environment.json() == {"detail": "unknown_environment"}
    assert transport.calls == []


def test_request_is_closed_and_rejects_raw_or_secret_fields(tmp_path):
    transport = _Transport(lambda request: _unexpected_request(request))
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    extra_fields = [
        {"url": "https://raw.example.test/health"},
        {"endpoint": "https://raw.example.test/health"},
        {"token": "secret"},
        {"password": "secret"},
        {"secret": "secret"},
        {"headers": {"Authorization": "secret"}},
        {"expectedRevision": 4},
    ]
    responses = [
        client.post(
            "/api/v1/settings/projects/test-connection",
            json={**_payload(), **extra},
        )
        for extra in extra_fields
    ]
    nested = _payload()
    nested["project"]["endpoint"] = "https://raw.example.test/health"
    responses.append(client.post("/api/v1/settings/projects/test-connection", json=nested))

    assert [response.status_code for response in responses] == [422] * len(responses)
    assert all(response.json() == {"detail": "invalid_project_payload"} for response in responses)
    assert transport.calls == []


def test_missing_environment_value_makes_zero_requests_and_is_bounded(monkeypatch, tmp_path):
    monkeypatch.delenv("EXTERNAL_API_HEALTH_URL", raising=False)
    transport = _Transport(lambda request: _unexpected_request(request))
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    response = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": "project.connection-test.v1",
        "result": "endpoint_not_configured",
        "reachable": False,
        "httpStatus": None,
        "latencyMs": None,
        "projectId": "external-api",
        "environmentId": "production",
        "serviceId": "api",
    }
    assert transport.calls == []


def test_invalid_environment_value_makes_zero_requests(monkeypatch, tmp_path):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "ftp://monitor.example.test/health?token=secret")
    transport = _Transport(lambda request: _unexpected_request(request))
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    response = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert response.status_code == 200
    assert response.json()["result"] == "endpoint_invalid"
    assert response.json()["reachable"] is False
    assert response.json()["httpStatus"] is None
    assert response.json()["latencyMs"] is None
    assert transport.calls == []


def test_non_2xx_is_not_reachable_and_redirect_is_not_followed(monkeypatch, tmp_path):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "http://monitor.example.test/health")

    async def handler(request):
        return httpx.Response(
            302,
            content=b"upstream-secret",
            headers={"Location": "https://redirect.example.test", "X-Secret": "header-secret"},
        )

    transport = _Transport(handler)
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    response = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert response.status_code == 200
    assert response.json()["result"] == "http_error"
    assert response.json()["reachable"] is False
    assert response.json()["httpStatus"] == 302
    assert isinstance(response.json()["latencyMs"], int)
    assert "redirect.example.test" not in response.text
    assert "upstream-secret" not in response.text
    assert "header-secret" not in response.text
    assert len(transport.calls) == 1


def test_timeout_or_network_failure_is_unreachable_without_exception_details(monkeypatch, tmp_path):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://offline.example.test/health")
    failure = "socket details must not escape"

    async def handler(request):
        raise httpx.ReadTimeout(failure, request=request)

    transport = _Transport(handler)
    _, _, _, client = _client(tmp_path, transport, access_profile="full")

    response = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert response.status_code == 200
    assert response.json()["result"] == "unreachable"
    assert response.json()["reachable"] is False
    assert response.json()["httpStatus"] is None
    assert response.json()["latencyMs"] is None
    assert failure not in response.text


def test_test_does_not_mutate_registry_runtime_or_snapshot(monkeypatch, tmp_path):
    endpoint = "https://monitor.example.test/health"
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", endpoint)
    path = tmp_path / "projects.yaml"
    _write_registry(path, _project())
    before = path.read_bytes()
    transport = _Transport(lambda request: _response(request, 200))
    _, runtime, rebuild_calls, client = _client(
        tmp_path,
        transport,
        access_profile="full",
        registry_path=path,
    )

    response = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert response.status_code == 200
    assert path.read_bytes() == before
    assert load_project_registry(path).revision == 4
    assert runtime.registries == []
    assert rebuild_calls == []


def test_actual_monitor_and_connection_test_share_probe_result(monkeypatch, tmp_path):
    endpoint = "https://monitor.example.test/health"
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", endpoint)

    async def handler(request):
        return httpx.Response(503)

    transport = _Transport(handler)
    settings = _settings()
    document = ProjectConfigDocument.model_validate({"version": 1, "projects": [_project()]})
    registry = ProjectRegistry(path="<test>", projects=tuple(document.projects))
    monitor = DeclarativeProjectMonitor(registry, settings, transport=transport)

    async def exercise():
        probe = await probe_declarative_http_monitor(
            document.projects[0].environments[0].services[0].capabilities.monitor,
            settings,
            transport=transport,
        )
        await monitor.refresh()
        return probe, monitor.services()[0]

    probe, service = asyncio.run(exercise())

    assert probe.result == "http_error"
    assert probe.http_status == 503
    assert service.health == "offline"
    assert service.source == "unavailable"
    assert len(transport.calls) == 2


def test_connection_test_route_is_full_only_and_exactly_registered(monkeypatch, tmp_path):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.example.test/health")
    transport = _Transport(lambda request: _response(request, 200))
    access, _, _, client = _client(tmp_path, transport)

    read_only = client.post("/api/v1/settings/projects/test-connection", json=_payload())
    access.set_pin("2468")
    access.set_profile("standard")
    standard = client.post("/api/v1/settings/projects/test-connection", json=_payload())
    access.set_profile("full", pin="2468")
    full = client.post("/api/v1/settings/projects/test-connection", json=_payload())

    assert read_only.status_code == 403
    assert standard.status_code == 403
    assert full.status_code == 200
    assert len(transport.calls) == 1


async def _unexpected_request(request):
    raise AssertionError(f"unexpected request: {request.url}")


async def _response(request, status_code: int) -> httpx.Response:
    return httpx.Response(status_code, request=request)
