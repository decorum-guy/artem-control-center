from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.planning_adapter import PlanningAdapter, PlanningBoundedScanError
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

    async def exercise():
        await adapter.start()
        first = await adapter.read_reminder_view(view="delivery", limit=100, offset=0)
        after_100 = await adapter.read_reminder_view(view="delivery", limit=100, offset=100)
        boundary = await adapter.read_reminder_view(view="delivery", limit=20, offset=100)
        page_after_boundary = await adapter.read_reminder_view(view="delivery", limit=20, offset=120)
        end = await adapter.read_reminder_view(view="delivery", limit=20, offset=140)
        page_80 = await adapter.read_reminder_view(view="delivery", limit=20, offset=80)
        await adapter.close()
        return first, after_100, boundary, page_after_boundary, end, page_80

    first, after_100, boundary, page_after_boundary, end, page_80 = asyncio.run(exercise())
    first_ids = [item.id for item in first.items]
    boundary_ids = [item.id for item in boundary.items]
    page_after_boundary_ids = [item.id for item in page_after_boundary.items]
    assert first.count == 100
    assert first.hasMore is True
    assert boundary.count == 20
    assert page_after_boundary.count == 20
    assert end.count == 0
    assert end.hasMore is False
    assert {item.id for item in page_80.items}.isdisjoint(set(boundary_ids))
    assert set(boundary_ids).isdisjoint(set(page_after_boundary_ids))
    assert boundary_ids == [item.id for item in after_100.items[:20]]
    assert page_after_boundary_ids == [item.id for item in after_100.items[20:40]]
    assert page_80.items == first.items[80:100]
    assert page_after_boundary.hasMore is False

    delivery_rank = {"failed": 0, "retrying": 1, "queued": 2}
    ordered = first.items + list(after_100.items)
    keys = [
        (delivery_rank[item.deliveryState], item.dueAtUtc, item.id)
        for item in ordered
    ]
    assert keys == sorted(keys)


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
        response = client.get(
            "/api/v1/planning/reminders/view?view=delivery&limit=20&offset=200"
        )

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
