from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from panel_agent.contracts import ServiceSnapshot
from panel_agent.fixtures import services_for_scenario
from panel_agent.integrations import IntegrationRuntime
from panel_agent.planning import (
    PlanningReminderLists,
    ReminderProjection,
    empty_planning_projection,
)
from panel_agent.planning_adapter import (
    PLANNING_ROUTES,
    PlanningAdapter,
    PlanningClient,
    PlanningConfigurationError,
    PlanningUpstreamError,
)
from panel_agent.planning_cache import PlanningProjectionCache
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings
from panel_agent.snapshot import SnapshotPublisher


class RecordingFixtureTransport(httpx.AsyncBaseTransport):
    def __init__(self, scenario: str = "healthy") -> None:
        self.scenario = scenario
        self.requests: list[tuple[str, str, dict[str, str], str]] = []
        self.fixture = PlanningFixtureTransport(scenario)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.fixture.scenario = self.scenario
        self.requests.append(
            (
                request.method,
                request.url.path,
                {
                    "internal": request.headers.get("x-internal-secret", ""),
                    "audience": request.headers.get("x-planning-audience", ""),
                    "planning": request.headers.get("x-planning-secret", ""),
                },
                str(request.url.query),
            )
        )
        return await self.fixture.handle_async_request(request)


def settings(tmp_path, **overrides) -> IntegrationSettings:
    values = dict(
        panel_planning_enabled=True,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_refresh_seconds=10,
        panel_planning_status_refresh_seconds=300,
        panel_planning_stale_after_seconds=10,
        panel_planning_unavailable_after_seconds=30,
        panel_planning_max_backoff_seconds=60,
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_response_limit_bytes=256 * 1024,
        panel_planning_timezone="Europe/Moscow",
    )
    values.update(overrides)
    return IntegrationSettings(**values)


def test_feature_off_never_constructs_client_or_polls(tmp_path):
    transport = RecordingFixtureTransport()
    adapter = PlanningAdapter(
        IntegrationSettings(
            panel_planning_enabled=False,
            panel_planning_base_url="",
            panel_planning_internal_secret="",
            panel_planning_secret="",
            panel_planning_cache_path=str(tmp_path / "unused.json"),
        ),
        transport=transport,
    )

    async def exercise():
        await adapter.start()
        await adapter.refresh()
        await adapter.close()

    asyncio.run(exercise())
    assert not transport.requests
    assert adapter.projection is None


def test_enabled_without_credentials_fails_closed(tmp_path):
    with pytest.raises(PlanningConfigurationError):
        PlanningAdapter(
            settings(
                tmp_path,
                panel_planning_internal_secret="",
            )
        )


def test_environment_gate_does_not_require_credentials_when_off(monkeypatch):
    monkeypatch.setenv("PANEL_PLANNING_ENABLED", "false")
    monkeypatch.delenv("PANEL_PLANNING_BASE_URL", raising=False)
    monkeypatch.delenv("PANEL_PLANNING_INTERNAL_SECRET", raising=False)
    monkeypatch.delenv("PANEL_PLANNING_SECRET", raising=False)
    assert IntegrationSettings.from_env().panel_planning_enabled is False


