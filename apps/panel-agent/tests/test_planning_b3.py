from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.planning_adapter import (
    PlanningAdapter,
    PlanningBoundedScanError,
    PlanningClient,
)
from panel_agent.planning_api import build_planning_router
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


def settings(tmp_path, scenario: str) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_refresh_seconds=10,
        panel_planning_status_refresh_seconds=300,
        panel_planning_stale_after_seconds=10,
        panel_planning_unavailable_after_seconds=30,
        panel_planning_max_backoff_seconds=60,
        panel_planning_cache_path=str(tmp_path / f"{scenario}.json"),
        panel_planning_response_limit_bytes=256 * 1024,
        panel_planning_timezone="Europe/Moscow",
        panel_planning_fixture_scenario=scenario,
    )


_OBSERVED_SOURCES = [
    {
        "sourceType": "native_planning",
        "accountId": "local",
        "provider": "local",
        "status": "current",
        "lastSyncedAt": "2026-08-12T09:00:00Z",
        "observedAt": "2026-08-12T09:00:00Z",
        "errorCode": None,
        "calendars": [],
    },
    {
        "sourceType": "external_calendar",
        "accountId": "private-account-opaque",
        "provider": "icloud",
        "status": "current",
        "lastSyncedAt": "2026-08-12T09:00:00Z",
        "observedAt": "2026-08-12T09:00:00Z",
        "errorCode": None,
        "calendars": [
            {
                "calendarId": "private-calendar-opaque",
                "displayName": "Рабочий календарь",
                "color": "#4477AA",
                "enabled": True,
                "status": "current",
                "lastSyncedAt": "2026-08-12T09:00:00Z",
                "observedAt": "2026-08-12T09:00:00Z",
                "errorCode": None,
            }
        ],
    },
]


