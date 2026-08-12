from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.planning_adapter import PlanningAdapter
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
