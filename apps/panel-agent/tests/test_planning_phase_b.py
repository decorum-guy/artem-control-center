from __future__ import annotations

import copy
import asyncio
import json

import pytest

from panel_agent.planning import (
    EventListEnvelope,
    EventObjectEnvelope,
    PlanningListEnvelope,
    StatusEnvelope,
    TaskListEnvelope,
    TaskObjectEnvelope,
    ReminderListEnvelope,
    ReminderObjectEnvelope,
    ProjectListEnvelope,
    UpstreamCalendarEvent,
    UpstreamPlanningSource,
    empty_planning_projection,
)
from panel_agent.planning_adapter import (
    PlanningAdapter,
    PlanningReadUnavailable,
    _validate_envelope,
)
from panel_agent.planning_fixtures import FIXTURE_STALE_AFTER, FIXTURE_TIMESTAMP, fixture_payload
from panel_agent.settings import IntegrationSettings


def _sources() -> list[dict[str, object]]:
    return [
        {
            "sourceType": "native_planning",
            "accountId": "local",
            "provider": "local",
            "status": "current",
            "lastSyncedAt": FIXTURE_TIMESTAMP,
            "observedAt": FIXTURE_TIMESTAMP,
            "errorCode": None,
            "calendars": [],
        },
        {
            "sourceType": "external_calendar",
            "accountId": "account_opaque",
            "provider": "icloud",
            "status": "stale",
            "lastSyncedAt": FIXTURE_TIMESTAMP,
            "observedAt": FIXTURE_TIMESTAMP,
            "errorCode": "provider_timeout",
            "calendars": [
                {
                    "calendarId": "icloud-work",
                    "displayName": "<script>alert(1)</script>",
                    "color": None,
                    "enabled": True,
                    "status": "stale",
                    "lastSyncedAt": FIXTURE_TIMESTAMP,
                    "observedAt": FIXTURE_TIMESTAMP,
                    "errorCode": "provider_timeout",
                },
                {
                    "calendarId": "icloud-home",
                    "displayName": "<script>alert(1)</script>",
                    "color": "#4477AA",
                    "enabled": True,
                    "status": "stale",
                    "lastSyncedAt": FIXTURE_TIMESTAMP,
                    "observedAt": FIXTURE_TIMESTAMP,
                    "errorCode": "provider_timeout",
                },
            ],
        },
    ]


def _settings(tmp_path) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="internal",
        panel_planning_secret="planning",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
    )


def _payload(path: str, *, sources: bool = True) -> dict[str, object]:
    payload = copy.deepcopy(fixture_payload("healthy", path))
    assert payload is not None
    if sources:
        payload["sources"] = _sources()
    return payload


def _source_batch(*, native_status: str = "current", external_status: str = "current") -> list[dict[str, object]]:
    sources = copy.deepcopy(_sources())
    sources[0]["status"] = native_status
    sources[1]["status"] = external_status
    sources[1]["errorCode"] = None if external_status == "current" else "provider_timeout"
    for calendar in sources[1]["calendars"]:
        calendar["status"] = external_status
        calendar["errorCode"] = None if external_status == "current" else "provider_timeout"
    return sources


class _RefreshClient:
    """Small fixed-route client double for exercising adapter refresh semantics."""

    def __init__(
        self,
        *,
        sources: list[dict[str, object]] | None,
        include_sources: bool = True,
        failures: set[str] | None = None,
    ) -> None:
        self.sources = copy.deepcopy(sources) if sources is not None else None
        self.include_sources = include_sources
        self.failures = set(failures or ())

    def _list(self, path: str, model, domain: str):
        if domain in self.failures:
            raise RuntimeError(f"synthetic {domain} failure")
        payload = copy.deepcopy(fixture_payload("healthy", path))
        assert payload is not None
        if self.include_sources and self.sources is not None:
            payload["sources"] = copy.deepcopy(self.sources)
        return _validate_envelope(model, payload)

    async def reminders(self, **_kwargs):
        return self._list("/internal/planning/v1/reminders", ReminderListEnvelope, "reminders")

    async def tasks(self, **_kwargs):
        return self._list("/internal/planning/v1/tasks", TaskListEnvelope, "tasks")

    async def events(self, **_kwargs):
        return self._list("/internal/planning/v1/events", EventListEnvelope, "events")

    async def projects(self, **_kwargs):
        return self._list("/internal/planning/v1/projects", ProjectListEnvelope, "projects")

    async def close(self):
        return None