def test_environment_gate_requires_fixed_connection_when_on(monkeypatch):
    monkeypatch.setenv("PANEL_PLANNING_ENABLED", "true")
    monkeypatch.setenv("PANEL_PLANNING_BASE_URL", "http://fixture.test")
    monkeypatch.delenv("PANEL_PLANNING_INTERNAL_SECRET", raising=False)
    monkeypatch.delenv("PANEL_PLANNING_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        IntegrationSettings.from_env()


@pytest.mark.parametrize(
    "base_url",
    [
        "ftp://fixture.test",
        "http://user:pass@fixture.test",
        "http://fixture.test?url=https://example.com",
        "http://fixture.test/#fragment",
        "http://fixture.test/internal/planning/v1",
    ],
)
def test_fixed_base_url_rejects_unsafe_forms(tmp_path, base_url):
    with pytest.raises(PlanningConfigurationError):
        PlanningClient(
            base_url=base_url,
            internal_secret="synthetic-internal-secret",
            panel_secret="synthetic-panel-agent-secret",
        )


def test_valid_a4_contracts_auth_and_bounded_projection(tmp_path):
    transport = RecordingFixtureTransport()
    adapter = PlanningAdapter(settings(tmp_path), transport=transport)

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        assert projection is not None
        await adapter.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection.schemaVersion == "planning.panel.v1"
    assert projection.sourceStatus == "current"
    assert projection.reminders.upcoming
    assert projection.tasks.today and projection.tasks.overdue and projection.tasks.upcoming
    assert projection.tasks.projects
    assert projection.calendar.today
    assert projection.calendar.conflicts
    assert projection.capabilities.model_dump() == {
        "create": False,
        "edit": False,
        "complete": False,
        "cancel": False,
        "delete": False,
        "voice": False,
        "providerSync": False,
    }
    assert projection.providerStatuses[0].status == "local_only"
    assert all(len(getattr(projection.reminders, field)) <= 20 for field in ("upcoming", "overdue", "deliveryFailures"))
    assert all(len(getattr(projection.tasks, field)) <= 20 for field in ("today", "overdue", "upcoming", "projects"))
    assert all(len(getattr(projection.calendar, field)) <= 20 for field in ("today", "upcoming", "conflicts"))
    assert {path for _, path, _, _ in transport.requests} == set(PLANNING_ROUTES.values())
    assert all(method == "GET" for method, _, _, _ in transport.requests)
    assert all(
        headers == {
            "internal": "synthetic-internal-secret",
            "audience": "panel-agent",
            "planning": "synthetic-panel-agent-secret",
        }
        for _, _, headers, _ in transport.requests
    )
    assert all("limit=20" in query for method, path, headers, query in transport.requests if path != PLANNING_ROUTES["status"])
    assert "synthetic-internal-secret" not in projection.model_dump_json()
    assert "synthetic-panel-agent-secret" not in projection.model_dump_json()


def test_upstream_degraded_status_does_not_become_current(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path),
        transport=RecordingFixtureTransport("degraded"),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        await adapter.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection is not None
    assert projection.sourceStatus == "degraded"
    assert projection.tasks.today


@pytest.mark.parametrize("scenario", ["malformed", "incompatible", "oversized"])
def test_strict_contract_failures_fail_closed_to_empty_offline(tmp_path, scenario):
    transport = RecordingFixtureTransport(scenario)
    adapter = PlanningAdapter(settings(tmp_path), transport=transport)

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        await adapter.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection is not None
    assert projection.sourceStatus == "offline"
    assert projection.reminders.upcoming == []
    assert projection.tasks.today == []


def test_wrong_domain_and_duplicate_json_are_rejected(tmp_path):
    from panel_agent.planning_fixtures import fixture_payload

    payload = fixture_payload("healthy", PLANNING_ROUTES["reminders"], httpx.QueryParams())
    assert payload is not None
    payload["domain"] = "task"

    def wrong_domain(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = PlanningClient(
        base_url="http://fixture.test",
        internal_secret="synthetic-internal-secret",
        panel_secret="synthetic-panel-agent-secret",
        transport=httpx.MockTransport(wrong_domain),
    )

    async def exercise():
        with pytest.raises(PlanningUpstreamError) as wrong_domain_error:
            await client.reminders()
        await client.close()
        return wrong_domain_error.value.category

    assert asyncio.run(exercise()) == "domain_mismatch"

    def duplicate(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b'{"schemaVersion":"planning.v1","schemaVersion":"planning.v1"}',
        )

    duplicate_client = PlanningClient(
        base_url="http://fixture.test",
        internal_secret="synthetic-internal-secret",
        panel_secret="synthetic-panel-agent-secret",
        transport=httpx.MockTransport(duplicate),
    )

    async def duplicate_exercise():
        with pytest.raises(PlanningUpstreamError) as duplicate_error:
            await duplicate_client.status()
        await duplicate_client.close()
        return duplicate_error.value.category

    assert asyncio.run(duplicate_exercise()) == "malformed_json"


def test_fixture_content_is_inert_text_and_client_has_no_proxy_surface(tmp_path):
    assert not hasattr(PlanningClient, "proxy")
    assert not hasattr(PlanningClient, "request")
    assert set(PLANNING_ROUTES) == {"reminders", "tasks", "events", "projects", "status"}
    assert "/alice/interpret" not in PLANNING_ROUTES.values()
    projection = empty_planning_projection(
        generated_at="2026-08-12T09:00:00Z",
        source_status="current",
    )
    title = "https://example.com light.turn_on /etc/passwd"
    item = ReminderProjection(
        id="00000000-0000-4000-8000-000000000010",
        version=1,
        source="alice",
        sourceLabel="AliceTG Bot",
        title=title,
        dueAtUtc="2026-08-12T10:00:00Z",
        timezone="Europe/Moscow",
        status="pending",
        deliveryState="not_due",
        createdAt="2026-08-12T09:00:00Z",
        updatedAt="2026-08-12T09:00:00Z",
    )
    projection = projection.model_copy(
        update={
            "reminders": PlanningReminderLists(
                upcoming=[item], overdue=[], deliveryFailures=[]
            )
        },
        deep=True,
    )
    assert projection.reminders.upcoming[0].title == title


def test_status_cadence_does_not_hammer_a8_status_and_reconnect_refreshes(tmp_path):
    transport = RecordingFixtureTransport()
    mono = [0.0]
    adapter = PlanningAdapter(
        settings(tmp_path),
        transport=transport,
        monotonic_clock=lambda: mono[0],
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
        random_fn=lambda: 0.5,
    )

    async def exercise():
        await adapter.start()
        initial_status = sum(path == PLANNING_ROUTES["status"] for _, path, _, _ in transport.requests)
        await adapter.refresh()
        fast_status = sum(path == PLANNING_ROUTES["status"] for _, path, _, _ in transport.requests)
        mono[0] += 301
        await adapter.refresh()
        slow_status = sum(path == PLANNING_ROUTES["status"] for _, path, _, _ in transport.requests)
        transport.scenario = "offline"
        await adapter.refresh()
        transport.scenario = "healthy"
        await adapter.refresh()
        recovered_status = sum(path == PLANNING_ROUTES["status"] for _, path, _, _ in transport.requests)
        await adapter.close()
        return initial_status, fast_status, slow_status, recovered_status

    initial_status, fast_status, slow_status, recovered_status = asyncio.run(exercise())
    assert initial_status == 1
    assert fast_status == 1
    assert slow_status == 2
    assert recovered_status == 3


def test_backoff_is_bounded_and_jitter_is_injected(tmp_path):
    adapter = PlanningAdapter(
        settings(tmp_path, panel_planning_refresh_seconds=10, panel_planning_max_backoff_seconds=25),
        transport=RecordingFixtureTransport(),
        random_fn=lambda: 0.0,
    )
    assert adapter.next_poll_delay(0) == pytest.approx(9.0)
    assert adapter.next_poll_delay(1) == pytest.approx(9.0)
    assert adapter.next_poll_delay(2) == pytest.approx(18.0)
    assert adapter.next_poll_delay(8) == pytest.approx(22.5)


def test_failure_state_machine_is_current_stale_offline(tmp_path):
    transport = RecordingFixtureTransport()
    mono = [0.0]
    adapter = PlanningAdapter(
        settings(tmp_path),
        transport=transport,
        monotonic_clock=lambda: mono[0],
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        assert adapter.projection.sourceStatus == "current"
        transport.scenario = "offline"
        mono[0] = 11
        await adapter.refresh_domains()
        stale = adapter.projection.sourceStatus
        mono[0] = 31
        await adapter.refresh_domains()
        offline = adapter.projection.sourceStatus
        await adapter.close()
        return stale, offline

    stale, offline = asyncio.run(exercise())
    assert stale == "stale"
    assert offline == "offline"


def test_last_good_cache_survives_restart_without_current_label(tmp_path):
    cache_path = tmp_path / "planning-cache.json"
    clock = lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc)

    async def exercise():
        first_transport = RecordingFixtureTransport()
        first = PlanningAdapter(
            settings(tmp_path),
            transport=first_transport,
            wall_clock=clock,
        )
        await first.start()
        await first.close()
        assert cache_path.exists()

        second_transport = RecordingFixtureTransport("offline")
        second = PlanningAdapter(
            settings(tmp_path),
            transport=second_transport,
            wall_clock=clock,
        )
        await second.start()
        projection = second.projection
        await second.close()
        return projection

    projection = asyncio.run(exercise())
    assert projection is not None
    assert projection.sourceStatus == "stale"
    assert projection.tasks.today
    contents = cache_path.read_text(encoding="utf-8")
    assert "synthetic-internal-secret" not in contents
    assert "synthetic-panel-agent-secret" not in contents


def test_cache_corruption_future_schema_and_size_fail_closed(tmp_path):
    path = tmp_path / "cache.json"
    path.write_text("{not-json", encoding="utf-8")
    cache = PlanningProjectionCache(path)
    assert cache.load() is None
    path.write_text(
        '{"cacheSchemaVersion":99,"savedAt":"2026-08-12T09:00:00Z","projection":{}}',
        encoding="utf-8",
    )
    assert cache.load() is None
    path.write_bytes(b"x" * (cache.max_bytes + 1))
    assert cache.load() is None


def test_snapshot_fingerprint_ignores_timestamps_but_emits_normal_revision_and_sse():
    planning = [
        empty_planning_projection(
            generated_at="2026-08-12T09:00:00Z",
            source_status="current",
        )
    ]
    publisher = SnapshotPublisher(
        mode="production",
        services_builder=lambda: [],
        planning_builder=lambda: planning[0],
        heartbeat_seconds=0.01,
    )

    async def exercise():
        first = await publisher.rebuild()
        planning[0] = planning[0].model_copy(
            update={
                "generatedAt": "2026-08-12T09:00:01Z",
                "lastSyncedAt": "2026-08-12T09:00:01Z",
                "staleAfter": "2026-08-12T09:01:31Z",
            },
            deep=True,
        )
        timestamp_only = await publisher.rebuild()
        reminder = ReminderProjection(
            id="00000000-0000-4000-8000-000000000011",
            version=1,
            source="alice",
            sourceLabel="AliceTG Bot",
            title="Synthetic fingerprint item",
            dueAtUtc="2026-08-12T10:00:00Z",
            timezone="Europe/Moscow",
            status="pending",
            deliveryState="not_due",
            createdAt="2026-08-12T09:00:00Z",
            updatedAt="2026-08-12T09:00:00Z",
        )
        planning[0] = planning[0].model_copy(
            update={
                "reminders": PlanningReminderLists(
                    upcoming=[reminder], overdue=[], deliveryFailures=[]
                )
            },
            deep=True,
        )
        changed_object = await publisher.rebuild()
        planning[0] = planning[0].model_copy(update={"sourceStatus": "stale"}, deep=True)
        stale = await publisher.rebuild()
        planning[0] = planning[0].model_copy(update={"sourceStatus": "offline"}, deep=True)
        offline = await publisher.rebuild()

        async def disconnected() -> bool:
            return False

        stream = publisher.event_stream(disconnected)
        connected = await stream.__anext__()
        pending = asyncio.create_task(stream.__anext__())
        planning[0] = planning[0].model_copy(update={"sourceStatus": "degraded"}, deep=True)
        await publisher.rebuild()
        event = await pending
        await stream.aclose()
        return first, timestamp_only, changed_object, stale, offline, connected, event

    first, timestamp_only, changed_object, stale, offline, connected, event = asyncio.run(exercise())
    assert first.revision == 1
    assert timestamp_only.revision == 1
    assert changed_object.revision == 2
    assert stale.revision == 3
    assert offline.revision == 4
    assert "event: connected" in connected
    assert "event: snapshot" in event
    assert '"revision":5' in event


def test_runtime_disabled_planning_does_not_change_existing_service_shape():
    runtime = IntegrationRuntime(IntegrationSettings(panel_planning_enabled=False), mode="read_only")
    assert runtime.planning_snapshot() is None
    assert runtime.services()
    assert all(service.dataContract for service in runtime.services())


def test_read_only_same_origin_routes_are_bounded_and_have_no_writes(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_PLANNING_ENABLED", "true")
    monkeypatch.setenv("PANEL_PLANNING_BASE_URL", "http://fixture.test")
    monkeypatch.setenv("PANEL_PLANNING_INTERNAL_SECRET", "synthetic-internal-secret")
    monkeypatch.setenv("PANEL_PLANNING_SECRET", "synthetic-panel-agent-secret")
    monkeypatch.setenv("PANEL_PLANNING_CACHE_PATH", str(tmp_path / "api-cache.json"))
    monkeypatch.setenv("PANEL_PLANNING_FIXTURE_SCENARIO", "healthy")
    import importlib
    import panel_agent.main

    module = importlib.reload(panel_agent.main)
    with TestClient(module.app) as client:
        status_response = client.get("/api/v1/planning/status")
        alias_response = client.get("/api/planning/status")
        snapshot_response = client.get("/api/v1/snapshot")
        reminders_response = client.get("/api/v1/planning/reminders?limit=1")
        tasks_response = client.get("/api/v1/planning/tasks?view=today&limit=1")
        events_response = client.get(
            "/api/v1/planning/events?from=2026-08-12T00:00:00Z&to=2026-08-13T00:00:00Z"
        )
        projects_response = client.get("/api/v1/planning/projects?limit=1")
        unknown_response = client.get("/api/v1/planning/reminders?url=https://example.com")
        oversized_limit = client.get("/api/v1/planning/tasks?view=today&limit=101")
        write_response = client.post("/api/v1/planning/tasks", json={})
        parse_response = client.post("/api/v1/planning/parse", json={})

    assert status_response.status_code == 200
    assert alias_response.status_code == 200
    assert snapshot_response.status_code == 200
    assert snapshot_response.json()["planning"]["capabilities"]["create"] is False
    assert reminders_response.status_code == 200
    assert reminders_response.json()["count"] <= 1
    assert tasks_response.status_code == 200
    assert events_response.status_code == 200
    assert projects_response.status_code == 200
    assert unknown_response.status_code == 422
    assert oversized_limit.status_code == 422
    assert write_response.status_code == 405
    assert parse_response.status_code == 404
    assert "synthetic-panel-agent-secret" not in status_response.text
