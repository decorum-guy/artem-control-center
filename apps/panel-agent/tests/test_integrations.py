from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from panel_agent.home_assistant import HomeAssistantAdapter
from panel_agent.http_integrations import HttpIntegrationAdapter
from panel_agent.settings import IntegrationSettings
from panel_agent.snapshot import SnapshotPublisher
from panel_agent.ssh_details import (
    AvalarSshDetailsAdapter,
    SshDetailsError,
    _parse_command_output,
)


def _ha_states():
    return [
        {
            "entity_id": "switch.kofemashina",
            "state": "on",
            "last_changed": "2026-07-29T11:54:09Z",
            "last_updated": "2026-07-29T11:54:09Z",
            "attributes": {},
        },
        {
            "entity_id": "input_number.coffee_warmup_minutes",
            "state": "13",
            "last_updated": "2026-07-29T11:59:30Z",
            "attributes": {},
        },
        {
            "entity_id": "input_number.coffee_long_running_minutes",
            "state": "60",
            "last_updated": "2026-07-29T11:59:31Z",
            "attributes": {},
        },
        {
            "entity_id": "input_datetime.coffee_last_turned_on",
            "state": "2026-07-29 11:54:09",
            "last_updated": "2026-07-29T11:54:09Z",
            "attributes": {"timestamp": 1785326049},
        },
        {
            "entity_id": "input_boolean.coffee_timing_initialized",
            "state": "on",
            "last_updated": "2026-07-29T11:59:31Z",
            "attributes": {},
        },
        {
            "entity_id": "water_heater.chainik",
            "state": "off",
            "last_updated": "2026-07-29T11:59:30Z",
            "attributes": {},
        },
        *[
            {
                "entity_id": entity,
                "state": "off",
                "last_updated": "2026-07-29T11:59:30Z",
                "attributes": {},
            }
            for entity in (
                "switch.chainik_podderzhanie_tepla",
                "switch.chainik_podsvetka",
                "switch.chainik_bez_zvuka",
            )
        ],
        {
            "entity_id": "sensor.not_allowlisted",
            "state": "private",
            "attributes": {"secret": "must-not-cache"},
        },
    ]


def test_ha_initial_snapshot_normalizes_canonical_helpers(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-token"
        return httpx.Response(200, json=_ha_states())

    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
    )
    adapter = HomeAssistantAdapter(
        settings,
        transport=httpx.MockTransport(handler),
    )
    asyncio.run(adapter.fetch_initial_snapshot())
    services = {service.id: service for service in adapter.services()}
    coffee = services["coffee-machine"]

    assert coffee.source == "live"
    assert coffee.data["machine"]["authority"] == "home-assistant"
    assert coffee.data["machine"]["turnedOnAt"] == "2026-07-29T11:54:09+00:00"
    assert coffee.data["timingPolicy"]["source"] == "home-assistant"
    assert coffee.data["timingPolicy"]["warmupDurationSeconds"] == 780
    assert coffee.data["timingPolicy"]["longRunningThresholdSeconds"] == 3600
    assert coffee.actions and all(not action.enabled for action in coffee.actions)
    assert "not_allowlisted" not in (tmp_path / "ha-cache.json").read_text()


def test_uninitialized_timing_and_unknown_activation_do_not_create_fake_progress(
    tmp_path,
):
    states = _ha_states()
    for state in states:
        if state["entity_id"] == "input_boolean.coffee_timing_initialized":
            state["state"] = "off"
        if state["entity_id"] == "input_datetime.coffee_last_turned_on":
            state["state"] = "unknown"
            state["attributes"] = {}

    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
        ),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=states),
        ),
    )
    asyncio.run(adapter.fetch_initial_snapshot())
    coffee = {service.id: service for service in adapter.services()}["coffee-machine"]

    assert coffee.data["machine"]["turnedOnAt"] is None
    assert coffee.data["timingPolicy"]["initialized"] is False
    assert coffee.data["timingPolicy"]["sourceAvailable"] is False