def test_old_and_new_alice_sources_are_strictly_accepted_across_list_status_and_objects():
    models = {
        "/internal/planning/v1/reminders": ReminderListEnvelope,
        "/internal/planning/v1/tasks": TaskListEnvelope,
        "/internal/planning/v1/events": EventListEnvelope,
        "/internal/planning/v1/projects": ProjectListEnvelope,
    }
    for path, model in models.items():
        _validate_envelope(model, _payload(path))
        _validate_envelope(model, _payload(path, sources=False))

    _validate_envelope(StatusEnvelope, _payload("/internal/planning/v1/status"))
    reminder = _payload("/internal/planning/v1/reminders")["items"][0]
    task = _payload("/internal/planning/v1/tasks")["items"][0]
    event = _payload("/internal/planning/v1/events")["items"][0]
    for model, domain, item in [
        (ReminderObjectEnvelope, "reminder", reminder),
        (TaskObjectEnvelope, "task", task),
        (EventObjectEnvelope, "calendar_event", event),
    ]:
        object_payload = {
            "schemaVersion": "planning.v1",
            "kind": "object",
            "domain": domain,
            "object": item,
            "sourceStatus": "current",
            "lastSyncedAt": FIXTURE_TIMESTAMP,
            "staleAfter": FIXTURE_STALE_AFTER,
            "sources": _sources(),
            "correlation_id": "00000000-0000-4000-8000-000000000099",
        }
        _validate_envelope(model, object_payload)
        object_payload.pop("sources")
        _validate_envelope(model, object_payload)


@pytest.mark.parametrize(
    "mutator",
    [
        lambda source: {**source, "sourceType": "unknown"},
        lambda source: {**source, "status": "offline"},
        lambda source: {**source, "observedAt": "2026-08-12T12:00:00+03:00"},
        lambda source: {**source, "href": "https://private.example"},
    ],
)
def test_source_contract_rejects_bad_type_status_timestamp_and_unknown_fields(mutator):
    bad = _sources()
    bad[1] = mutator(bad[1])
    with pytest.raises(Exception):
        UpstreamPlanningSource.model_validate(bad[1])


def test_source_contract_bounds_source_and_calendar_count():
    source = _sources()[1]
    with pytest.raises(Exception):
        UpstreamPlanningSource.model_validate({**source, "calendars": source["calendars"] * 17})
    with pytest.raises(Exception):
        # The envelope limit is independent from Alice's own calendar cap.
        _validate_envelope(
            StatusEnvelope,
            {**_payload("/internal/planning/v1/status"), "sources": _sources() * 3},
        )


def test_canonical_event_join_is_safe_and_same_name_calendars_remain_distinct(tmp_path):
    adapter = PlanningAdapter(_settings(tmp_path))
    upstream_sources = [UpstreamPlanningSource.model_validate(source) for source in _sources()]
    projected = adapter._project_sources(upstream_sources)
    external = projected[1]
    assert len({calendar.id for calendar in external.calendars}) == 2
    assert len({calendar.label for calendar in external.calendars}) == 2
    assert all(calendar.label.startswith("<script>alert(1)</script> · #") for calendar in external.calendars)
    assert external.calendars[1].color == "#4477AA"

    event_payload = copy.deepcopy(_payload("/internal/planning/v1/events")["items"][0])
    event_payload.update(
        {
            "source": "calendar-provider",
            "sync_state": "synced",
            "provider_id": "provider_opaque",
            "provider_calendar_id": "icloud-work",
            "title": "<img src=x onerror=alert(1)>",
        }
    )
    event = UpstreamCalendarEvent.model_validate(event_payload)
    identity = adapter._event_identity(event, upstream_sources)
    assert identity.providerLabel == "iCloud"
    assert identity.calendarLabel.endswith("#" + external.calendars[0].id[-6:])
    assert "icloud-work" not in identity.calendarId
    assert "account_opaque" not in json.dumps([source.model_dump() for source in projected])

    with pytest.raises(PlanningReadUnavailable, match="planning_calendar_identity_unmapped"):
        adapter._event_identity(
            event.model_copy(update={"provider_calendar_id": "not-known"}),
            upstream_sources,
        )


