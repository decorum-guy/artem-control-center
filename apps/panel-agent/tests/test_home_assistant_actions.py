from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.home_assistant import (
    CLIMATE_ENTITY,
    KETTLE_ENTITY,
    KETTLE_TEA_MODES,
    WATCHED_ENTITIES,
    REQUIRED_ENTITIES,
    PSU_1_ENTITY,
    PSU_2_ENTITY,
    HomeAssistantAdapter,
    _sanitize_state,
)
from panel_agent.home_assistant_actions import (
    ALL_ACTION_IDS,
    KETTLE_TEA_TEMPERATURES,
    HomeAssistantActionExecutor,
    HomeAssistantActionRequest,
    build_home_assistant_action_router,
)
from panel_agent.settings import IntegrationSettings


KETTLE_PROVIDER = json.loads((Path(__file__).parent / "fixtures/kettle_yandex_station.json").read_text())
KETTLE_COMMAND_TIME = datetime(2026, 9, 30, 18, 15, 55, tzinfo=timezone.utc)


def kettle_heating() -> dict:
    return {"entity_id": KETTLE_ENTITY, **copy.deepcopy(KETTLE_PROVIDER["green_tea_heating"])}


def entity(entity_id: str, state: str, attributes: dict | None = None) -> dict:
    return {
        "entity_id": entity_id,
        "state": state,
        "last_changed": "2026-09-08T10:00:00Z",
        "last_updated": "2026-09-08T10:00:00Z",
        "attributes": attributes or {},
    }


def base_states(
    *,
    climate_state: str = "off",
    climate_attributes: dict | None = None,
    bp1: str = "off",
    bp2: str = "off",
    include_climate: bool = True,
    include_psu: bool = True,
) -> dict[str, dict]:
    states = {
        "switch.kofemashina": entity("switch.kofemashina", "off"),
        "input_number.coffee_warmup_minutes": entity("input_number.coffee_warmup_minutes", "10"),
        "input_number.coffee_long_running_minutes": entity("input_number.coffee_long_running_minutes", "60"),
        "input_datetime.coffee_last_turned_on": entity("input_datetime.coffee_last_turned_on", "unknown"),
        "input_boolean.coffee_timing_initialized": entity("input_boolean.coffee_timing_initialized", "on"),
        "water_heater.kukhnia_chainik": entity("water_heater.kukhnia_chainik", "off", {"current_temperature": 61, "temperature": 100, "operation_mode": "off", "operation_list": ["on", "off", "white_tea", "green_tea", "red_tea", "herbal_tea", "flower_tea", "puerh_tea", "oolong_tea", "black_tea"]}),
    }
    if include_climate:
        states[CLIMATE_ENTITY] = entity(
            CLIMATE_ENTITY,
            climate_state,
            {
                "hvac_modes": ["cool", "heat", "fan_only", "dry", "auto", "off"],
                "fan_modes": ["one", "two", "three", "four", "five"],
                "min_temp": 16,
                "max_temp": 32,
                "target_temp_step": 1,
                "temperature": 22,
                "current_temperature": 23.5,
                "fan_mode": "two",
                "supported_features": 7,
                **(climate_attributes or {}),
            },
        )
    if include_psu:
        states[PSU_1_ENTITY] = entity(PSU_1_ENTITY, bp1, {"watts": 999})
        states[PSU_2_ENTITY] = entity(PSU_2_ENTITY, bp2, {"watts": 888})
    return states


class HomeAssistantStub:
    def __init__(self, states: dict[str, dict], *, mutate: bool = True) -> None:
        self.states = states
        self.mutate = mutate
        self.calls: list[tuple[str, dict]] = []
        self.events: list[tuple[str, str]] = []
        self.blocked_entities: set[str] = set()
        self.service_failures: dict[str, tuple[int, str]] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != "Bearer test-token":
            return httpx.Response(401, json={"message": "unauthorized"})
        if request.method == "GET" and request.url.path == "/api/states":
            self.events.append(("get", request.url.path))
            return httpx.Response(200, json=list(self.states.values()))
        if request.method == "GET" and request.url.path.startswith("/api/states/"):
            self.events.append(("get", request.url.path))
            entity_id = request.url.path.removeprefix("/api/states/")
            state = self.states.get(entity_id)
            return httpx.Response(200, json=state) if state else httpx.Response(404, json={})
        if request.method == "POST" and request.url.path.startswith("/api/services/"):
            self.events.append(("post", request.url.path))
            body = json.loads(request.content.decode("utf-8"))
            self.calls.append((request.url.path, body))
            failure = self.service_failures.get(request.url.path)
            if failure is not None:
                status_code, response_body = failure
                return httpx.Response(status_code, text=response_body)
            if self.mutate:
                self._apply(request.url.path, body)
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={})

    def _apply(self, path: str, body: dict) -> None:
        entity_id = body.get("entity_id")
        if entity_id in self.blocked_entities or entity_id not in self.states:
            return
        state = self.states[entity_id]
        if path.endswith("/climate/turn_on"):
            state["state"] = "cool"
        elif path.endswith("/climate/turn_off"):
            state["state"] = "off"
        elif path.endswith("/climate/set_temperature"):
            state.setdefault("attributes", {})["temperature"] = body["temperature"]
        elif path.endswith("/climate/set_hvac_mode"):
            state["state"] = body["hvac_mode"]
        elif path.endswith("/climate/set_fan_mode"):
            state.setdefault("attributes", {})["fan_mode"] = body["fan_mode"]
        elif path.endswith("/water_heater/set_temperature"):
            state.setdefault("attributes", {})["temperature"] = body["temperature"]
        elif path.endswith("/water_heater/set_operation_mode"):
            mode = body["operation_mode"]
            if mode in KETTLE_PROVIDER["tea_targets"]:
                state.setdefault("attributes", {})["temperature"] = KETTLE_PROVIDER["tea_targets"][mode]
                mode = "on"
            state.setdefault("attributes", {})["operation_mode"] = mode
            state["state"] = mode
            state["last_updated"] = "2026-09-30T18:15:56.863521+00:00"
        elif path.endswith("/switch/turn_on"):
            state["state"] = "on"
        elif path.endswith("/switch/turn_off"):
            state["state"] = "off"


class VerificationClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    async def sleep(self, seconds: float) -> None:
        self.value += seconds
        await asyncio.sleep(0)


class DatetimeClock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **kwargs: int) -> None:
        self.value += timedelta(**kwargs)


def make_stack(
    tmp_path: Path,
    server: HomeAssistantStub | None = None,
    *,
    climate_gate: bool = True,
    psu_gate: bool = True,
    kettle_gate: bool = True,
    writes: bool = True,
    profile: str = "standard",
    gate_provider=None,
) -> tuple[HomeAssistantStub, HomeAssistantAdapter, AccessPolicyStore, HomeAssistantActionExecutor]:
    stub = server or HomeAssistantStub(base_states())
    transport = httpx.MockTransport(stub)
    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
        writes_enabled=writes,
        home_climate_actions_enabled=climate_gate,
        kettle_actions_enabled=kettle_gate,
        rog_g703_psu_actions_enabled=psu_gate,
        ha_stale_after_seconds=90,
    )
    adapter = HomeAssistantAdapter(settings, panel_mode="production", transport=transport)
    asyncio.run(adapter.fetch_initial_snapshot())
    access = AccessPolicyStore(tmp_path / "access-policy.json")
    access.set_profile(profile)  # type: ignore[arg-type]
    clock = VerificationClock()
    executor = HomeAssistantActionExecutor(
        settings,
        access,
        adapter,
        transport=transport,
        sleep=clock.sleep,
        clock=clock,
        verification_timeout=1.0,
        verification_interval=0.25,
        gate_provider=gate_provider,
        utcnow=lambda: KETTLE_COMMAND_TIME,
    )
    return stub, adapter, access, executor


def request(action_id: str, **values: object) -> HomeAssistantActionRequest:
    return HomeAssistantActionRequest(actionId=action_id, requestId=uuid4(), **values)


def run(coroutine):
    return asyncio.run(coroutine)


def test_settings_action_gates_are_false_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "PANEL_WRITES_ENABLED",
        "PANEL_HOME_CLIMATE_ACTIONS_ENABLED",
        "PANEL_ROG_G703_PSU_ACTIONS_ENABLED",
    ):
        monkeypatch.delenv(key, raising=False)
    settings = IntegrationSettings.from_env()
    assert settings.writes_enabled is False
    assert settings.home_climate_actions_enabled is False
    assert settings.rog_g703_psu_actions_enabled is False


def test_sanitization_is_typed_and_drops_climate_and_psu_metadata() -> None:
    climate = _sanitize_state(
        CLIMATE_ENTITY,
        entity(
            CLIMATE_ENTITY,
            "heating",
            {
                "hvac_modes": ["cool", "heat", "secret"],
                "fan_modes": ["one", "auto", "five"],
                "min_temp": 16,
                "max_temp": 32,
                "target_temp_step": 1,
                "temperature": 40,
                "current_temperature": None,
                "fan_mode": "auto",
                "supported_features": 7,
                "friendly_name": "private",
                "secret_token": "must-drop",
            },
        ),
    )
    assert climate["state"] == "unknown"
    assert climate["attributes"] == {
        "hvac_modes": ["cool", "heat"],
        "min_temp": 16,
        "max_temp": 32,
        "target_temp_step": 1,
        "fan_modes": ["one", "five"],
        "current_temperature": None,
        "supported_features": 7,
    }

    psu = _sanitize_state(
        PSU_1_ENTITY,
        entity(PSU_1_ENTITY, "on", {"watts": 120, "voltage": 19, "secret": "drop"}),
    )
    assert psu["state"] == "on"
    assert psu["attributes"] == {}
    assert set(psu) == {"entity_id", "state", "last_changed", "last_updated", "attributes"}


def test_optional_entities_do_not_degrade_aggregate_health(tmp_path: Path) -> None:
    states = base_states(include_climate=False, include_psu=False)
    _, adapter, _, _ = make_stack(tmp_path, HomeAssistantStub(states))
    services = {service.id: service for service in adapter.services()}
    assert services["home-assistant"].health == "healthy"
    assert services["home-assistant"].data["missingEntities"] == []
    assert services["climate-main"].enabled is False
    assert services["rog-g703-psu"].enabled is False


def test_targeted_entity_read_preserves_full_snapshot_provenance(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states())
    transport = httpx.MockTransport(server)
    clock = DatetimeClock(datetime(2026, 9, 8, 12, tzinfo=timezone.utc))
    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
        ha_stale_after_seconds=90,
    )
    adapter = HomeAssistantAdapter(
        settings,
        panel_mode="production",
        transport=transport,
        clock=clock,
    )

    run(adapter.fetch_initial_snapshot())
    full_observed_at = adapter._observed_at
    full_rest_at = adapter._last_successful_rest_at
    assert full_observed_at is not None
    assert full_rest_at is not None
    assert adapter._snapshot_confirmed_for_transport is True
    assert adapter._source == "live"

    run(adapter._mark_websocket_disconnected())
    clock.advance(seconds=91)
    before = {service.id: service for service in adapter.services()}
    assert before["home-assistant"].health == "stale"
    assert before["home-assistant"].source == "stale"
    assert before["climate-main"].health == "stale"
    assert before["coffee-machine"].health == "stale"

    server.states[CLIMATE_ENTITY]["attributes"]["temperature"] = 21
    fresh = run(adapter.fetch_entity(CLIMATE_ENTITY))
    assert fresh["attributes"]["temperature"] == 21
    assert adapter.mutation_entity_state(CLIMATE_ENTITY) == "off"
    assert adapter._observed_at == full_observed_at
    assert adapter._last_successful_rest_at == full_rest_at
    assert adapter._snapshot_confirmed_for_transport is False
    assert adapter._source == "cached"
    assert adapter.mutation_transport_available() is False

    after = {service.id: service for service in adapter.services()}
    assert after["home-assistant"].source == "stale"
    assert after["home-assistant"].health == "stale"
    assert after["climate-main"].data["targetTemperature"] == 21
    assert after["climate-main"].data["stale"] is True
    assert after["coffee-machine"].data["machine"]["stale"] is True


