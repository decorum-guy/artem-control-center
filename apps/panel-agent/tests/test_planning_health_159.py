from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone

import httpx
import pytest

from panel_agent.planning import (
    EventListEnvelope,
    PlanningStatusProjection,
    ProjectListEnvelope,
    ReminderListEnvelope,
    StatusEnvelope,
    TaskListEnvelope,
)
from panel_agent.planning_adapter import (
    PlanningAdapter,
    PlanningUpstreamError,
    _provider_health_problem,
    _status_is_degraded,
    _status_operationally_degraded,
    _validate_envelope,
)
from panel_agent.planning_fixtures import fixture_payload
from panel_agent.settings import IntegrationSettings


REFERENCE_TIME = datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc)
REFERENCE_TIME_TEXT = "2026-08-12T09:00:00Z"


def provider_sources(status: str, error_code: str | None) -> list[dict[str, object]]:
    return [
        {
            "sourceType": "native_planning",
            "accountId": "local",
            "provider": "local",
            "status": "current",
            "lastSyncedAt": REFERENCE_TIME_TEXT,
            "observedAt": REFERENCE_TIME_TEXT,
            "errorCode": None,
            "calendars": [],
        },
        {
            "sourceType": "external_calendar",
            "accountId": "account_opaque",
            "provider": "icloud",
            "status": status,
            "lastSyncedAt": REFERENCE_TIME_TEXT,
            "observedAt": REFERENCE_TIME_TEXT,
            "errorCode": error_code,
            "calendars": [
                {
                    "calendarId": "icloud-work",
                    "displayName": "Work",
                    "color": "#4477AA",
                    "enabled": True,
                    "status": status,
                    "lastSyncedAt": REFERENCE_TIME_TEXT,
                    "observedAt": REFERENCE_TIME_TEXT,
                    "errorCode": error_code,
                }
            ],
        },
    ]


def settings(tmp_path, **overrides) -> IntegrationSettings:
    values = {
        "panel_planning_enabled": True,
        "panel_planning_base_url": "http://fixture.test",
        "panel_planning_internal_secret": "internal",
        "panel_planning_secret": "planning",
        "panel_planning_refresh_seconds": 10,
        "panel_planning_status_refresh_seconds": 300,
        "panel_planning_stale_after_seconds": 90,
        "panel_planning_unavailable_after_seconds": 300,
        "panel_planning_max_backoff_seconds": 60,
        "panel_planning_cache_path": str(tmp_path / "planning-cache.json"),
        "panel_planning_timezone": "Europe/Moscow",
    }
    values.update(overrides)
    return IntegrationSettings(**values)


class SelectiveRefreshClient:
    """Fixed-route fixture client with deterministic per-domain failures."""

    def __init__(self) -> None:
        self.failures: set[str] = set()
        self.status_degraded = False
        self.status_calls = 0
        self.provider_status = "not_configured"
        self.provider_error_code: str | None = None
        self.health_overrides: dict[str, object] = {}
        self.sources: list[dict[str, object]] | None = None

    def _list(self, path: str, model, domain: str, values: dict[str, object]):
        if domain in self.failures:
            raise PlanningUpstreamError(f"synthetic_{domain}_failure")
        payload = copy.deepcopy(fixture_payload(path=path, scenario="healthy", query=httpx.QueryParams({
            key: str(value) for key, value in values.items() if value is not None
        })))
        assert payload is not None
        if self.sources is not None:
            payload["sources"] = copy.deepcopy(self.sources)
        return _validate_envelope(model, payload)

    async def reminders(self, **values):
        return self._list("/internal/planning/v1/reminders", ReminderListEnvelope, "reminders", values)

    async def tasks(self, **values):
        return self._list("/internal/planning/v1/tasks", TaskListEnvelope, "tasks", values)

    async def events(self, **values):
        return self._list("/internal/planning/v1/events", EventListEnvelope, "calendar", values)

    async def projects(self, **values):
        return self._list("/internal/planning/v1/projects", ProjectListEnvelope, "projects", values)

    async def status(self):
        self.status_calls += 1
        scenario = "degraded" if self.status_degraded else "healthy"
        payload = copy.deepcopy(fixture_payload(
            path="/internal/planning/v1/status",
            scenario=scenario,
        ))
        assert payload is not None
        health = payload["planningHealth"]
        assert isinstance(health, dict)
        health.update(
            {
                "providerStatus": self.provider_status,
                "providerLastSyncAt": REFERENCE_TIME.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "providerErrorCode": self.provider_error_code,
                **self.health_overrides,
            }
        )
        if self.sources is not None:
            payload["sources"] = copy.deepcopy(self.sources)
        return _validate_envelope(StatusEnvelope, payload)

    async def close(self):
        return None


