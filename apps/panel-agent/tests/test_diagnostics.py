import json

from fastapi import FastAPI
from starlette.testclient import TestClient

from panel_agent.diagnostics import DiagnosticsCollector
from panel_agent.fixtures import services_for_scenario
from panel_agent.planning import PlanningReadEnvelope, empty_planning_projection
from panel_agent.planning_api import build_planning_router
from panel_agent.settings import IntegrationSettings
from panel_agent.contracts import DashboardSnapshot


def make_snapshot(services=None, *, planning=None, revision=1):
    return DashboardSnapshot(
        revision=revision,
        generatedAt=f"2026-08-25T12:00:{revision % 60:02d}+00:00",
        mode="fixtures",
        fixtureScenario=None,
        services=list(services or []),
        planning=planning,
    )


def healthy_services():
    return [
        service
        for service in services_for_scenario("ha-healthy")
        if service.id != "fixture-multi-action"
    ]


def test_healthy_snapshot_has_zero_current_problems():
    report = DiagnosticsCollector(IntegrationSettings()).report(make_snapshot(healthy_services()))

    assert report.schemaVersion == "diagnostics.v1"
    assert report.problems == []
    assert report.calendar.resultStatus == "unavailable"
    assert report.mutationGates.planningCalendarMutationsEnabled is False


def test_unhealthy_service_becomes_a_concrete_problem_without_raw_summary():
    services = healthy_services()
    services[0].health = "offline"
    services[0].summary = "PRIVATE_EVENT_TITLE_CANARY"

    report = DiagnosticsCollector(IntegrationSettings()).report(make_snapshot(services))

    assert len(report.problems) == 1
    assert report.problems[0].id == f"service:{services[0].id}"
    assert report.problems[0].state == "offline"
    assert report.problems[0].summary != "PRIVATE_EVENT_TITLE_CANARY"


def test_recovered_transition_is_retained_but_not_counted_as_current():
    services = healthy_services()
    services[0].health = "offline"
    collector = DiagnosticsCollector(IntegrationSettings())
    collector.observe(make_snapshot(services, revision=1))
    services[0].health = "healthy"

    report = collector.report(make_snapshot(services, revision=2))

    assert report.problems == []
    assert any(
        transition.toState == "recovered" and not transition.current
        for transition in report.recentTransitions
    )


def test_stale_planning_and_provider_error_are_truthful_and_distinguishable():
    stale = empty_planning_projection(
        generated_at="2026-08-25T12:00:00Z",
        source_status="stale",
        last_synced_at="2026-08-25T11:00:00Z",
    )
    stale_report = DiagnosticsCollector(IntegrationSettings()).report(
        make_snapshot(healthy_services(), planning=stale)
    )
    assert {problem.state for problem in stale_report.problems} == {"stale"}
    assert stale_report.calendar.resultStatus == "degraded"
    assert stale_report.calendar.cacheUsed is True

    error = empty_planning_projection(
        generated_at="2026-08-25T12:00:00Z",
        source_status="current",
        provider_status="error",
    )
    error_report = DiagnosticsCollector(IntegrationSettings()).report(
        make_snapshot(healthy_services(), planning=error)
    )
    assert any(problem.id.startswith("calendar-provider:") for problem in error_report.problems)
    assert error_report.calendar.resultStatus == "error"


def test_calendar_empty_result_is_not_reported_as_error():
    planning = empty_planning_projection(
        generated_at="2026-08-25T12:00:00Z",
        source_status="current",
    )
    report = DiagnosticsCollector(IntegrationSettings()).report(
        make_snapshot(healthy_services(), planning=planning)
    )

    assert report.calendar.resultStatus == "success_empty"
    assert report.calendar.itemCount == 0
    assert report.calendar.sourceCount == 0
    assert report.calendar.calendarCount == 0