@pytest.mark.parametrize(
    ("bp1", "bp2", "mode"),
    [("on", "on", "full"), ("on", "off", "normal"), ("off", "on", "secondary_only"), ("off", "off", "off")],
)
def test_psu_service_has_exact_bounded_mode(tmp_path: Path, bp1: str, bp2: str, mode: str) -> None:
    _, adapter, _, _ = make_stack(tmp_path, HomeAssistantStub(base_states(bp1=bp1, bp2=bp2)))
    service = {item.id: item for item in adapter.services()}["rog-g703-psu"]
    assert service.data["mode"] == mode
    assert service.data["psu1"]["state"] == bp1
    assert service.data["psu2"]["state"] == bp2
    assert "watts" not in json.dumps(service.data)


def test_request_schema_rejects_extra_fields_and_invalid_temperature_or_fan() -> None:
    base = {"actionId": "home.climate.set_temperature", "requestId": str(uuid4()), "temperature": 22}
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(**{**base, "entity_id": CLIMATE_ENTITY})
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(**{**base, "temperature": 15})
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(
            actionId="home.climate.set_fan_mode",
            requestId=uuid4(),
            fanMode="auto",
        )


@pytest.mark.parametrize("temperature", [16, 32])
def test_request_schema_accepts_temperature_boundaries(temperature: int) -> None:
    payload = HomeAssistantActionRequest(
        actionId="home.climate.set_temperature",
        requestId=uuid4(),
        temperature=temperature,
    )
    assert payload.temperature == temperature


@pytest.mark.parametrize("temperature", [15, 33, 22.5])
def test_request_schema_rejects_out_of_range_or_non_integral_temperature(
    temperature: object,
) -> None:
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(
            actionId="home.climate.set_temperature",
            requestId=uuid4(),
            temperature=temperature,
        )


def test_request_schema_rejects_arbitrary_action_id() -> None:
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(actionId="device.control", requestId=uuid4())


@pytest.mark.parametrize("extra_field", ["entity_id", "entityId", "domain", "service"])
def test_request_schema_rejects_generic_proxy_fields(extra_field: str) -> None:
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(
            actionId="home.climate.power_on",
            requestId=uuid4(),
            **{extra_field: "not-accepted"},
        )


@pytest.mark.parametrize(
    ("action_id", "field", "value"),
    [
        (action_id, field, value)
        for action_id in (
            "home.climate.power_on",
            "home.climate.power_off",
            "system.rog_g703.psu.mode.normal",
            "system.rog_g703.psu.mode.full",
            "system.rog_g703.psu.bp1.on",
            "system.rog_g703.psu.bp1.off",
            "system.rog_g703.psu.bp2.on",
            "system.rog_g703.psu.bp2.off",
        )
        for field, value in (
            ("temperature", 22),
            ("mode", "cool"),
            ("fanMode", "one"),
        )
    ],
)
def test_request_schema_rejects_values_for_no_value_actions(
    action_id: str,
    field: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(
            actionId=action_id,
            requestId=uuid4(),
            **{field: value},
        )


@pytest.mark.parametrize(
    ("action_id", "accepted_field", "wrong_field", "wrong_value"),
    [
        ("home.climate.set_temperature", "temperature", "mode", "cool"),
        ("home.climate.set_temperature", "temperature", "fanMode", "one"),
        ("home.climate.set_mode", "mode", "temperature", 22),
        ("home.climate.set_mode", "mode", "fanMode", "one"),
        ("home.climate.set_fan_mode", "fanMode", "temperature", 22),
        ("home.climate.set_fan_mode", "fanMode", "mode", "cool"),
    ],
)
def test_request_schema_rejects_mismatched_optional_fields(
    action_id: str,
    accepted_field: str,
    wrong_field: str,
    wrong_value: object,
) -> None:
    accepted_value: object = {
        "temperature": 22,
        "mode": "cool",
        "fanMode": "one",
    }[accepted_field]
    with pytest.raises(ValidationError):
        HomeAssistantActionRequest(
            actionId=action_id,
            requestId=uuid4(),
            **{accepted_field: accepted_value, wrong_field: wrong_value},
        )


def test_action_router_exposes_only_fixed_action_catalog(tmp_path: Path) -> None:
    _, _, _, executor = make_stack(tmp_path)
    app = FastAPI()
    home_assistant_router = build_home_assistant_action_router(executor)
    app.include_router(home_assistant_router)
    client = TestClient(app)

    availability = client.get("/api/v1/actions/home-assistant/availability")
    assert availability.status_code == 200
    assert tuple(availability.json()["actions"]) == ALL_ACTION_IDS
    assert availability.headers["cache-control"] == "no-store"
    invalid = client.post(
        "/api/v1/actions/home-assistant",
        json={
            "actionId": "home.climate.power_on",
            "requestId": str(uuid4()),
            "entityId": CLIMATE_ENTITY,
        },
    )
    assert invalid.status_code == 422
    child_route = client.get(
        "/api/v1/actions/home-assistant/not-a-real-action-route"
    )
    assert child_route.status_code == 404
    paths = {
        path
        for route in app.routes
        if isinstance((path := getattr(route, "path", None)), str)
    }
    if not {
        "/api/v1/actions/home-assistant",
        "/api/v1/actions/home-assistant/availability",
    }.issubset(paths):
        paths = {
            path
            for route in home_assistant_router.routes
            if isinstance((path := getattr(route, "path", None)), str)
        }
    assert "/api/v1/actions/home-assistant" in paths
    assert "/api/v1/actions/home-assistant/availability" in paths
    assert "/api/v1/actions/home-assistant/{entity_id}" not in paths


def test_climate_actions_use_fixed_service_calls_and_idempotence(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server, _, _, executor = make_stack(tmp_path, server)

    first = run(executor.execute(request("home.climate.power_on")))
    assert first["status"] == "confirmed"
    assert first["actionId"] == "home.climate.power_on"
    assert server.calls[-1] == ("/api/services/climate/turn_on", {"entity_id": CLIMATE_ENTITY})

    server.calls.clear()
    second = run(executor.execute(request("home.climate.power_on")))
    assert second["climate"]["state"] == "cool"
    assert not server.calls

    run(executor.execute(request("home.climate.set_temperature", temperature=16)))
    run(executor.execute(request("home.climate.set_mode", mode="heat")))
    run(executor.execute(request("home.climate.set_fan_mode", fanMode="five")))
    assert [path for path, _ in server.calls] == [
        "/api/services/climate/set_temperature",
        "/api/services/climate/set_hvac_mode",
        "/api/services/climate/set_fan_mode",
    ]
    assert server.calls[0][1] == {"entity_id": CLIMATE_ENTITY, "temperature": 16}
    assert server.calls[1][1] == {"entity_id": CLIMATE_ENTITY, "hvac_mode": "heat"}
    assert server.calls[2][1] == {"entity_id": CLIMATE_ENTITY, "fan_mode": "five"}


@pytest.mark.parametrize(
    ("initial_state", "action_id", "expected_calls"),
    [
        (
            "cool",
            "home.climate.power_off",
            [("/api/services/climate/turn_off", {"entity_id": CLIMATE_ENTITY})],
        ),
        ("off", "home.climate.power_off", []),
        ("heat", "home.climate.power_on", []),
    ],
)
def test_climate_power_edges_are_idempotent_and_fixed(
    tmp_path: Path,
    initial_state: str,
    action_id: str,
    expected_calls: list[tuple[str, dict]],
) -> None:
    server = HomeAssistantStub(base_states(climate_state=initial_state))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request(action_id)))
    assert result["status"] == "confirmed"
    assert server.calls == expected_calls