class SourcedReminderFixtureTransport(PlanningFixtureTransport):
    """Add valid upstream source metadata to the normal reminder fixture."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await super().handle_async_request(request)
        if response.status_code != 200 or request.url.path != "/internal/planning/v1/reminders":
            return response
        payload = response.json()
        payload["sources"] = _OBSERVED_SOURCES
        return httpx.Response(
            200,
            json=payload,
            headers={"content-type": "application/json"},
            request=request,
        )


def test_reminder_monitor_views_keep_lifecycle_and_delivery_distinct(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-healthy"),
        transport=PlanningFixtureTransport("b3-healthy"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        upcoming = await adapter.read_reminder_view(view="upcoming", limit=20, offset=0)
        overdue = await adapter.read_reminder_view(view="overdue", limit=20, offset=0)
        delivery = await adapter.read_reminder_view(view="delivery", limit=20, offset=0)
        await adapter.close()
        return upcoming, overdue, delivery

    upcoming, overdue, delivery = asyncio.run(exercise())
    assert [item.title for item in upcoming.items] == ["Подготовить документы к отправке"]
    assert {item.title for item in overdue.items} >= {
        "Просроченное напоминание",
        "Доставить документы",
        "Повторить доставку",
        "Доставлено, ждёт завершения",
        "Проверить сбой доставки",
    }
    assert {item.deliveryState for item in delivery.items} == {"queued", "retrying", "failed"}
    assert "Доставлено, ждёт завершения" not in {item.title for item in delivery.items}
    assert all(item.status == "due" for item in delivery.items)
    assert [item.deliveryState for item in delivery.items] == ["failed", "retrying", "queued"]
    for result in (upcoming, overdue, delivery):
        assert result.sources is not None
        assert [source.id for source in result.sources] == ["native-planning"]


@pytest.mark.parametrize("view", ["upcoming", "overdue", "delivery"])
def test_reminder_view_route_emits_browser_safe_sources_for_legacy_upstream(tmp_path, view):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-healthy"),
        transport=PlanningFixtureTransport("b3-healthy"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )
    app = FastAPI()
    app.include_router(build_planning_router(adapter))

    with TestClient(app) as client:
        response = client.get(
            f"/api/v1/planning/reminders/view?view={view}&limit=20&offset=0"
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["schemaVersion"] == "planning.panel.v1"
    assert payload["domain"] == "reminder"
    assert payload["sourceStatus"] == "current"
    assert payload["lastSyncedAt"]
    assert isinstance(payload["sources"], list)
    assert payload["sources"] == [
        {
            "id": "native-planning",
            "kind": "native",
            "provider": "local",
                "label": "Local Planning",
                "status": "current",
                "errorCode": None,
                "configured": True,
            "lastSyncedAt": None,
            "observedAt": payload["sources"][0]["observedAt"],
            "calendars": [],
        }
    ]
    assert payload["sources"] is not None


def test_reminder_view_projects_observed_sources_and_hides_upstream_identity(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-healthy"),
        transport=SourcedReminderFixtureTransport("b3-healthy"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )
    app = FastAPI()
    app.include_router(build_planning_router(adapter))

    with TestClient(app) as client:
        responses = {
            view: client.get(
                f"/api/v1/planning/reminders/view?view={view}&limit=20&offset=0"
            )
            for view in ("upcoming", "overdue", "delivery")
        }

    for response in responses.values():
        payload = response.json()
        assert response.status_code == 200
        assert isinstance(payload["sources"], list)
        assert {source["kind"] for source in payload["sources"]} == {"native", "external"}
        assert {source["provider"] for source in payload["sources"]} == {"local", "icloud"}
        serialized = json.dumps(payload, ensure_ascii=False)
        assert "private-account-opaque" not in serialized
        assert "private-calendar-opaque" not in serialized
        assert "accountId" not in serialized
        assert "correlation_id" not in serialized


def test_reminder_derived_view_has_truthful_bounded_pagination(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-route-pagination"),
        transport=PlanningFixtureTransport("b3-route-pagination"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        first = await adapter.read_reminder_view(view="delivery", limit=20, offset=0)
        second = await adapter.read_reminder_view(view="delivery", limit=20, offset=20)
        await adapter.close()
        return first, second

    first, second = asyncio.run(exercise())
    assert first.count == 20
    assert second.count == 20
    assert first.hasMore is True
    assert {item.id for item in first.items}.isdisjoint({item.id for item in second.items})


def test_reminder_derived_delivery_view_crosses_the_100_row_boundary(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-route-pagination"),
        transport=PlanningFixtureTransport("b3-route-pagination"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )
    reference_client = PlanningClient(
        base_url="http://fixture.test",
        internal_secret="synthetic-internal-secret",
        panel_secret="synthetic-panel-agent-secret",
        transport=PlanningFixtureTransport("b3-route-pagination"),
    )

    async def exercise():
        await adapter.start()
        try:
            upstream_page_0 = await reference_client.reminders(state="due", limit=100, offset=0)
            upstream_page_1 = await reference_client.reminders(state="due", limit=100, offset=100)
            delivery_rank = {"failed": 0, "retrying": 1, "queued": 2}
            expected = sorted(
                [
                    item
                    for item in [*upstream_page_0.items, *upstream_page_1.items]
                    if item.delivery_state in delivery_rank
                ],
                key=lambda item: (delivery_rank[item.delivery_state], item.due_at_utc, item.id),
            )
            pages = {
                offset: await adapter.read_reminder_view(view="delivery", limit=20, offset=offset)
                for offset in range(0, 141, 20)
            }
            return expected, pages
        finally:
            await reference_client.close()
            await adapter.close()

    expected, pages = asyncio.run(exercise())
    expected_keys = [
        (item.id, item.delivery_state, item.due_at_utc)
        for item in expected
    ]
    assert len(expected_keys) == 140
    assert all(item.deliveryState == "failed" for item in pages[20].items)
    for offset in (0, 20, 40, 80, 100, 120):
        actual_keys = [
            (item.id, item.deliveryState, item.dueAtUtc)
            for item in pages[offset].items
        ]
        assert actual_keys == expected_keys[offset : offset + 20]
    concatenated = [
        (item.id, item.deliveryState, item.dueAtUtc)
        for offset in range(0, 140, 20)
        for item in pages[offset].items
    ]
    assert concatenated == expected_keys
    assert len({item[0] for item in concatenated}) == len(concatenated)
    assert pages[140].items == []
    assert pages[120].hasMore is False
    assert pages[140].hasMore is False


def test_reminder_derived_view_fails_closed_when_scan_budget_is_not_enough(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-route-budget"),
        transport=PlanningFixtureTransport("b3-route-budget"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        with pytest.raises(PlanningBoundedScanError, match="reminder_view_scan_budget_exceeded"):
            await adapter.read_reminder_view(view="delivery", limit=20, offset=200)
        await adapter.close()

    asyncio.run(exercise())


def test_reminder_derived_view_maps_budget_failure_to_truthful_http_503(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-route-budget"),
        transport=PlanningFixtureTransport("b3-route-budget"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )
    app = FastAPI()
    app.include_router(build_planning_router(adapter))

    with TestClient(app) as client:
        early_response = client.get(
            "/api/v1/planning/reminders/view?view=delivery&limit=20&offset=0"
        )
        late_response = client.get(
            "/api/v1/planning/reminders/view?view=delivery&limit=20&offset=200"
        )

    for response in (early_response, late_response):
        assert response.status_code == 503
        assert response.json() == {"detail": "reminder_view_scan_budget_exceeded"}


def test_composed_pending_and_due_views_remain_ordered_across_the_scan_boundary(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-composed-route-pagination"),
        transport=PlanningFixtureTransport("b3-composed-route-pagination"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        result = {}
        for view in ("upcoming", "overdue"):
            result[view] = (
                await adapter.read_reminder_view(view=view, limit=20, offset=0),
                await adapter.read_reminder_view(view=view, limit=20, offset=100),
                await adapter.read_reminder_view(view=view, limit=20, offset=220),
                await adapter.read_reminder_view(view=view, limit=20, offset=240),
            )
        await adapter.close()
        return result

    result = asyncio.run(exercise())
    for first, boundary, tail, end in result.values():
        assert first.count == 20
        assert boundary.count == 20
        assert tail.count == 20
        assert end.count == 0
        assert first.hasMore is True
        assert boundary.hasMore is True
        assert tail.hasMore is False
        assert end.hasMore is False
        assert {item.id for item in first.items}.isdisjoint({item.id for item in boundary.items})
        assert {item.id for item in boundary.items}.isdisjoint({item.id for item in tail.items})
        assert [item.dueAtUtc for item in first.items] == sorted(item.dueAtUtc for item in first.items)
        assert [item.dueAtUtc for item in boundary.items] == sorted(item.dueAtUtc for item in boundary.items)


def test_b3_router_is_get_only_and_rejects_unallowlisted_view(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-healthy"),
        transport=PlanningFixtureTransport("b3-healthy"),
    )
    app = FastAPI()
    app.include_router(build_planning_router(adapter))
    with TestClient(app) as client:
        invalid = client.get("/api/v1/planning/reminders/view?view=history")
        write = client.post("/api/v1/planning/reminders/view", json={})
    assert invalid.status_code == 422
    assert write.status_code == 405


def test_b3_fixtures_include_timed_date_only_projects_and_calendar_range_items(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, "b3-healthy"),
        transport=PlanningFixtureTransport("b3-healthy"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        tasks = await adapter.read_tasks(view="today", project_id=None, limit=20, offset=0)
        project_id = next(item.projectId for item in tasks.items if item.projectId is not None)
        filtered_tasks = await adapter.read_tasks(
            view="today", project_id=project_id, limit=20, offset=0
        )
        events = await adapter.read_events(
            from_utc="2026-08-11T21:00:00Z",
            to_utc="2026-08-18T21:00:00Z",
            limit=20,
            offset=0,
        )
        await adapter.close()
        return projection, tasks, project_id, filtered_tasks, events

    projection, tasks, project_id, filtered_tasks, events = asyncio.run(exercise())
    assert projection is not None
    assert any(item.dueTime is None and item.timezone is None for item in tasks.items)
    assert any(item.dueTime is not None and item.timezone == "Europe/Berlin" for item in tasks.items)
    assert any(item.allDay for item in events.items)
    assert any(item.syncState == "local_only" for item in events.items)
    assert len(projection.tasks.projects) == 2
    assert filtered_tasks.items
    assert all(item.projectId == project_id for item in filtered_tasks.items)
