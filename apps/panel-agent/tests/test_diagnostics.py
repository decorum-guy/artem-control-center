import json

from panel_agent.diagnostics import DiagnosticsCollector
from panel_agent.fixtures import services_for_scenario
from panel_agent.planning import empty_planning_projection
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

    assert report.calendar.resultStatus == "ok_empty"
    assert report.calendar.itemCount == 0
    assert report.calendar.sourceCount == 0
    assert report.calendar.calendarCount == 0


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