@pytest.mark.parametrize("mode", ["cool", "heat", "fan_only", "dry", "auto", "off"])
def test_climate_hvac_modes_use_exact_fixed_service_and_readback(
    tmp_path: Path,
    mode: str,
) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("home.climate.set_mode", mode=mode)))
    assert result["status"] == "confirmed"
    if mode == "off":
        assert server.calls == [
            ("/api/services/climate/turn_off", {"entity_id": CLIMATE_ENTITY})
        ]
    else:
        assert server.calls == [
            (
                "/api/services/climate/set_hvac_mode",
                {"entity_id": CLIMATE_ENTITY, "hvac_mode": mode},
            )
        ]


@pytest.mark.parametrize("fan_mode", ["one", "two", "three", "four", "five"])
def test_climate_fan_modes_use_exact_fixed_service_and_readback(
    tmp_path: Path,
    fan_mode: str,
) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("home.climate.set_fan_mode", fanMode=fan_mode)))
    assert result["status"] == "confirmed"
    assert server.calls == [
        (
            "/api/services/climate/set_fan_mode",
            {"entity_id": CLIMATE_ENTITY, "fan_mode": fan_mode},
        )
    ]


@pytest.mark.parametrize("temperature", [16, 32])
def test_climate_temperature_boundaries_use_exact_service_and_readback(
    tmp_path: Path,
    temperature: int,
) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(
        executor.execute(
            request("home.climate.set_temperature", temperature=temperature)
        )
    )
    assert result["status"] == "confirmed"
    assert server.calls == [
        (
            "/api/services/climate/set_temperature",
            {"entity_id": CLIMATE_ENTITY, "temperature": temperature},
        )
    ]


def test_climate_timeout_is_not_reported_as_success(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"), mutate=False)
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("home.climate.power_on")))
    assert error.value.status_code == 504
    assert error.value.detail == "ha_verification_timeout"


def test_action_gates_and_access_profile_fail_closed(tmp_path: Path) -> None:
    _, _, _, gated = make_stack(tmp_path, climate_gate=False)
    climate_action = gated.availability()["actions"]["home.climate.power_on"]
    assert climate_action["availability"] == "gate_disabled"
    with pytest.raises(HTTPException) as gate_error:
        run(gated.execute(request("home.climate.power_on")))
    assert gate_error.value.detail == "ha_action_disabled"

    _, _, _, read_only = make_stack(tmp_path / "read-only", profile="read_only")
    assert read_only.availability()["actions"]["home.climate.power_on"]["availability"] == "profile_blocked"
    with pytest.raises(HTTPException) as access_error:
        run(read_only.execute(request("home.climate.power_on")))
    assert access_error.value.detail == "profile_blocked"

    _, _, _, writes_disabled = make_stack(tmp_path / "writes-disabled", writes=False)
    assert writes_disabled.availability()["actions"]["home.climate.power_on"]["availability"] == "gate_disabled"
    with pytest.raises(HTTPException) as writes_error:
        run(writes_disabled.execute(request("home.climate.power_on")))
    assert writes_error.value.detail == "ha_action_disabled"


def test_effective_owner_gate_provider_changes_climate_and_psu_availability_without_restart(tmp_path: Path) -> None:
    gates = {
        "home_climate_actions": False,
        "kettle_actions": False,
        "rog_g703_psu_actions": False,
    }
    provider = lambda capability_id: gates[capability_id]
    _, _, _, executor = make_stack(tmp_path, climate_gate=False, psu_gate=False, gate_provider=provider)

    assert executor.availability()["actions"]["home.climate.power_on"]["availability"] == "gate_disabled"
    assert executor.availability()["actions"]["home.kettle.boil"]["availability"] == "gate_disabled"
    assert executor.availability()["actions"]["system.rog_g703.psu.mode.full"]["availability"] == "gate_disabled"

    gates["home_climate_actions"] = True
    gates["kettle_actions"] = True
    gates["rog_g703_psu_actions"] = True
    assert executor.availability()["actions"]["home.climate.power_on"]["availability"] == "allowed"
    assert executor.availability()["actions"]["home.kettle.boil"]["availability"] == "allowed"
    assert executor.availability()["actions"]["system.rog_g703.psu.mode.full"]["availability"] == "allowed"

    _, _, _, writes_disabled = make_stack(
        tmp_path / "global-writes-off",
        climate_gate=False,
        psu_gate=False,
        writes=False,
        gate_provider=lambda _capability_id: True,
    )
    assert writes_disabled.availability()["actions"]["home.climate.power_on"]["availability"] == "gate_disabled"
    assert writes_disabled.availability()["actions"]["system.rog_g703.psu.mode.full"]["availability"] == "gate_disabled"