def make_adapter(tmp_path, client: SelectiveRefreshClient, monotonic: list[float], **settings_overrides) -> PlanningAdapter:
    return PlanningAdapter(
        settings(tmp_path, **settings_overrides),
        client=client,
        monotonic_clock=lambda: monotonic[0],
        wall_clock=lambda: REFERENCE_TIME,
    )


def test_provider_freshness_is_separate_from_operational_planning_health(tmp_path):
    async def projection_for(provider_status: str, provider_error_code: str | None):
        client = SelectiveRefreshClient()
        client.provider_status = provider_status
        client.provider_error_code = provider_error_code
        client.sources = provider_sources(provider_status, provider_error_code)
        adapter = make_adapter(tmp_path, client, [0.0])
        await adapter.start()
        projection = adapter.projection
        status = adapter._last_status
        await adapter.close()
        return projection, status

    current, current_status = asyncio.run(projection_for("current", "provider_connection_reset"))
    assert current is not None and current_status is not None
    assert current.sourceStatus == "current"
    assert not _provider_health_problem(current_status)
    assert not _status_is_degraded(current_status)
    assert all(issue.source != "planning-status" for issue in current.health.issues)
    current_icloud = next(source for source in current.providerStatuses if source.provider == "icloud")
    assert current_icloud.status == "current"
    assert current_icloud.errorCode == "provider_connection_reset"
    assert current_icloud.calendars[0].errorCode == "provider_connection_reset"

    for provider_status, provider_error_code in (
        ("stale", "provider_connection_timeout"),
        ("error", "provider_authentication_failed"),
    ):
        projection, status = asyncio.run(projection_for(provider_status, provider_error_code))
        assert projection is not None and status is not None
        assert projection.sourceStatus == "degraded"
        assert _provider_health_problem(status)
        assert _status_is_degraded(status)
        assert all(issue.source != "planning-status" for issue in projection.health.issues)
        icloud = next(source for source in projection.providerStatuses if source.provider == "icloud")
        assert icloud.status == provider_status
        assert icloud.errorCode == provider_error_code

    for provider_status in ("disabled", "not_configured"):
        projection, status = asyncio.run(projection_for(provider_status, None))
        assert projection is not None and status is not None
        assert projection.sourceStatus == "current"
        assert not _provider_health_problem(status)
        assert not _status_is_degraded(status)


@pytest.mark.parametrize(
    ("old_status", "old_error_code", "fresh_status", "fresh_error_code", "expected_status"),
    [
        ("current", None, "stale", "provider_connection_timeout", "degraded"),
        ("current", None, "error", "provider_authentication_failed", "degraded"),
        ("current", None, "current", "provider_connection_reset", "current"),
        ("stale", "provider_connection_timeout", "current", None, "current"),
        ("error", "provider_authentication_failed", "current", None, "current"),
        ("current", None, "disabled", None, "current"),
        ("current", None, "not_configured", None, "current"),
    ],
    ids=(
        "fresh-stale-overrides-current-status",
        "fresh-error-overrides-current-status",
        "fresh-current-with-error-remains-current",
        "fresh-current-recovers-old-stale-status",
        "fresh-current-recovers-old-error-status",
        "fresh-disabled-does-not-degrade",
        "fresh-not-configured-does-not-degrade",
    ),
)
def test_fresh_domain_provider_metadata_has_precedence_over_slow_status(
    tmp_path,
    old_status: str,
    old_error_code: str | None,
    fresh_status: str,
    fresh_error_code: str | None,
    expected_status: str,
):
    client = SelectiveRefreshClient()
    client.provider_status = old_status
    client.provider_error_code = old_error_code
    client.sources = provider_sources(old_status, old_error_code)
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.sources = provider_sources(fresh_status, fresh_error_code)
        monotonic[0] = 1.0
        assert await adapter.refresh_domains() is True
        projection = adapter.projection
        status = adapter._last_status
        await adapter.close()
        return projection, status

    projection, status = asyncio.run(exercise())
    assert projection is not None and status is not None
    assert projection.sourceStatus == expected_status
    assert status.planningHealth is not None
    assert status.planningHealth.providerStatus == old_status
    icloud = next(source for source in projection.providerStatuses if source.provider == "icloud")
    assert icloud.status == fresh_status
    assert icloud.errorCode == fresh_error_code
    assert all(issue.source != "planning-status" for issue in projection.health.issues)


