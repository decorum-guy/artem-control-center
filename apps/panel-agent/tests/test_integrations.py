from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from panel_agent.home_assistant import (
    CLIMATE_ENTITY,
    COFFEE_ENTITY,
    HomeAssistantAdapter,
)
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


def _climate_state(state: str = "heat"):
    return {
        "entity_id": CLIMATE_ENTITY,
        "state": state,
        "last_changed": "2026-07-29T11:54:09Z",
        "last_updated": "2026-07-29T11:59:30Z",
        "attributes": {
            "temperature": 32,
            "current_temperature": 24,
            "min_temp": 16,
            "max_temp": 32,
            "target_temp_step": 1,
            "hvac_modes": ["off", "heat"],
            "fan_modes": ["one"],
            "fan_mode": "one",
            "supported_features": 1,
        },
    }


class FakeHomeAssistantSocket:
    def __init__(self, received: list[dict], events: list[dict] | None = None) -> None:
        self._received = [json.dumps(message) for message in received]
        self._events = [json.dumps(message) for message in events or []]
        self.sent: list[dict] = []

    async def recv(self) -> str:
        return self._received.pop(0)

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


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


def test_absent_kettle_does_not_degrade_home_assistant_aggregate(tmp_path):
    states = [
        state for state in _ha_states()
        if state["entity_id"] not in {
            "water_heater.chainik",
            "switch.chainik_podderzhanie_tepla",
            "switch.chainik_podsvetka",
            "switch.chainik_bez_zvuka",
        }
    ]
    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
        ),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=states)),
    )

    asyncio.run(adapter.fetch_initial_snapshot())
    services = {service.id: service for service in adapter.services()}

    assert services["home-assistant"].health == "healthy"
    assert services["home-assistant"].data["missingEntities"] == []
    assert services["kettle"].health == "offline"


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


def test_external_climate_state_reaches_panel_snapshot_without_panel_action(tmp_path):
    states = [*_ha_states(), _climate_state()]
    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
        ),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=states)),
    )
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=adapter.services,
    )
    adapter.set_on_change(publisher.rebuild)

    async def exercise():
        await adapter.fetch_initial_snapshot()
        initial = publisher.snapshot
        assert initial is not None
        initial_climate = next(service for service in initial.services if service.id == "climate-main")
        assert initial_climate.data["state"] == "heat"
        initial_revision = initial.revision

        changed = _climate_state("off")
        changed["last_updated"] = "2026-07-29T12:00:00Z"
        assert await adapter.apply_state_changed(CLIMATE_ENTITY, changed)

        updated = publisher.snapshot
        assert updated is not None
        updated_climate = next(service for service in updated.services if service.id == "climate-main")
        assert updated.revision > initial_revision
        assert updated_climate.data["state"] == "off"

    asyncio.run(exercise())


def test_bounded_ha_reconciliation_recovers_missed_external_climate_update(tmp_path):
    states = [*_ha_states(), _climate_state()]

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=states)

    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
        ),
        transport=httpx.MockTransport(handler),
    )
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=adapter.services,
    )
    adapter.set_on_change(publisher.rebuild)

    async def exercise():
        await adapter.fetch_initial_snapshot()
        initial_revision = publisher.revision
        states[-1] = _climate_state("off")
        states[-1]["last_updated"] = "2026-07-29T12:00:00Z"

        # This is the same bounded REST reconciliation used by the shared HA
        # staleness watcher after a missed WebSocket event.
        await adapter.fetch_initial_snapshot()

        updated = publisher.snapshot
        assert updated is not None
        climate = next(service for service in updated.services if service.id == "climate-main")
        assert updated.revision > initial_revision
        assert climate.data["state"] == "off"

    asyncio.run(exercise())


def test_http_adapter_preserves_alice_without_materializing_avalar():
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
    )
    asyncio.run(adapter.refresh())
    services = {service.id: service for service in adapter.services()}

    assert set(services) == {"alice-tg-bot"}
    assert "avalar-site-main" not in services
    assert "avalar-site-stage" not in services
    assert services["alice-tg-bot"].data["coffeeTimingAuthority"] is False


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
            alice_health_url="https://bot.test",
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


