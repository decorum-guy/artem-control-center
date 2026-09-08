from __future__ import annotations

import asyncio
import json
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
    REQUIRED_ENTITIES,
    PSU_1_ENTITY,
    PSU_2_ENTITY,
    HomeAssistantAdapter,
    _sanitize_state,
)
from panel_agent.home_assistant_actions import (
    ALL_ACTION_IDS,
    HomeAssistantActionExecutor,
    HomeAssistantActionRequest,
    build_home_assistant_action_router,
)
from panel_agent.settings import IntegrationSettings


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
        "water_heater.chainik": entity("water_heater.chainik", "off"),
        "switch.chainik_podderzhanie_tepla": entity("switch.chainik_podderzhanie_tepla", "off"),
        "switch.chainik_podsvetka": entity("switch.chainik_podsvetka", "off"),
        "switch.chainik_bez_zvuka": entity("switch.chainik_bez_zvuka", "off"),
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
        self.blocked_entities: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != "Bearer test-token":
            return httpx.Response(401, json={"message": "unauthorized"})
        if request.method == "GET" and request.url.path == "/api/states":
            return httpx.Response(200, json=list(self.states.values()))
        if request.method == "GET" and request.url.path.startswith("/api/states/"):
            entity_id = request.url.path.removeprefix("/api/states/")
            state = self.states.get(entity_id)
            return httpx.Response(200, json=state) if state else httpx.Response(404, json={})
        if request.method == "POST" and request.url.path.startswith("/api/services/"):
            body = json.loads(request.content.decode("utf-8"))
            self.calls.append((request.url.path, body))
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


def make_stack(
    tmp_path: Path,
    server: HomeAssistantStub | None = None,
    *,
    climate_gate: bool = True,
    psu_gate: bool = True,
    writes: bool = True,
    profile: str = "standard",
) -> tuple[HomeAssistantStub, HomeAssistantAdapter, AccessPolicyStore, HomeAssistantActionExecutor]:
    stub = server or HomeAssistantStub(base_states())
    transport = httpx.MockTransport(stub)
    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
        writes_enabled=writes,
        home_climate_actions_enabled=climate_gate,
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


def test_action_router_exposes_only_fixed_action_catalog(tmp_path: Path) -> None:
    _, _, _, executor = make_stack(tmp_path)
    app = FastAPI()
    app.include_router(build_home_assistant_action_router(executor))
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
    paths = {route.path for route in app.routes}
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


def test_psu_off_already_off_is_idempotent_when_other_state_is_unavailable(tmp_path: Path) -> None:
    server = HomeAssistantStub(base_states(bp1="off", bp2="unavailable"))
    server, _, _, executor = make_stack(tmp_path, server)
    result = run(executor.execute(request("system.rog_g703.psu.bp1.off")))
    assert result["status"] == "confirmed"
    assert result["psu"]["mode"] == "unavailable"
    assert not [call for call in server.calls if call[0].startswith("/api/services/")]