def test_calendar_scope_is_projection_until_a_real_range_read_is_observed():
    planning = empty_planning_projection(
        generated_at="2026-08-25T00:00:00Z",
        source_status="current",
    )
    collector = DiagnosticsCollector(IntegrationSettings())
    projection = collector.report(make_snapshot(healthy_services(), planning=planning))

    assert projection.calendar.scopeType == "PROJECTION_SCOPE"
    assert projection.calendar.fromDate == "unknown"
    assert projection.calendar.toDate == "unknown"
    assert projection.calendar.requestFromUtc is None
    assert projection.calendar.projectionScope == "planning_snapshot_calendar_today_upcoming"

    collector.observe_calendar_read(
        from_utc="2026-08-24T23:30:00Z",
        to_utc="2026-08-25T23:30:00Z",
        view="today",
        item_count=0,
        source_status="current",
        providers=planning.providerStatuses,
        observed_at="2026-08-24T23:30:01Z",
    )
    actual = collector.report(make_snapshot(healthy_services(), planning=planning, revision=2))

    assert actual.calendar.scopeType == "ACTUAL_REQUEST_RANGE"
    assert actual.calendar.requestFromUtc == "2026-08-24T23:30:00+00:00"
    assert actual.calendar.requestToUtc == "2026-08-25T23:30:00+00:00"
    assert actual.calendar.fromDate == "2026-08-25"
    assert actual.calendar.toDate == "2026-08-26"
    assert actual.calendar.fromDate != "2026-08-24"
    assert actual.calendar.view == "today"
    assert actual.calendar.resultStatus == "success_empty"
    assert len(actual.calendarReads) == 1


def test_calendar_failed_read_is_distinct_from_legitimate_empty_read():
    collector = DiagnosticsCollector(IntegrationSettings())
    collector.observe_calendar_read(
        from_utc="2026-08-25T00:00:00Z",
        to_utc="2026-08-26T00:00:00Z",
        view="today",
        result_status="unavailable",
        source_status="offline",
        projection_status="unavailable",
        observed_at="2026-08-25T00:01:00Z",
    )

    report = collector.report(make_snapshot(healthy_services(), revision=3))

    assert report.calendar.resultStatus == "unavailable"
    assert report.calendar.resultStatus != "success_empty"
    assert report.calendar.sourceStatus == "offline"


def test_real_calendar_route_records_actual_range_and_view():
    planning = empty_planning_projection(
        generated_at="2026-08-25T00:00:00Z",
        source_status="current",
    )

    class StubAdapter:
        enabled = True

        async def read_events(self, *, from_utc, to_utc, limit, offset):
            return PlanningReadEnvelope(
                schemaVersion="planning.panel.v1",
                kind="list",
                domain="calendar_event",
                generatedAt="2026-08-25T00:00:00Z",
                sourceStatus="current",
                lastSyncedAt="2026-08-24T23:00:00Z",
                staleAfter="2026-08-25T00:30:00Z",
                sources=planning.providerStatuses,
                items=[],
                limit=limit,
                offset=offset,
                count=0,
                hasMore=False,
            )

    collector = DiagnosticsCollector(IntegrationSettings())
    app = FastAPI()
    app.include_router(
        build_planning_router(
            StubAdapter(),
            calendar_read_observer=collector.observe_calendar_read,
        )
    )
    with TestClient(app) as client:
        response = client.get(
            "/api/v1/planning/events?from=2026-08-24T23:30:00Z&to=2026-08-25T23:30:00Z&view=agenda"
        )

    assert response.status_code == 200
    report = collector.report(make_snapshot(healthy_services(), planning=planning))
    assert report.calendar.scopeType == "ACTUAL_REQUEST_RANGE"
    assert report.calendar.view == "agenda"
    assert report.calendar.resultStatus == "success_empty"
    assert report.calendar.itemCount == 0
    assert report.calendar.fromDate == "2026-08-25"
    assert report.calendar.requestFromUtc == "2026-08-24T23:30:00+00:00"


def test_calendar_read_history_is_bounded_and_content_free():
    collector = DiagnosticsCollector(IntegrationSettings(), history_size=2)
    for index in range(5):
        collector.observe_calendar_read(
            from_utc="2026-08-25T00:00:00Z",
            to_utc="2026-08-26T00:00:00Z",
            view="agenda",
            item_count=index,
            source_status="current",
            observed_at=f"2026-08-25T00:00:0{index}Z",
        )

    report = collector.report(make_snapshot(healthy_services(), revision=4))
    payload = report.model_dump_json()

    assert len(report.calendarReads) == 2
    assert "PRIVATE_EVENT_TITLE" not in payload
    assert "title" not in payload.lower()


def test_calendar_read_history_preserves_nonempty_degraded_recovery_sequence():
    collector = DiagnosticsCollector(IntegrationSettings())
    common = {
        "from_utc": "2026-08-25T00:00:00Z",
        "to_utc": "2026-08-26T00:00:00Z",
        "view": "today",
    }
    collector.observe_calendar_read(
        **common,
        item_count=2,
        source_status="current",
        observed_at="2026-08-25T09:00:00Z",
    )
    collector.observe_calendar_read(
        **common,
        item_count=0,
        source_status="degraded",
        result_status="degraded",
        projection_status="cached",
        observed_at="2026-08-25T09:01:00Z",
    )
    collector.observe_calendar_read(
        **common,
        item_count=2,
        source_status="current",
        observed_at="2026-08-25T09:02:00Z",
    )

    report = collector.report(make_snapshot(healthy_services(), revision=6))
    assert [read.resultStatus for read in report.calendarReads] == [
        "success_nonempty",
        "degraded",
        "success_nonempty",
    ]
    assert report.calendar.itemCount == 2