def test_external_freshness_does_not_replace_global_planning_status(tmp_path):
    adapter = PlanningAdapter(_settings(tmp_path))
    projected = adapter._project_sources([UpstreamPlanningSource.model_validate(source) for source in _sources()])
    projection = empty_planning_projection(
        generated_at=FIXTURE_TIMESTAMP,
        source_status="current",
    ).model_copy(update={"providerStatuses": projected}, deep=True)
    assert projection.sourceStatus == "current"
    assert projection.providerStatuses[1].status == "stale"


def test_partial_refresh_uses_fresh_sources_even_when_reminders_fail(tmp_path):
    client = _RefreshClient(sources=_source_batch(), failures={"reminders"})
    adapter = PlanningAdapter(_settings(tmp_path), client=client)

    async def exercise():
        result = await adapter.refresh_domains()
        projection = adapter.projection
        await adapter.close()
        return result, projection

    result, projection = asyncio.run(exercise())
    assert result is False
    assert projection is not None
    assert projection.sourceStatus == "offline"
    assert projection.health.issues[0].source == "reminders"
    assert {source.provider: source.status for source in projection.providerStatuses} == {
        "local": "current",
        "icloud": "current",
    }


def test_partial_refresh_preserves_fresh_native_and_stale_icloud_sources(tmp_path):
    client = _RefreshClient(
        sources=_source_batch(external_status="stale"),
        failures={"reminders"},
    )
    adapter = PlanningAdapter(_settings(tmp_path), client=client)

    async def exercise():
        result = await adapter.refresh_domains()
        projection = adapter.projection
        await adapter.close()
        return result, projection

    result, projection = asyncio.run(exercise())
    assert result is False
    assert projection is not None
    assert {source.provider: source.status for source in projection.providerStatuses} == {
        "local": "current",
        "icloud": "stale",
    }


def test_total_failure_degrades_cached_sources_and_successful_refresh_recovers(tmp_path):
    client = _RefreshClient(sources=_source_batch())
    adapter = PlanningAdapter(_settings(tmp_path), client=client)

    async def exercise():
        assert await adapter.refresh_domains() is True
        first = adapter.projection
        client.failures = {"reminders", "tasks", "events", "projects"}
        assert await adapter.refresh_domains() is False
        failed = adapter.projection
        client.failures.clear()
        client.sources = _source_batch()
        assert await adapter.refresh_domains() is True
        recovered = adapter.projection
        await adapter.close()
        return first, failed, recovered

    first, failed, recovered = asyncio.run(exercise())
    assert first is not None and failed is not None and recovered is not None
    assert failed.sourceStatus == "current"
    assert failed.tasks.today
    assert failed.calendar.today
    assert all(source.status == "current" for source in failed.providerStatuses)
    assert any(issue.source == "tasks" for issue in failed.health.issues)
    assert {source.provider: source.status for source in recovered.providerStatuses} == {
        "local": "current",
        "icloud": "current",
    }


def test_old_alice_partial_refresh_degrades_previous_sources_without_fabricating_new_state(tmp_path):
    client = _RefreshClient(sources=_source_batch())
    adapter = PlanningAdapter(_settings(tmp_path), client=client)

    async def exercise():
        assert await adapter.refresh_domains() is True
        client.include_sources = False
        client.failures = {"reminders"}
        result = await adapter.refresh_domains()
        projection = adapter.projection
        await adapter.close()
        return result, projection

    result, projection = asyncio.run(exercise())
    assert result is False
    assert projection is not None
    assert projection.calendar.today
    assert all(source.status == "current" for source in projection.providerStatuses)
    assert any(issue.source == "reminders" for issue in projection.health.issues)


def test_disabled_not_configured_sentinel_is_not_browser_configured(tmp_path):
    source = copy.deepcopy(_sources()[1])
    source["accountId"] = "not-configured"
    source["status"] = "disabled"
    projected = PlanningAdapter(_settings(tmp_path))._project_sources([
        UpstreamPlanningSource.model_validate(source)
    ])
    serialized = json.dumps([item.model_dump() for item in projected])
    assert projected[0].configured is False
    assert "accountId" not in serialized
    assert "not-configured" not in serialized


def test_disabled_real_account_remains_configured_without_leaking_identity(tmp_path):
    source = copy.deepcopy(_sources()[1])
    source["accountId"] = "opaque-configured-account"
    source["status"] = "disabled"
    projected = PlanningAdapter(_settings(tmp_path))._project_sources([
        UpstreamPlanningSource.model_validate(source)
    ])
    serialized = json.dumps([item.model_dump() for item in projected])
    assert projected[0].configured is True
    assert "opaque-configured-account" not in serialized
    assert "accountId" not in serialized