def test_stale_or_disconnected_global_transport_blocks_new_mutation(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states())
    _, adapter, _, executor = make_stack(tmp_path, server)
    run(adapter._mark_websocket_disconnected())
    assert adapter.mutation_transport_available() is False
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("home.climate.power_on")))
    assert error.value.detail == "ha_integration_unavailable"


def test_service_failure_does_not_leak_sensitive_ha_response_body(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server.service_failures["/api/services/climate/turn_on"] = (
        500,
        "SECRET_HA_BODY_207_179",
    )
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("home.climate.power_on")))
    assert error.value.detail == "ha_service_failed"
    assert "SECRET_HA_BODY_207_179" not in str(error.value)


def test_psu_full_and_normal_sequences_are_ordered_and_confirmed(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    run(executor.execute(request("system.rog_g703.psu.mode.full")))
    assert [body["entity_id"] for path, body in server.calls if path.startswith("/api/services/switch/")] == [PSU_1_ENTITY, PSU_2_ENTITY]

    server.states[PSU_1_ENTITY]["state"] = "on"
    server.states[PSU_2_ENTITY]["state"] = "on"
    server.calls.clear()
    result = run(executor.execute(request("system.rog_g703.psu.mode.normal")))
    assert result["psu"]["mode"] == "normal"
    assert [body["entity_id"] for path, body in server.calls if path.startswith("/api/services/switch/")] == [PSU_2_ENTITY]
    assert server.calls[-1] == ("/api/services/switch/turn_off", {"entity_id": PSU_2_ENTITY})


@pytest.mark.parametrize(
    ("bp1", "bp2", "expected_on_calls"),
    [
        ("on", "off", [PSU_2_ENTITY]),
        ("off", "on", [PSU_1_ENTITY]),
        ("off", "off", [PSU_1_ENTITY, PSU_2_ENTITY]),
        ("on", "on", []),
    ],
)
def test_psu_full_reconciles_only_missing_relays(
    tmp_path: Path,
    bp1: str,
    bp2: str,
    expected_on_calls: list[str],
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("system.rog_g703.psu.mode.full")))
    assert result["status"] == "confirmed"
    assert result["psu"]["mode"] == "full"
    assert [
        body["entity_id"]
        for path, body in server.calls
        if path == "/api/services/switch/turn_on"
    ] == expected_on_calls
    assert not [
        body
        for path, body in server.calls
        if path == "/api/services/switch/turn_off"
    ]


@pytest.mark.parametrize(
    ("bp1", "bp2", "expected_calls"),
    [
        ("on", "on", [PSU_2_ENTITY]),
        ("on", "off", []),
        ("off", "on", [PSU_1_ENTITY, PSU_2_ENTITY]),
    ],
)
def test_psu_normal_reconciles_canonical_bp1_preference(
    tmp_path: Path,
    bp1: str,
    bp2: str,
    expected_calls: list[str],
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("system.rog_g703.psu.mode.normal")))
    assert result["status"] == "confirmed"
    assert result["psu"]["mode"] == "normal"
    assert [
        body["entity_id"]
        for path, body in server.calls
        if path.startswith("/api/services/switch/")
    ] == expected_calls
    if bp1 == "off":
        bp1_on = server.events.index(("post", "/api/services/switch/turn_on"))
        bp1_verify = server.events.index(("get", f"/api/states/{PSU_1_ENTITY}"), bp1_on)
        bp2_off = server.events.index(("post", "/api/services/switch/turn_off"), bp1_verify)
        assert bp1_on < bp1_verify < bp2_off


def test_psu_normal_never_turns_off_bp2_before_bp1_is_confirmed(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="on"))
    server.blocked_entities.add(PSU_1_ENTITY)
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("system.rog_g703.psu.mode.normal")))
    assert error.value.detail == "ha_verification_timeout"
    assert [body["entity_id"] for path, body in server.calls if path.startswith("/api/services/switch/")] == [PSU_1_ENTITY]


def test_psu_last_off_and_unavailable_other_are_blocked_without_service_call(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="on", bp2="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as last_error:
        run(executor.execute(request("system.rog_g703.psu.bp1.off")))
    assert last_error.value.status_code == 409
    assert last_error.value.detail == "last_psu_off_blocked"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]

    server.states[PSU_2_ENTITY]["state"] = "unavailable"
    server.calls.clear()
    with pytest.raises(HTTPException) as unavailable_error:
        run(executor.execute(request("system.rog_g703.psu.bp1.off")))
    assert unavailable_error.value.detail == "last_psu_off_blocked"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]


def test_psu_individual_toggle_is_fixed_and_returns_confirmed_mode(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="off"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("system.rog_g703.psu.bp2.on")))
    assert result["status"] == "confirmed"
    assert result["psu"]["mode"] == "secondary_only"
    assert server.calls[-1] == ("/api/services/switch/turn_on", {"entity_id": PSU_2_ENTITY})


@pytest.mark.parametrize(
    ("action_id", "bp1", "bp2", "target"),
    [
        ("system.rog_g703.psu.bp1.on", "off", "off", PSU_1_ENTITY),
        ("system.rog_g703.psu.bp2.on", "off", "off", PSU_2_ENTITY),
    ],
)
def test_psu_individual_on_supports_both_relays(
    tmp_path: Path,
    action_id: str,
    bp1: str,
    bp2: str,
    target: str,
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request(action_id)))
    assert result["status"] == "confirmed"
    assert server.calls[-1] == (
        "/api/services/switch/turn_on",
        {"entity_id": target},
    )