def test_coffee_action_capabilities_require_all_live_server_side_gates(tmp_path):
    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
        writes_enabled=True,
        coffee_actions_enabled=True,
        alice_base_url="https://alice.test",
        alice_control_center_token="dedicated-token",
    )
    adapter = HomeAssistantAdapter(
        settings,
        panel_mode="production",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=_ha_states())
        ),
    )
    asyncio.run(adapter.fetch_initial_snapshot())

    coffee = {service.id: service for service in adapter.services()}["coffee-machine"]
    enabled = {action.id for action in coffee.actions if action.enabled}
    assert enabled == {"home.coffee.turn_off"}
    assert adapter.coffee_action_allowed("turn_off")
    assert not adapter.coffee_action_allowed("turn_on")

    adapter._states["switch.kofemashina"]["state"] = "off"
    coffee = {service.id: service for service in adapter.services()}["coffee-machine"]
    assert {action.id for action in coffee.actions if action.enabled} == {
        "home.coffee.turn_on"
    }

    asyncio.run(adapter._mark_websocket_disconnected())
    assert all(
        not action.enabled
        for action in {
            service.id: service for service in adapter.services()
        }["coffee-machine"].actions
    )


def test_ha_transport_liveness_is_independent_from_idle_entity_timestamps(
    tmp_path,
):
    clock = [datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc)]
    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
        ha_stale_after_seconds=90,
        writes_enabled=True,
        coffee_actions_enabled=True,
        alice_base_url="https://alice.test",
        alice_control_center_token="dedicated-token",
    )
    adapter = HomeAssistantAdapter(
        settings,
        panel_mode="production",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=_ha_states())
        ),
        clock=lambda: clock[0],
    )
    publisher = SnapshotPublisher(
        mode="production",
        services_builder=adapter.services,
    )
    adapter.set_on_change(publisher.rebuild)

    async def exercise():
        await adapter.fetch_initial_snapshot()
        initial = {service.id: service for service in adapter.services()}
        assert initial["home-assistant"].source == "live"
        assert initial["coffee-machine"].source == "live"
        assert adapter.coffee_action_allowed("turn_off")

        await adapter._mark_websocket_connected()
        connected_revision = publisher.revision
        clock[0] += timedelta(minutes=6)

        idle = {service.id: service for service in adapter.services()}
        assert idle["home-assistant"].source == "live"
        assert idle["coffee-machine"].source == "live"
        assert idle["coffee-machine"].data["machine"]["stale"] is False
        assert idle["coffee-machine"].data["machine"]["entityLastChangedAt"] == (
            "2026-07-29T11:54:09Z"
        )
        assert adapter.coffee_action_allowed("turn_off")

        # Repeated technical connectivity observations do not publish revisions.
        await adapter._mark_websocket_connected()
        assert publisher.revision == connected_revision

        await adapter._mark_websocket_disconnected()
        disconnected = {service.id: service for service in adapter.services()}
        assert disconnected["home-assistant"].source == "cached"
        assert disconnected["coffee-machine"].source == "cached"
        assert not adapter.coffee_action_allowed("turn_off")

        clock[0] += timedelta(seconds=91)
        await publisher.rebuild()
        stale = {service.id: service for service in adapter.services()}
        assert stale["home-assistant"].source == "stale"
        assert stale["coffee-machine"].source == "stale"
        assert not adapter.coffee_action_allowed("turn_off")

        await adapter._mark_websocket_connected()
        assert {service.id: service for service in adapter.services()}[
            "home-assistant"
        ].source == "stale"
        await adapter.fetch_initial_snapshot()
        recovered = {service.id: service for service in adapter.services()}
        assert recovered["home-assistant"].source == "live"
        assert recovered["coffee-machine"].source == "live"
        assert recovered["home-assistant"].data["transport"][
            "websocketConnected"
        ]
        assert recovered["home-assistant"].data["transport"][
            "snapshotConfirmed"
        ]
        assert adapter.coffee_action_allowed("turn_off")

    asyncio.run(exercise())