def test_partial_domain_retry_uses_fresh_stale_provider_metadata(tmp_path):
    client = SelectiveRefreshClient()
    client.provider_status = "current"
    client.sources = provider_sources("current", None)
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.sources = provider_sources("stale", "provider_dns_failed")
        client.failures = {"tasks"}
        monotonic[0] = 1.0
        assert await adapter.refresh_domains() is False
        projection = adapter.projection
        await adapter.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection is not None
    assert projection.sourceStatus == "degraded"
    assert next(domain for domain in projection.health.domains if domain.domain == "tasks").status == "retrying"
    icloud = next(source for source in projection.providerStatuses if source.provider == "icloud")
    assert (icloud.status, icloud.errorCode) == ("stale", "provider_dns_failed")
    assert all(issue.source != "planning-status" for issue in projection.health.issues)


def test_domain_stale_and_offline_remain_more_severe_than_provider_degradation(tmp_path):
    client = SelectiveRefreshClient()
    client.provider_status = "current"
    client.sources = provider_sources("current", None)
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.sources = provider_sources("stale", "provider_connection_timeout")
        client.failures = {"tasks"}
        monotonic[0] = 91.0
        assert await adapter.refresh_domains() is False
        stale = adapter.projection
        monotonic[0] = 301.0
        assert await adapter.refresh_domains() is False
        offline = adapter.projection
        await adapter.close()
        return stale, offline

    stale, offline = asyncio.run(exercise())
    assert stale is not None and offline is not None
    assert stale.sourceStatus == "stale"
    assert offline.sourceStatus == "offline"


def test_operational_health_remains_degraded_independently_of_provider(tmp_path):
    client = SelectiveRefreshClient()
    client.provider_status = "current"
    client.provider_error_code = "provider_dns_failed"
    client.health_overrides = {"dbAvailable": False}
    adapter = make_adapter(tmp_path, client, [0.0])

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        status = adapter._last_status
        await adapter.close()
        return projection, status

    projection, status = asyncio.run(exercise())
    assert projection is not None and status is not None
    assert _status_operationally_degraded(status)
    assert projection.sourceStatus == "degraded"
    assert any(issue.source == "planning-status" for issue in projection.health.issues)


def test_current_provider_attempt_error_does_not_close_native_task_mutation_gate(tmp_path):
    client = SelectiveRefreshClient()
    client.provider_status = "current"
    client.provider_error_code = "provider_connection_reset"
    adapter = make_adapter(
        tmp_path,
        client,
        [0.0],
        panel_planning_task_mutations_enabled=True,
    )

    async def exercise():
        await adapter.start()
        allowed = adapter.task_mutation_allowed("create")
        await adapter.close()
        return allowed

    assert asyncio.run(exercise()) is True