@pytest.mark.parametrize(
    ("action_id", "bp1", "bp2", "target"),
    [
        ("system.rog_g703.psu.bp1.off", "on", "on", PSU_1_ENTITY),
        ("system.rog_g703.psu.bp2.off", "on", "on", PSU_2_ENTITY),
    ],
)
def test_psu_individual_off_is_allowed_only_with_other_on(
    tmp_path: Path,
    action_id: str,
    bp1: str,
    bp2: str,
    target: str,
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request(action_id)))
    assert result["status"] == "confirmed"
    assert server.calls[-1] == (
        "/api/services/switch/turn_off",
        {"entity_id": target},
    )


@pytest.mark.parametrize(
    ("action_id", "bp1", "bp2"),
    [
        ("system.rog_g703.psu.bp1.off", "on", "off"),
        ("system.rog_g703.psu.bp2.off", "off", "on"),
    ],
)
def test_psu_individual_off_cannot_remove_last_on_source(
    tmp_path: Path,
    action_id: str,
    bp1: str,
    bp2: str,
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request(action_id)))
    assert error.value.detail == "last_psu_off_blocked"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]


@pytest.mark.parametrize(
    ("action_id", "bp1", "bp2"),
    [
        ("system.rog_g703.psu.bp1.off", "off", "unavailable"),
        ("system.rog_g703.psu.bp2.off", "unavailable", "off"),
    ],
)
def test_psu_individual_off_is_idempotent_for_off_target_but_never_unsafe(
    tmp_path: Path,
    action_id: str,
    bp1: str,
    bp2: str,
) -> None:
    server = HomeAssistantStub(base_states(bp1=bp1, bp2=bp2))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request(action_id)))
    assert result["status"] == "confirmed"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]


def test_psu_last_source_off_is_blocked_when_other_is_unknown(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="on", bp2="unknown"))
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("system.rog_g703.psu.bp1.off")))
    assert error.value.detail == "last_psu_off_blocked"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]


def test_psu_off_already_off_is_idempotent_when_other_state_is_unavailable(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="unavailable"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("system.rog_g703.psu.bp1.off")))
    assert result["status"] == "confirmed"
    assert result["psu"]["mode"] == "unavailable"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]


def test_psu_full_partial_failure_keeps_successful_first_relay_on(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="off"))
    server.blocked_entities.add(PSU_2_ENTITY)
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("system.rog_g703.psu.mode.full")))
    assert error.value.detail == "ha_verification_timeout"
    assert server.states[PSU_1_ENTITY]["state"] == "on"
    assert server.states[PSU_2_ENTITY]["state"] == "off"
    assert (
        "/api/services/switch/turn_off",
        {"entity_id": PSU_1_ENTITY},
    ) not in server.calls


def test_psu_normal_partial_failure_keeps_bp1_on_without_rollback(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="on"))
    server.blocked_entities.add(PSU_2_ENTITY)
    server, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as error:
        run(executor.execute(request("system.rog_g703.psu.mode.normal")))
    assert error.value.detail == "ha_verification_timeout"
    assert server.states[PSU_1_ENTITY]["state"] == "on"
    assert server.states[PSU_2_ENTITY]["state"] == "on"
    assert (
        "/api/services/switch/turn_off",
        {"entity_id": PSU_1_ENTITY},
    ) not in server.calls


def test_duplicate_climate_power_on_serializes_and_mutates_once(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(climate_state="off"))
    server, _, _, executor = make_stack(tmp_path, server)

    async def execute_duplicates() -> list[dict]:
        return list(
            await asyncio.gather(
                executor.execute(request("home.climate.power_on")),
                executor.execute(request("home.climate.power_on")),
            )
        )

    results = run(execute_duplicates())
    assert [result["status"] for result in results] == ["confirmed", "confirmed"]
    assert [
        call for call in server.calls
        if call[0] == "/api/services/climate/turn_on"
    ] == [("/api/services/climate/turn_on", {"entity_id": CLIMATE_ENTITY})]


def test_duplicate_psu_full_serializes_and_mutates_missing_relay_once(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="on", bp2="off"))
    server, _, _, executor = make_stack(tmp_path, server)

    async def execute_duplicates() -> list[dict]:
        return list(
            await asyncio.gather(
                executor.execute(request("system.rog_g703.psu.mode.full")),
                executor.execute(request("system.rog_g703.psu.mode.full")),
            )
        )

    results = run(execute_duplicates())
    assert [result["status"] for result in results] == ["confirmed", "confirmed"]
    assert [
        call for call in server.calls
        if call[0] == "/api/services/switch/turn_on"
    ] == [("/api/services/switch/turn_on", {"entity_id": PSU_2_ENTITY})]


def test_climate_and_psu_action_groups_own_distinct_locks(tmp_path: Path) -> None:
    _, _, _, executor = make_stack(tmp_path)

    async def lock_identities() -> tuple[int, int, int, int]:
        climate_on = executor._lock_for("home.climate.power_on")
        climate_mode = executor._lock_for("home.climate.set_mode")
        psu_full = executor._lock_for("system.rog_g703.psu.mode.full")
        psu_bp1 = executor._lock_for("system.rog_g703.psu.bp1.on")
        return id(climate_on), id(climate_mode), id(psu_full), id(psu_bp1)

    climate_on, climate_mode, psu_full, psu_bp1 = run(lock_identities())
    assert climate_on == climate_mode
    assert psu_full == psu_bp1
    assert climate_on != psu_full