def test_ha_allowlisted_event_publishes_only_meaningful_snapshot(tmp_path):
    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
        ),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=_ha_states())
        ),
    )
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=adapter.services,
    )
    adapter.set_on_change(publisher.rebuild)

    async def exercise():
        await adapter.fetch_initial_snapshot()
        assert publisher.revision == 1
        coffee = next(
            state
            for state in _ha_states()
            if state["entity_id"] == "switch.kofemashina"
        )
        assert not await adapter.apply_state_changed("switch.kofemashina", coffee)
        assert publisher.revision == 1
        changed = dict(coffee, state="off", last_updated="2026-07-29T12:00:00Z")
        assert await adapter.apply_state_changed("switch.kofemashina", changed)
        assert publisher.revision == 2
        assert not await adapter.apply_state_changed(
            "sensor.not_allowlisted",
            {"state": "private"},
        )
        assert publisher.revision == 2

    asyncio.run(exercise())


def test_http_adapters_keep_main_and_stage_capabilities_separate():
    class Details:
        def details_for(self, service_id: str):
            return {
                "environment": (
                    "production" if service_id == "avalar-site-main" else "stage"
                ),
                "commit": "site-commit",
                "deployment_revision": "deploy-1",
                "details_source": "live",
            }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health/live":
            return httpx.Response(200, json={"status": "live"})
        if request.url.path == "/health/ready":
            return httpx.Response(200, json={"status": "ready"})
        if request.url.path == "/health/details":
            if request.url.host == "bot.test":
                return httpx.Response(
                    200,
                    json={
                        "home_assistant": "ready",
                        "timing_helpers": "ready",
                        "version": "1.0",
                        "commit": "bot-commit",
                    },
                )
        return httpx.Response(404)

    adapter = HttpIntegrationAdapter(
        IntegrationSettings(
            avalar_main_url="https://main.test",
            avalar_stage_url="https://stage.test",
            alice_health_url="https://bot.test",
        ),
        transport=httpx.MockTransport(handler),
        details_provider=Details(),
    )
    asyncio.run(adapter.refresh())
    services = {service.id: service for service in adapter.services()}

    main_actions = {action.id for action in services["avalar-site-main"].actions}
    stage_actions = {action.id for action in services["avalar-site-stage"].actions}
    assert main_actions == {"avalar.main.smoke"}
    assert stage_actions == {"avalar.stage.smoke", "avalar.stage.deploy"}
    assert all(not action.enabled for action in services["avalar-site-stage"].actions)
    assert services["avalar-site-main"].presentation.priority > services[
        "avalar-site-stage"
    ].presentation.priority
    assert services["alice-tg-bot"].data["coffeeTimingAuthority"] is False
    assert services["avalar-site-main"].data["detailsSource"] == "live"


def test_http_refresh_transitions_cached_stale_unavailable_and_recovers():
    state = {"available": True}
    clock = [0.0]

    def handler(request: httpx.Request) -> httpx.Response:
        if not state["available"]:
            raise httpx.ConnectError("offline", request=request)
        if request.url.path == "/health/live":
            return httpx.Response(200, json={"status": "live"})
        if request.url.path == "/health/ready":
            return httpx.Response(200, json={"status": "ready"})
        return httpx.Response(401, json={"status": "unauthorized"})

    adapter = HttpIntegrationAdapter(
        IntegrationSettings(
            avalar_main_url="https://main.test",
            avalar_stage_url="https://stage.test",
            alice_health_url="https://bot.test",
            integration_stale_after_seconds=30,
            integration_unavailable_after_seconds=120,
        ),
        transport=httpx.MockTransport(handler),
        clock=lambda: clock[0],
    )

    asyncio.run(adapter.refresh())
    assert all(service.source == "live" for service in adapter.services())

    state["available"] = False
    clock[0] = 10
    asyncio.run(adapter.refresh())
    assert all(service.source == "cached" for service in adapter.services())

    clock[0] = 60
    asyncio.run(adapter.refresh())
    assert all(service.source == "stale" for service in adapter.services())

    clock[0] = 180
    asyncio.run(adapter.refresh())
    assert all(service.source == "unavailable" for service in adapter.services())

    state["available"] = True
    asyncio.run(adapter.refresh())
    assert all(service.source == "live" for service in adapter.services())


