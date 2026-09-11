from __future__ import annotations

import asyncio
import json

import httpx

from panel_agent.integrations import IntegrationRuntime
from panel_agent.project_monitor import DeclarativeProjectMonitor
from panel_agent.project_registry import ProjectConfigDocument, ProjectRegistry
from panel_agent.settings import IntegrationSettings
from panel_agent.snapshot import SnapshotPublisher


def _registry(*, enabled: bool = True, interval: int = 60, stale_after: int = 180) -> ProjectRegistry:
    document = ProjectConfigDocument.model_validate({
        "version": 1,
        "projects": [{
            "id": "external-api",
            "name": "External API",
            "enabled": enabled,
            "category": "external",
            "environments": [{
                "id": "production",
                "services": [{
                    "id": "api",
                    "capabilities": {
                        "monitor": {
                            "adapter": "http",
                            "url_env": "EXTERNAL_API_HEALTH_URL",
                            "interval_seconds": interval,
                            "stale_after_seconds": stale_after,
                        },
                        "actions": [],
                    },
                    "presentation": {"widget": "core.generic-service"},
                }],
            }],
        }],
    })
    return ProjectRegistry(path="<test>", projects=tuple(document.projects))


class _Transport(httpx.AsyncBaseTransport):
    def __init__(self, handler):
        self.handler = handler
        self.calls: list[httpx.Request] = []
        self.active = 0
        self.max_active = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            return await self.handler(request)
        finally:
            self.active -= 1


def _settings(**overrides) -> IntegrationSettings:
    return IntegrationSettings(
        http_request_timeout_seconds=1,
        integration_unavailable_after_seconds=300,
        integration_max_backoff_seconds=120,
        **overrides,
    )


def test_disabled_project_is_not_polled_or_materialized(monkeypatch):
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200)

    transport = _Transport(handler)
    monitor = DeclarativeProjectMonitor(_registry(enabled=False), _settings(), transport=transport)

    async def exercise():
        await monitor.start()
        assert monitor.running is False
        assert monitor.services() == []
        assert calls == []

    asyncio.run(exercise())


def test_missing_url_env_makes_no_request_and_reports_unavailable(monkeypatch):
    monkeypatch.delenv("EXTERNAL_API_HEALTH_URL", raising=False)
    transport = _Transport(lambda request: _unexpected_request(request))
    monitor = DeclarativeProjectMonitor(_registry(), _settings(), transport=transport)

    async def exercise():
        await monitor.refresh()
        service = monitor.services()[0]
        assert service.id == "external-api.production.api"
        assert service.health == "offline"
        assert service.source == "unavailable"
        assert service.actions == []
        assert service.data == {
            "projectId": "external-api",
            "environmentId": "production",
            "serviceId": "api",
        }
        assert transport.calls == []

    asyncio.run(exercise())


def test_successful_2xx_get_becomes_healthy_without_forwarding_body(monkeypatch):
    endpoint = "http://monitor.test/health"
    response_secret = "response-body-secret"
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", endpoint)

    async def handler(request):
        assert request.method == "GET"
        assert str(request.url) == endpoint
        return httpx.Response(204, json={"secret": response_secret})

    transport = _Transport(handler)
    monitor = DeclarativeProjectMonitor(_registry(), _settings(), transport=transport)

    async def exercise():
        result = await monitor.refresh()
        service = monitor.services()[0]
        assert result is True
        assert service.health == "healthy"
        assert service.source == "live"
        assert service.dataContract == "service.health.v1"
        assert service.presentation.category == "external"
        assert service.presentation.group == "External services"
        assert service.presentation.environment == "production"
        assert service.actions == []
        serialized = json.dumps(service.model_dump(mode="json"), sort_keys=True)
        assert endpoint not in serialized
        assert response_secret not in serialized

    asyncio.run(exercise())


async def _unexpected_request(request):
    raise AssertionError(f"unexpected network request: {request.url}")