def test_kettle_entity_watchlist_and_snapshot_are_sanitized(tmp_path: Path) -> None:
    assert KETTLE_ENTITY == "water_heater.kukhnia_chainik"
    assert "water_heater.chainik" not in WATCHED_ENTITIES
    assert not any(entity.startswith("switch.chainik_") for entity in WATCHED_ENTITIES)
    raw = entity(KETTLE_ENTITY, "on", {
        "current_temperature": 61.5, "temperature": 80, "operation_mode": "on",
        "operation_list": ["off", "black_tea", "green_tea", "unknown", "black_tea"],
        "token": "must-not-expose", "friendly_name": "Private",
    })
    sanitized = _sanitize_state(KETTLE_ENTITY, raw)
    assert sanitized["attributes"] == {
        "current_temperature": 61.5, "temperature": 80, "operation_mode": "on",
        "operation_list": ["green_tea", "black_tea"],
    }
    states = base_states()
    states[KETTLE_ENTITY] = raw
    _, adapter, _, _ = make_stack(tmp_path, HomeAssistantStub(states))
    kettle = next(service for service in adapter.services() if service.id == "kettle")
    assert kettle.data["stage"] == "on"
    assert kettle.data["currentTemperature"] == 61.5
    assert kettle.data["targetTemperature"] == 80
    assert kettle.data["operationMode"] == "on"
    assert kettle.data["availableTeaModes"] == ["green_tea", "black_tea"]
    assert "token" not in json.dumps(kettle.data)
    assert _sanitize_state(KETTLE_ENTITY, entity(KETTLE_ENTITY, "off", {"operation_mode": "off"}))["state"] == "off"
    assert _sanitize_state(KETTLE_ENTITY, entity(KETTLE_ENTITY, "on", {"current_temperature": float("nan"), "temperature": "100", "operation_mode": "evil", "operation_list": ["evil"]}))["attributes"] == {"current_temperature": None, "temperature": None, "operation_mode": None, "operation_list": []}


def test_kettle_request_contract_rejects_arbitrary_fields_and_modes() -> None:
    for field, value in (("temperature", 90), ("entity_id", KETTLE_ENTITY), ("service", "turn_on"), ("mode", "cool"), ("teaMode", "green_tea")):
        with pytest.raises(ValidationError):
            request("home.kettle.boil", **{field: value})
    for mode in ("on", "off", "evil", "GREEN_TEA"):
        with pytest.raises(ValidationError):
            request("home.kettle.set_tea_mode", teaMode=mode)
    for mode in KETTLE_TEA_MODES:
        assert request("home.kettle.set_tea_mode", teaMode=mode).teaMode == mode
    for field in ("temperature", "entity", "entity_id", "entityId", "service", "domain", "operation_mode", "mode", "payload", "command"):
        with pytest.raises(ValidationError):
            request("home.kettle.set_tea_mode", teaMode="green_tea", **{field: 80})


def test_kettle_boil_sequence_readback_and_idempotence(tmp_path: Path) -> None:
    server, _, _, executor = make_stack(tmp_path)
    result = run(executor.execute(request("home.kettle.boil")))
    assert result["status"] == "confirmed"
    assert result["kettle"] == {"operationMode": "on", "currentTemperature": 61, "targetTemperature": 100}
    assert server.calls == [
        ("/api/services/water_heater/set_temperature", {"entity_id": KETTLE_ENTITY, "temperature": 100}),
        ("/api/services/water_heater/set_operation_mode", {"entity_id": KETTLE_ENTITY, "operation_mode": "on"}),
    ]
    assert server.events.index(("get", f"/api/states/{KETTLE_ENTITY}")) < server.events.index(("post", "/api/services/water_heater/set_temperature"))
    assert run(executor.execute(request("home.kettle.boil")))["status"] == "confirmed"
    assert len(server.calls) == 2


def test_kettle_boil_partial_failure_and_readback_never_confirm(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states())
    server.service_failures["/api/services/water_heater/set_operation_mode"] = (500, "private token")
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request("home.kettle.boil")))
    assert failure.value.detail == "ha_service_failed"
    assert "private" not in str(failure.value)
    assert [path for path, _ in server.calls] == ["/api/services/water_heater/set_temperature", "/api/services/water_heater/set_operation_mode"]
    assert server.states[KETTLE_ENTITY]["attributes"]["temperature"] == 100
    assert server.states[KETTLE_ENTITY]["attributes"]["operation_mode"] == "off"
    server2 = HomeAssistantStub(base_states(), mutate=False)
    _, _, _, executor2 = make_stack(tmp_path / "readback", server2)
    with pytest.raises(HTTPException) as timeout:
        run(executor2.execute(request("home.kettle.boil")))
    assert timeout.value.detail == "ha_verification_timeout"
    assert len(server2.calls) == 2


@pytest.mark.parametrize("tea_mode,target", KETTLE_PROVIDER["tea_targets"].items())
def test_kettle_tea_mode_fixed_call_and_fresh_normalized_readback(tmp_path: Path, tea_mode: str, target: int) -> None:
    assert set(KETTLE_TEA_TEMPERATURES) == set(KETTLE_TEA_MODES)
    server, adapter, _, executor = make_stack(tmp_path)
    result = run(executor.execute(request("home.kettle.set_tea_mode", teaMode=tea_mode)))
    assert result["status"] == "confirmed"
    assert result["kettle"]["operationMode"] == "on"
    assert result["kettle"]["targetTemperature"] == target
    assert server.calls == [("/api/services/water_heater/set_operation_mode", {"entity_id": KETTLE_ENTITY, "operation_mode": tea_mode})]
    kettle = next(service for service in adapter.services() if service.id == "kettle")
    assert kettle.data["operationMode"] == "on"
    assert kettle.data["targetTemperature"] == target
    assert run(executor.execute(request("home.kettle.set_tea_mode", teaMode=tea_mode)))["status"] == "confirmed"
    assert len(server.calls) == 1


