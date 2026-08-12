from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
import httpx

from panel_agent.planning_adapter import PlanningAdapter
from panel_agent.planning_fixtures import PlanningFixtureTransport, fixture_payload
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


@pytest.mark.parametrize(
    "scenario",
    [
        "overview-healthy",
        "overview-empty",
        "overview-reminder-soon",
        "overview-task-priorities",
        "overview-timed-event",
        "overview-all-day-event",
        "overview-degraded",
        "overview-delivery-failure",
        "overview-delivered-open",
        "overview-long-russian",
        "overview-bounded-20",
    ],
)
def test_b2_fixture_scenarios_build_through_the_normal_projection(tmp_path, scenario):
    adapter = PlanningAdapter(
        settings(tmp_path, scenario),
        transport=PlanningFixtureTransport(scenario),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        await adapter.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection is not None
    assert projection.schemaVersion == "planning.panel.v1"
    assert projection.capabilities.complete is False

    if scenario == "overview-empty":
        assert projection.reminders.upcoming == []
        assert projection.tasks.overdue == []
        assert projection.calendar.today == []
    if scenario == "overview-reminder-soon":
        assert projection.reminders.upcoming[0].dueAtUtc == "2026-08-12T09:40:00Z"
    if scenario == "overview-task-priorities":
        assert [item.priority for item in projection.tasks.overdue] == ["high", "normal", "low", "none"]
    if scenario == "overview-timed-event":
        assert projection.calendar.today[0].allDay is False
    if scenario == "overview-all-day-event":
        assert projection.calendar.today[0].allDay is True
    if scenario == "overview-degraded":
        assert projection.sourceStatus == "degraded"
    if scenario == "overview-delivery-failure":
        assert projection.reminders.deliveryFailures[0].deliveryState == "failed"
        assert projection.reminders.upcoming[0].deliveryState != "failed"
    if scenario == "overview-delivered-open":
        assert projection.reminders.upcoming[0].deliveryState == "delivered"
    if scenario == "overview-long-russian":
        assert "https://example.com" in projection.tasks.overdue[0].title
        assert "бухгалтерию" in projection.reminders.upcoming[0].title
    if scenario == "overview-bounded-20":
        assert len(projection.tasks.overdue) == 20


def test_b2_fixture_payloads_remain_fixed_route_and_safe_text():
    payload = fixture_payload(
        "overview-long-russian",
        "/internal/planning/v1/tasks",
        httpx.QueryParams({"view": "overdue"}),
    )
    assert payload is not None
    assert payload["domain"] == "task"
    assert "light.turn_on" in payload["items"][0]["title"]
    assert "/etc/passwd" in payload["items"][0]["title"]