def test_failed_and_timeout_requests_never_become_healthy(monkeypatch):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")

    async def handler(request):
        if len(transport.calls) == 1:
            return httpx.Response(503)
        raise httpx.ReadTimeout("timed out", request=request)

    transport = _Transport(handler)
    monitor = DeclarativeProjectMonitor(_registry(), _settings(), transport=transport)

    async def exercise():
        assert await monitor.refresh() is False
        assert monitor.services()[0].health != "healthy"
        assert await monitor.refresh() is False
        assert monitor.services()[0].health != "healthy"

    asyncio.run(exercise())


def test_network_failure_uses_truthful_last_known_stale_states(monkeypatch):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")
    available = True
    clock = [100.0]

    async def handler(request):
        if not available:
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(200)

    transport = _Transport(handler)
    monitor = DeclarativeProjectMonitor(
        _registry(interval=5, stale_after=15),
        _settings(),
        transport=transport,
        clock=lambda: clock[0],
    )

    async def exercise():
        nonlocal available
        await monitor.refresh()
        assert monitor.services()[0].source == "live"
        available = False
        clock[0] = 110
        await monitor.refresh()
        assert monitor.services()[0].source == "cached"
        assert monitor.services()[0].health == "degraded"
        clock[0] = 120
        await monitor.refresh()
        assert monitor.services()[0].source == "stale"
        assert monitor.services()[0].health == "stale"
        clock[0] = 500
        await monitor.refresh()
        assert monitor.services()[0].source == "unavailable"
        assert monitor.services()[0].health == "offline"

    asyncio.run(exercise())


def test_duplicate_refreshes_do_not_race(monkeypatch):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")

    async def handler(request):
        await asyncio.sleep(0.01)
        return httpx.Response(200)

    transport = _Transport(handler)
    monitor = DeclarativeProjectMonitor(_registry(), _settings(), transport=transport)

    async def exercise():
        await asyncio.gather(monitor.refresh(), monitor.refresh())
        assert transport.max_active == 1

    asyncio.run(exercise())


def test_monitor_task_shuts_down_cleanly(monkeypatch):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")

    async def handler(request):
        return httpx.Response(200)

    monitor = DeclarativeProjectMonitor(
        _registry(interval=5),
        _settings(),
        transport=_Transport(handler),
    )

    async def exercise():
        await monitor.start()
        assert monitor.running is True
        await monitor.close()
        assert monitor.running is False

    asyncio.run(exercise())


def test_integration_runtime_retains_existing_services_and_adds_declarative_service(
    monkeypatch,
):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")

    async def handler(request):
        return httpx.Response(200)

    runtime = IntegrationRuntime(
        _settings(),
        project_registry=_registry(),
        project_monitor_transport=_Transport(handler),
    )
    publisher = SnapshotPublisher(mode="read_only", services_builder=runtime.services)
    runtime.set_snapshot_callback(publisher.rebuild)

    async def exercise():
        await runtime.project_monitor.refresh()
        ids = {service.id for service in runtime.services()}
        assert {
            "home-assistant",
            "coffee-machine",
            "alice-tg-bot",
            "external-api.production.api",
        }.issubset(ids)
        assert "avalar.main.website" not in ids
        assert "avalar.stage.website" not in ids
        assert "avalar-site-main" not in ids
        assert "avalar-site-stage" not in ids
        snapshot = publisher.snapshot
        assert snapshot is not None
        declarative = next(
            service for service in snapshot.services if service.id == "external-api.production.api"
        )
        assert declarative.actions == []
        assert "monitor.test" not in json.dumps(declarative.model_dump(mode="json"))
        await runtime.close()
        await publisher.close()

    asyncio.run(exercise())


def test_disabled_project_is_absent_from_integration_runtime():
    runtime = IntegrationRuntime(_settings(), project_registry=_registry(enabled=False))

    try:
        assert "external-api.production.api" not in {
            service.id for service in runtime.services()
        }
    finally:
        asyncio.run(runtime.close())