def _websocket_adapter(tmp_path, *, voice: bool = False) -> HomeAssistantAdapter:
    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test",
            ha_token="test-token",
            state_cache_path=str(tmp_path / "ha-cache.json"),
            rog_g703_alice_enabled=voice,
        ),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=_ha_states())),
    )
    if voice:
        async def ignored(_: dict) -> None: pass
        adapter.set_yandex_intent_handler(ignored)
    return adapter


def _subscription_acks() -> list[dict]:
    return [
        {"type": "result", "id": 1, "success": True},
        {"type": "result", "id": 2, "success": True},
    ]


def test_ha_websocket_with_voice_gate_off_subscribes_only_core_state(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path)
    socket = FakeHomeAssistantSocket(_subscription_acks())
    asyncio.run(adapter._subscribe_socket(socket))

    assert socket.sent == [{"id": 1, "type": "subscribe_events", "event_type": "state_changed"}]
    assert adapter._websocket_connected is True
    assert adapter._yandex_intent_status == "disabled"


def test_ha_websocket_accepts_interleaved_state_event_during_subscription_setup(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)
    applied = 0
    original_apply = adapter.apply_state_changed

    async def count_apply(entity_id: str, new_state: dict) -> bool:
        nonlocal applied
        applied += 1
        return await original_apply(entity_id, new_state)

    adapter.apply_state_changed = count_apply  # type: ignore[method-assign]
    changed_coffee = next(item for item in _ha_states() if item["entity_id"] == COFFEE_ENTITY)
    changed_coffee = dict(changed_coffee, state="off")
    socket = FakeHomeAssistantSocket(
        [
            {"type": "result", "id": 1, "success": True},
            {
                "type": "event",
                "event": {
                    "event_type": "state_changed",
                    "data": {"entity_id": COFFEE_ENTITY, "new_state": changed_coffee},
                },
            },
            {"type": "result", "id": 2, "success": True},
        ]
    )
    asyncio.run(adapter._subscribe_socket(socket))

    assert adapter._websocket_connected is True
    assert adapter._yandex_intent_subscribed is True
    assert adapter._yandex_intent_status == "subscribed"
    assert adapter.mutation_entity_state(COFFEE_ENTITY) == "off"
    assert applied == 1
    assert socket.sent == [
        {"id": 1, "type": "subscribe_events", "event_type": "state_changed"},
        {"id": 2, "type": "subscribe_events", "event_type": "yandex_intent"},
    ]


def test_ha_websocket_requires_state_changed_before_optional_voice_setup(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)
    socket = FakeHomeAssistantSocket(
        [
            {"type": "result", "id": 2, "success": True},
            {"type": "result", "id": 1, "success": True},
        ]
    )
    with pytest.raises(ValueError, match="Unexpected"):
        asyncio.run(adapter._subscribe_socket(socket))


def test_ha_websocket_delivers_interleaved_yandex_intent_once_after_setup(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)
    received: list[dict] = []

    async def yandex_handler(event_data: dict) -> None:
        received.append(event_data)

    adapter.set_yandex_intent_handler(yandex_handler)
    event_data = {"command": "включи асус"}
    socket = FakeHomeAssistantSocket(
        [
            {"type": "result", "id": 1, "success": True},
            {"type": "event", "event": {"event_type": "yandex_intent", "data": event_data}},
            {"type": "result", "id": 2, "success": True},
        ]
    )
    asyncio.run(adapter._subscribe_socket(socket))

    assert received == [event_data]


def test_optional_yandex_unauthorized_keeps_core_and_actions_live(tmp_path) -> None:
    adapter = HomeAssistantAdapter(
        IntegrationSettings(
            ha_url="http://ha.test", ha_token="test-token", state_cache_path=str(tmp_path / "ha-cache.json"),
            writes_enabled=True, coffee_actions_enabled=True, alice_base_url="http://alice.test",
            alice_control_center_token="private", home_climate_actions_enabled=True,
            rog_g703_psu_actions_enabled=True, rog_g703_alice_enabled=True,
        ),
        panel_mode="fixtures",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=_ha_states())),
    )
    async def ignored(_: dict) -> None: pass
    adapter.set_yandex_intent_handler(ignored)
    socket = FakeHomeAssistantSocket([
        {"type": "result", "id": 1, "success": True},
        {"type": "result", "id": 2, "success": False, "error": {"code": "unauthorized", "message": "Unauthorized"}},
    ])
    asyncio.run(adapter._subscribe_socket(socket))
    home = {service.id: service for service in adapter.services()}["home-assistant"]
    assert adapter._websocket_connected and adapter._snapshot_confirmed_for_transport
    assert home.source == "live" and adapter.coffee_action_allowed("turn_off")
    assert adapter._yandex_intent_subscribed is False
    assert home.data["transport"]["yandexIntentStatus"] == "unauthorized"
    assert adapter._climate_action_descriptor_enabled(True)
    assert adapter._psu_action_descriptor_enabled(True)
    assert "Unauthorized" not in json.dumps(home.data)