def test_kettle_tea_mode_timeout_never_claims_success(tmp_path: Path) -> None:
    server2 = HomeAssistantStub(base_states(), mutate=False)
    _, _, _, executor2 = make_stack(tmp_path / "no-readback", server2)
    with pytest.raises(HTTPException) as timeout:
        run(executor2.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert timeout.value.detail == "ha_verification_timeout"
    assert len(server2.calls) == 1
    with pytest.raises(ValidationError):
        request("home.kettle.set_tea_mode", teaMode="untrusted")
    assert len(server2.calls) == 1


class KettleReadbackStub(HomeAssistantStub):
    def __init__(self, readbacks: list[dict]) -> None:
        super().__init__(base_states(), mutate=False)
        self.readbacks = copy.deepcopy(readbacks)
        self.readback_count = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.calls and request.method == "GET" and request.url.path == f"/api/states/{KETTLE_ENTITY}":
            index = min(self.readback_count, len(self.readbacks) - 1)
            self.states[KETTLE_ENTITY] = copy.deepcopy(self.readbacks[index])
            self.readback_count += 1
        return super().__call__(request)


def test_green_tea_physical_readback_and_delayed_normalization(tmp_path: Path) -> None:
    wrong_target = kettle_heating()
    wrong_target["attributes"]["temperature"] = 100
    transient = kettle_heating()
    transient["state"] = "green_tea"
    transient["attributes"]["operation_mode"] = "green_tea"
    server = KettleReadbackStub([base_states()[KETTLE_ENTITY], wrong_target, transient, kettle_heating()])
    _, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert result["status"] == "confirmed"
    assert result["kettle"] == {"operationMode": "on", "currentTemperature": 25, "targetTemperature": 80}
    assert server.readback_count == 4
    assert len(server.calls) == 1


@pytest.mark.parametrize("state,mode,target", [
    ("on", "on", 100), ("on", "on", 65), ("on", "on", None),
    ("on", "green_tea", 80), ("green_tea", "green_tea", 80),
    ("on", "off", 80), ("off", "on", 80),
    ("unknown", "on", 80), ("unavailable", "on", 80),
])
def test_kettle_active_or_symbolic_mode_alone_cannot_confirm(tmp_path: Path, state: str, mode: str, target: int | None) -> None:
    readback = kettle_heating()
    readback["state"] = state
    readback["attributes"].update(operation_mode=mode, temperature=target)
    server = KettleReadbackStub([readback])
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as timeout:
        run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert timeout.value.detail == "ha_verification_timeout"
    assert len(server.calls) == 1


@pytest.mark.parametrize("updated", [
    "2026-09-08T09:59:00Z", "2026-09-08T10:00:00Z",
    "2026-09-30T18:15:54Z", None, "bad", "2026-09-30T18:15:56",
])
def test_kettle_stale_or_invalid_readback_timestamp_cannot_confirm(tmp_path: Path, updated: str | None) -> None:
    readback = kettle_heating()
    readback["last_updated"] = updated
    server = KettleReadbackStub([readback])
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as timeout:
        run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert timeout.value.detail == "ha_verification_timeout"


def test_kettle_attribute_update_confirms_without_last_changed_moving(tmp_path: Path) -> None:
    states = base_states()
    states[KETTLE_ENTITY].update(state="on", last_changed="2026-09-08T10:00:00Z")
    states[KETTLE_ENTITY]["attributes"]["operation_mode"] = "on"
    server = KettleReadbackStub([kettle_heating()])
    server.states = states
    server.readbacks[0]["last_changed"] = "2026-09-08T10:00:00Z"
    _, _, _, executor = make_stack(tmp_path, server)
    assert run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))["status"] == "confirmed"


def test_kettle_readback_must_advance_precommand_timestamp(tmp_path: Path) -> None:
    server = KettleReadbackStub([kettle_heating()])
    server.states[KETTLE_ENTITY]["last_updated"] = "2026-09-30T18:15:56.863521+00:00"
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as timeout:
        run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert timeout.value.detail == "ha_verification_timeout"


def test_kettle_missing_precommand_timestamp_fails_before_mutation(tmp_path: Path) -> None:
    states = base_states()
    states[KETTLE_ENTITY]["last_updated"] = None
    server = HomeAssistantStub(states)
    _, _, _, executor = make_stack(tmp_path, server)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))
    assert failure.value.detail == "ha_invalid_state"
    assert server.calls == []


def test_kettle_cached_matching_program_does_not_replace_fresh_rest(tmp_path: Path) -> None:
    server, adapter, _, executor = make_stack(tmp_path)
    adapter._states[KETTLE_ENTITY] = _sanitize_state(KETTLE_ENTITY, kettle_heating())
    assert run(executor.execute(request("home.kettle.set_tea_mode", teaMode="green_tea")))["status"] == "confirmed"
    assert len(server.calls) == 1


def test_kettle_gate_profile_and_lock_are_independent(tmp_path: Path) -> None:
    _, _, _, executor = make_stack(tmp_path)
    async def check_locks() -> None:
        assert executor._lock_for("home.kettle.boil") is executor._lock_for("home.kettle.set_tea_mode")
        assert executor._lock_for("home.kettle.boil") is not executor._lock_for("home.climate.power_on")
        assert executor._lock_for("home.kettle.boil") is not executor._lock_for("system.rog_g703.psu.bp1.on")
    run(check_locks())
    _, _, _, gated = make_stack(tmp_path / "gate", kettle_gate=False)
    assert gated.availability()["actions"]["home.kettle.boil"]["availability"] == "gate_disabled"
    assert gated.availability()["actions"]["home.climate.power_on"]["allowed"] is True
    _, _, _, read_only = make_stack(tmp_path / "profile", profile="read_only")
    assert read_only.availability()["actions"]["home.kettle.boil"]["availability"] == "profile_blocked"
    _, _, _, writes_off = make_stack(tmp_path / "writes", writes=False)
    assert writes_off.availability()["actions"]["home.kettle.boil"]["availability"] == "gate_disabled"


def test_unknown_kettle_physical_mode_fails_closed_before_service_call(tmp_path: Path) -> None:
    states = base_states()
    states[KETTLE_ENTITY]["state"] = "on"
    states[KETTLE_ENTITY]["attributes"]["operation_mode"] = "vendor_unknown_mode"
    server = HomeAssistantStub(states)
    _, adapter, _, executor = make_stack(tmp_path, server)
    kettle = next(service for service in adapter.services() if service.id == "kettle")
    assert kettle.health == "offline"
    assert kettle.data["operationMode"] is None
    assert executor.availability()["actions"]["home.kettle.boil"]["availability"] == "integration_unavailable"
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request("home.kettle.boil")))
    assert failure.value.detail == "ha_integration_unavailable"
    assert server.calls == []
