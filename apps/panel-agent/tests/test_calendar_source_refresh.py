from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.planning_adapter import PlanningAdapter
from panel_agent.planning_api import build_planning_router
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


class DelayedSourceRefreshTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.fixture = PlanningFixtureTransport("healthy")
        self.requests: list[tuple[str, str]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        if request.url.path == "/internal/planning/v1/calendar-sources/refresh":
            await asyncio.sleep(0.01)
        return await self.fixture.handle_async_request(request)


def settings(tmp_path) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_timezone="Europe/Moscow",
    )


def test_source_refresh_is_typed_server_action_and_does_not_refresh_calendar_events(tmp_path):
    transport = DelayedSourceRefreshTransport()
    adapter = PlanningAdapter(
        settings(tmp_path),
        transport=transport,
        wall_clock=lambda: datetime(2026, 8, 27, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        results = await asyncio.gather(
            adapter.refresh_calendar_sources(),
            adapter.refresh_calendar_sources(),
        )
        projection = adapter.projection
        await adapter.close()
        return results, projection

    results, projection = asyncio.run(exercise())
    assert [result.result for result in results] == ["success", "success"]
    assert projection is not None
    assert [path for method, path in transport.requests if method == "POST"] == [
        "/internal/planning/v1/calendar-sources/refresh"
    ]
    assert all(path != "/internal/planning/v1/events" for _, path in transport.requests)


def test_source_refresh_route_returns_bounded_result(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path),
        transport=PlanningFixtureTransport("healthy"),
        wall_clock=lambda: datetime(2026, 8, 27, 9, 0, tzinfo=timezone.utc),
    )
    app = FastAPI()
    app.include_router(build_planning_router(adapter))

    with TestClient(app) as client:
        response = client.post("/api/v1/planning/calendar-sources/refresh", json={})

    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == "planning.calendar-sources.refresh.v1"
    assert payload["kind"] == "calendar_sources_refresh"
    assert payload["result"] == "success"
    assert set(payload) == {
        "schemaVersion", "kind", "result", "status", "observedAt",
        "lastSuccessfulSyncAt", "calendarsSeen", "eventsSeen", "errorCode",
        "correlation_id",
    }