def test_first_observed_at_tracks_contiguous_service_incidents():
    services = healthy_services()
    collector = DiagnosticsCollector(IntegrationSettings())

    collector.observe(make_snapshot(services, revision=1))
    services[0].health = "offline"
    first_incident = collector.report(make_snapshot(services, revision=2))
    assert first_incident.problems[0].firstObservedAt == "2026-08-25T12:00:02+00:00"

    services[0].health = "healthy"
    recovered = collector.report(make_snapshot(services, revision=3))
    assert recovered.problems == []
    assert any(not transition.current and transition.toState == "recovered" for transition in recovered.recentTransitions)

    services[0].health = "offline"
    second_incident = collector.report(make_snapshot(services, revision=5))
    assert second_incident.problems[0].firstObservedAt == "2026-08-25T12:00:05+00:00"
    assert second_incident.problems[0].firstObservedAt != first_incident.problems[0].firstObservedAt


def test_first_observed_at_lifecycle_applies_to_planning_provider():
    planning = empty_planning_projection(
        generated_at="2026-08-25T12:00:00Z",
        source_status="current",
        provider_status="current",
    )
    collector = DiagnosticsCollector(IntegrationSettings())
    collector.observe(make_snapshot(healthy_services(), planning=planning, revision=1))
    planning.providerStatuses[0].status = "error"
    problem = collector.report(make_snapshot(healthy_services(), planning=planning, revision=2))
    assert problem.problems[0].firstObservedAt == "2026-08-25T12:00:02+00:00"

    planning.providerStatuses[0].status = "current"
    recovered = collector.report(make_snapshot(healthy_services(), planning=planning, revision=3))
    assert any(not transition.current and transition.toState == "recovered" for transition in recovered.recentTransitions)


def test_build_revision_is_allowlisted_and_unknown_is_honest():
    exact = DiagnosticsCollector(IntegrationSettings(), build_revision="production-59d376c02d26").report(
        make_snapshot(healthy_services())
    )
    missing = DiagnosticsCollector(IntegrationSettings(), build_revision="unknown").report(
        make_snapshot(healthy_services())
    )

    assert exact.buildRevision == "production-59d376c02d26"
    assert missing.buildRevision == "unknown"
    assert "ARBITRARY_ENV_VALUE" not in missing.model_dump_json()


def test_transition_ring_is_bounded():
    services = healthy_services()
    collector = DiagnosticsCollector(IntegrationSettings(), history_size=4)
    for revision in range(1, 20):
        services[0].health = "offline" if revision % 2 else "healthy"
        collector.observe(make_snapshot(services, revision=revision))

    assert len(collector.report(make_snapshot(services, revision=20)).recentTransitions) <= 4


def test_partial_collector_failure_returns_safe_partial_report(monkeypatch):
    collector = DiagnosticsCollector(IntegrationSettings())
    monkeypatch.setattr(collector, "_planning_summary", lambda snapshot: (_ for _ in ()).throw(RuntimeError("secret")))

    report = collector.report(make_snapshot(healthy_services()))

    assert report.schemaVersion == "diagnostics.v1"
    assert any(
        status.collector == "planning" and status.status == "error" and status.code == "planning_projection_unavailable"
        for status in report.collectorStatus
    )
    assert "secret" not in report.model_dump_json()


def test_secret_and_private_content_canaries_never_cross_allowlisted_report():
    services = healthy_services()
    services[0].title = "PRIVATE_EVENT_TITLE_CANARY"
    services[0].summary = "PRIVATE_REMINDER_TEXT_CANARY"
    services[0].data = {"secret": "super-secret-ha-token-canary", "notes": "PRIVATE_TASK_TEXT_CANARY"}
    collector = DiagnosticsCollector(IntegrationSettings())

    payload = json.dumps(collector.report(make_snapshot(services)).model_dump(mode="json"), ensure_ascii=False)

    for canary in (
        "super-secret-ha-token-canary",
        "planning-secret-canary",
        "PRIVATE_EVENT_TITLE_CANARY",
        "PRIVATE_REMINDER_TEXT_CANARY",
        "PRIVATE_TASK_TEXT_CANARY",
    ):
        assert canary not in payload