def test_single_transient_domain_failure_recovers_without_owner_incident(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.failures = {"tasks"}
        monotonic[0] = 1
        assert await adapter.refresh_domains() is False
        transient = adapter.projection
        client.failures.clear()
        monotonic[0] = 2
        assert await adapter.refresh_domains() is True
        recovered = adapter.projection
        await adapter.close()
        return transient, recovered

    transient, recovered = asyncio.run(exercise())
    assert transient is not None and recovered is not None
    assert transient.sourceStatus == "current"
    assert transient.health.domains[1].domain == "tasks"
    assert transient.health.domains[1].status == "retrying"
    assert transient.health.issues[0].source == "tasks"
    assert transient.health.issues[0].consecutiveFailures == 1
    assert all(source.status == "current" for source in transient.providerStatuses)
    assert recovered.sourceStatus == "current"
    assert recovered.health.issues == []
    assert all(domain.status == "current" for domain in recovered.health.domains)


def test_repeated_failures_become_degraded_before_unavailable(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.failures = {"tasks"}
        monotonic[0] = 1
        await adapter.refresh_domains()
        monotonic[0] = 2
        await adapter.refresh_domains()
        degraded = adapter.projection
        client.failures.clear()
        monotonic[0] = 3
        await adapter.refresh_domains()
        recovered = adapter.projection
        await adapter.close()
        return degraded, recovered

    degraded, recovered = asyncio.run(exercise())
    assert degraded is not None and recovered is not None
    assert degraded.sourceStatus == "degraded"
    task_issue = next(issue for issue in degraded.health.issues if issue.source == "tasks")
    assert task_issue.status == "degraded"
    assert task_issue.consecutiveFailures == 2
    assert degraded.health.domains[2].status == "current"
    assert degraded.calendar.today
    assert recovered.sourceStatus == "current"
    assert recovered.health.issues == []


def test_data_age_crosses_stale_then_unavailable_boundaries(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.failures = {"tasks"}
        monotonic[0] = 91
        await adapter.refresh_domains()
        stale = adapter.projection
        monotonic[0] = 301
        await adapter.refresh_domains()
        offline = adapter.projection
        await adapter.close()
        return stale, offline

    stale, offline = asyncio.run(exercise())
    assert stale is not None and offline is not None
    assert stale.sourceStatus == "stale"
    assert next(issue for issue in stale.health.issues if issue.source == "tasks").status == "stale"
    assert offline.sourceStatus == "offline"
    assert next(issue for issue in offline.health.issues if issue.source == "tasks").status == "unavailable"


def test_recovery_confirms_status_before_slow_cadence_can_latch_degraded(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        client.status_degraded = True
        await adapter.start()
        assert adapter.projection.sourceStatus == "degraded"
        client.status_degraded = False
        client.failures = {"tasks"}
        monotonic[0] = 1
        await adapter.refresh_domains()
        client.failures.clear()
        monotonic[0] = 2
        await adapter.refresh_domains()
        recovered = adapter.projection
        await adapter.close()
        return recovered

    recovered = asyncio.run(exercise())
    assert recovered is not None
    assert client.status_calls == 2
    assert recovered.sourceStatus == "current"
    assert recovered.health.issues == []


def test_partial_failure_keeps_calendar_current_and_attributes_failed_domain(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.failures = {"tasks"}
        monotonic[0] = 1
        await adapter.refresh_domains()
        partial = adapter.projection
        await adapter.close()
        return partial

    partial = asyncio.run(exercise())
    assert partial is not None
    assert partial.sourceStatus == "current"
    assert partial.calendar.today
    assert partial.health.domains[1].status == "retrying"
    assert partial.health.domains[2].status == "current"
    assert [issue.source for issue in partial.health.issues] == ["tasks"]


def test_temporary_full_disconnect_does_not_poison_last_good_projection(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise():
        await adapter.start()
        client.failures = {"reminders", "tasks", "calendar", "projects"}
        monotonic[0] = 1
        await adapter.refresh_domains()
        disconnected = adapter.projection
        client.failures.clear()
        monotonic[0] = 2
        await adapter.refresh_domains()
        recovered = adapter.projection
        await adapter.close()
        return disconnected, recovered

    disconnected, recovered = asyncio.run(exercise())
    assert disconnected is not None and recovered is not None
    assert disconnected.sourceStatus == "current"
    assert all(domain.status == "retrying" for domain in disconnected.health.domains)
    assert disconnected.calendar.today
    assert recovered.sourceStatus == "current"
    assert recovered.health.issues == []


def test_status_projection_carries_server_owned_health_without_private_fields(tmp_path):
    client = SelectiveRefreshClient()
    monotonic = [0.0]
    adapter = make_adapter(tmp_path, client, monotonic)

    async def exercise() -> PlanningStatusProjection:
        await adapter.start()
        client.failures = {"reminders"}
        monotonic[0] = 1
        await adapter.refresh_domains()
        status = adapter.read_status()
        await adapter.close()
        return status

    status = asyncio.run(exercise())
    assert status.health.issues[0].source == "reminders"
    serialized = status.model_dump_json()
    assert "internal" not in serialized
    assert "sourceType" not in serialized
