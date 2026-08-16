from __future__ import annotations

import copy
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