def test_http_refresh_publishes_service_health_change():
    state = {"available": True}

    def handler(request: httpx.Request) -> httpx.Response:
        if not state["available"]:
            raise httpx.ConnectError("offline", request=request)
        status = "live" if request.url.path.endswith("/live") else "ready"
        if request.url.path.endswith("/details"):
            return httpx.Response(401)
        return httpx.Response(200, json={"status": status})

    adapter = HttpIntegrationAdapter(
        IntegrationSettings(
            avalar_main_url="https://main.test",
            integration_stale_after_seconds=0,
            integration_unavailable_after_seconds=1,
        ),
        transport=httpx.MockTransport(handler),
    )
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=adapter.services,
    )
    adapter.set_on_change(publisher.rebuild)

    async def exercise():
        await adapter.refresh()
        live_revision = publisher.revision
        state["available"] = False
        await adapter.refresh()
        assert publisher.revision > live_revision

    asyncio.run(exercise())


def test_periodic_http_refresh_does_not_overlap_and_shutdown_cancels():
    class DelayedTransport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.active = 0
            self.max_active = 0

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            await asyncio.sleep(0.01)
            self.active -= 1
            status = "live" if request.url.path.endswith("/live") else "ready"
            if request.url.path.endswith("/details"):
                return httpx.Response(401, json={"status": "unauthorized"})
            return httpx.Response(200, json={"status": status})

    async def exercise():
        transport = DelayedTransport()
        adapter = HttpIntegrationAdapter(
            IntegrationSettings(
                avalar_main_url="https://main.test",
                avalar_stage_url="https://stage.test",
                alice_health_url="https://bot.test",
                http_refresh_seconds=0.01,
            ),
            transport=transport,
        )
        await asyncio.gather(adapter.refresh(), adapter.refresh())
        assert transport.max_active <= 6
        await adapter.start()
        assert adapter.running
        await asyncio.sleep(0.03)
        await adapter.close()
        assert not adapter.running

    asyncio.run(exercise())


def test_optional_ssh_details_disabled_and_failure_keeps_cache():
    calls: list[str] = []

    async def runner(operation: str):
        calls.append(operation)
        return {
            "ok": True,
            "environment": "production" if operation.endswith("main") else "stage",
            "commit": "a" * 40,
            "branch": "main" if operation.endswith("main") else "stage",
            "deployment_revision": "a" * 40,
            "deployed_at": "2026-07-29T10:00:00Z",
            "working_tree": "clean",
            "observed_at": "2026-07-29T10:00:00Z",
        }

    disabled = AvalarSshDetailsAdapter(
        IntegrationSettings(avalar_ssh_enabled=False),
        command_runner=runner,
    )
    asyncio.run(disabled.refresh())
    assert calls == []

    async def exercise():
        enabled = AvalarSshDetailsAdapter(
            IntegrationSettings(avalar_ssh_enabled=True),
            command_runner=runner,
        )
        await enabled.refresh()
        assert enabled.details_for("avalar-site-main")["details_source"] == "live"

        async def failed(_: str):
            raise asyncio.TimeoutError

        enabled._command_runner = failed
        await enabled.refresh()
        assert enabled.details_for("avalar-site-main")["details_source"] == "stale"

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "payload",
    [
        {"ok": False, "environment": "stage", "working_tree": "clean"},
        {"ok": True, "environment": "invalid", "working_tree": "clean"},
        {"ok": True, "environment": "stage", "working_tree": "unknown"},
    ],
)
def test_ssh_details_reject_invalid_sanitized_payload(payload):
    async def runner(_: str):
        return payload

    adapter = AvalarSshDetailsAdapter(
        IntegrationSettings(avalar_ssh_enabled=True),
        command_runner=runner,
    )
    asyncio.run(adapter.refresh())
    assert adapter.details_for("avalar-site-main") == {}


@pytest.mark.parametrize(
    ("stdout", "stderr", "returncode", "limit"),
    [
        (b"not-json", b"", 0, 1024),
        (b"{}", b"host failure", 255, 1024),
        (b"x" * 33, b"", 0, 32),
    ],
)
def test_ssh_command_rejects_invalid_json_host_failure_and_oversized_output(
    stdout,
    stderr,
    returncode,
    limit,
):
    with pytest.raises(SshDetailsError):
        _parse_command_output(stdout, stderr, returncode, limit)