def test_state_changed_subscription_failure_is_a_core_failure(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)
    socket = FakeHomeAssistantSocket([{"type": "result", "id": 1, "success": False}])
    with pytest.raises(ValueError, match="subscription failed"):
        asyncio.run(adapter._subscribe_socket(socket))
    assert adapter._websocket_connected is False


def test_ha_websocket_routes_state_and_yandex_without_affecting_state_cache(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)
    received: list[dict] = []

    async def yandex_handler(event_data: dict) -> None:
        received.append(event_data)

    adapter.set_yandex_intent_handler(yandex_handler)
    changed_coffee = next(item for item in _ha_states() if item["entity_id"] == COFFEE_ENTITY)
    changed_coffee = dict(changed_coffee, state="off")
    socket = FakeHomeAssistantSocket(
        _subscription_acks(),
        [
            {"type": "event", "event": {"event_type": "yandex_intent", "data": {"command": "включи асус"}}},
            {"type": "event", "event": {"event_type": "state_changed", "data": {"entity_id": COFFEE_ENTITY, "new_state": changed_coffee}}},
            {"type": "event", "event": {"event_type": "yandex_intent", "data": {"command": "напомни мне через час"}}},
        ],
    )
    asyncio.run(adapter._subscribe_socket(socket))

    assert received == [
        {"command": "включи асус"},
        {"command": "напомни мне через час"},
    ]
    assert adapter.mutation_entity_state(COFFEE_ENTITY) == "off"
    assert "command" not in adapter._states[COFFEE_ENTITY]


def test_ha_websocket_recovers_both_subscriptions_and_handler_failure_keeps_state_stream(tmp_path) -> None:
    adapter = _websocket_adapter(tmp_path, voice=True)

    async def broken_handler(_: dict) -> None:
        raise RuntimeError("private utterance must not escape")

    adapter.set_yandex_intent_handler(broken_handler)
    changed_coffee = next(item for item in _ha_states() if item["entity_id"] == COFFEE_ENTITY)
    changed_coffee = dict(changed_coffee, state="off")
    first = FakeHomeAssistantSocket(
        _subscription_acks(),
        [
            {"type": "event", "event": {"event_type": "yandex_intent", "data": {"command": "включи асус"}}},
            {"type": "event", "event": {"event_type": "state_changed", "data": {"entity_id": COFFEE_ENTITY, "new_state": changed_coffee}}},
            {"type": "event", "event": {"event_type": "yandex_intent", "data": "malformed"}},
        ],
    )
    second = FakeHomeAssistantSocket(_subscription_acks())

    async def exercise() -> None:
        await adapter._subscribe_socket(first)
        assert adapter.mutation_entity_state(COFFEE_ENTITY) == "off"
        await adapter._mark_websocket_disconnected()
        assert adapter._websocket_connected is False
        assert adapter._yandex_intent_subscribed is False
        await adapter._subscribe_socket(second)

    asyncio.run(exercise())
    assert first.sent == second.sent == [
        {"id": 1, "type": "subscribe_events", "event_type": "state_changed"},
        {"id": 2, "type": "subscribe_events", "event_type": "yandex_intent"},
    ]


def test_fixed_yandex_response_event_has_no_caller_selected_event_or_payload(tmp_path) -> None:
    calls: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={})

    adapter = HomeAssistantAdapter(
        IntegrationSettings(ha_url="http://ha.test", ha_token="test-token"),
        transport=httpx.MockTransport(handler),
    )
    asyncio.run(adapter.respond_to_yandex_intent("Включаю ASUS."))

    assert calls == [
        ("/api/events/yandex_intent_response", {"text": "Включаю ASUS.", "end_session": True})
    ]
