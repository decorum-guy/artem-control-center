from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.home_assistant import KETTLE_ENTITY, _sanitize_state
from panel_agent.home_assistant_actions import (
    ALL_ACTION_IDS, KETTLE_ACTION_IDS, NO_VALUE_ACTIONS, HomeAssistantActionId,
    build_home_assistant_action_router,
)
from typing import get_args
from test_home_assistant_actions import (
    HomeAssistantStub, KettleReadbackStub, base_states, entity, kettle_heating,
    make_stack, request, run,
)


STOP = "home.kettle.stop"
PATH = "/api/services/water_heater/set_operation_mode"
BEFORE = "2026-09-30T18:15:54.500Z"
AFTER = "2026-09-30T18:15:56.000Z"


def stopped(*, state="off", mode="off", updated=AFTER, target=None):
    result = entity(KETTLE_ENTITY, state, {
        "operation_mode": mode, "current_temperature": 42, "temperature": target,
    })
    result["last_updated"] = updated
    return result


def active_server(readbacks=None):
    server = KettleReadbackStub(readbacks) if readbacks is not None else HomeAssistantStub(base_states())
    server.states[KETTLE_ENTITY] = kettle_heating()
    server.states[KETTLE_ENTITY]["last_updated"] = BEFORE
    return server


def stop_stack(tmp_path, server=None, **kwargs):
    stack = make_stack(tmp_path, server, **kwargs)
    stack[-1]._verification_timeout = 5.0
    return stack


def test_stop_is_typed_no_value_and_only_accepts_id_and_uuid():
    assert STOP in get_args(HomeAssistantActionId)
    assert STOP in ALL_ACTION_IDS and STOP in KETTLE_ACTION_IDS and STOP in NO_VALUE_ACTIONS
    assert request(STOP).model_fields_set == {"actionId", "requestId"}
    for field in ("entity", "entity_id", "entityId", "service", "domain", "mode",
                  "operation_mode", "temperature", "payload", "command", "fanMode", "teaMode", "extra"):
        for value in ("injected", None):
            with pytest.raises(ValidationError):
                request(STOP, **{field: value})


def test_stop_http_contract_and_fresh_idempotence(tmp_path):
    server, adapter, _, executor = stop_stack(tmp_path)
    # Cached active data cannot override a fresh authoritative off/off read.
    adapter._states[KETTLE_ENTITY] = _sanitize_state(KETTLE_ENTITY, kettle_heating())
    app = FastAPI()
    app.include_router(build_home_assistant_action_router(executor))
    with TestClient(app) as client:
        response = client.post("/api/v1/actions/home-assistant", json={
            "actionId": STOP, "requestId": str(uuid4()),
        })
    assert response.status_code == 200
    assert response.json()["status"] == "confirmed"
    assert response.json()["kettle"]["state"] == "off"
    assert response.json()["kettle"]["operationMode"] == "off"
    assert server.calls == []
    assert server.events[-1] == ("get", f"/api/states/{KETTLE_ENTITY}")


@pytest.mark.parametrize("target", [None, 0, 80, 100])
def test_active_stop_uses_one_fixed_mutation_and_real_final_snapshot(tmp_path, target):
    server = active_server([stopped(target=target)])
    _, adapter, _, executor = stop_stack(tmp_path, server)
    result = run(executor.execute(request(STOP)))
    assert result["status"] == "confirmed"
    assert result["kettle"] == {
        "state": "off", "operationMode": "off", "lastUpdated": AFTER,
        "currentTemperature": 42, "targetTemperature": target,
    }
    assert server.calls == [(PATH, {"entity_id": KETTLE_ENTITY, "operation_mode": "off"})]
    assert server.events[-3:] == [("get", f"/api/states/{KETTLE_ENTITY}"),
                                  ("post", PATH), ("get", f"/api/states/{KETTLE_ENTITY}")]
    assert next(service for service in adapter.services() if service.id == "kettle").data["stage"] == "off"


@pytest.mark.parametrize("state,mode", [("off", "on"), ("on", "off"), ("on", "on"),
                                        ("off", "green_tea"), ("unavailable", "off")])
def test_wrong_stop_state_or_mode_never_confirms(tmp_path, state, mode):
    server = active_server([stopped(state=state, mode=mode)])
    _, _, _, executor = stop_stack(tmp_path, server)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request(STOP)))
    assert failure.value.detail == "ha_verification_timeout"
    assert executor._clock() == 5.0
    assert len(server.calls) == 1


@pytest.mark.parametrize("updated", [BEFORE, "2026-09-30T18:15:54Z", None,
                                    "2026-09-30T18:15:56", "bad", "9999-12-31T23:59:59-12:00"])
def test_stop_stale_missing_naive_or_malformed_post_timestamp_never_confirms(tmp_path, updated):
    readback = stopped(updated=updated)
    if updated is None:
        readback.pop("last_updated")
    server = active_server([readback])
    _, _, _, executor = stop_stack(tmp_path, server)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request(STOP)))
    assert failure.value.detail == "ha_verification_timeout"
    assert executor._clock() == 5.0
    assert len(server.calls) == 1


@pytest.mark.parametrize("updated", [None, "bad", "2026-09-30T18:15:54", "9999-12-31T23:59:59-12:00"])
def test_stop_invalid_precommand_watermark_never_mutates(tmp_path, updated):
    server = active_server()
    server.states[KETTLE_ENTITY]["last_updated"] = updated
    _, _, _, executor = stop_stack(tmp_path, server)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request(STOP)))
    assert failure.value.detail == "ha_invalid_state"
    assert server.calls == []


def test_stop_confirms_ha_advancement_despite_later_samsung_wall_clock(tmp_path, monkeypatch):
    samsung_time = datetime(2026, 9, 30, 18, 15, 57, tzinfo=timezone.utc)

    class SamsungDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return samsung_time.astimezone(tz) if tz else samsung_time.replace(tzinfo=None)

    monkeypatch.setattr("panel_agent.home_assistant_actions.datetime", SamsungDatetime)
    server = active_server([stopped()])
    _, _, _, executor = stop_stack(tmp_path, server)
    result = run(executor.execute(request(STOP)))
    assert result["status"] == "confirmed"
    assert result["observedAt"] == samsung_time.isoformat()
    assert result["kettle"]["lastUpdated"] == AFTER
    assert len(server.calls) == 1


def test_stop_handles_delayed_propagation_without_retry(tmp_path):
    server = active_server([kettle_heating(), stopped(updated=BEFORE), stopped()])
    _, _, _, executor = stop_stack(tmp_path, server)
    assert run(executor.execute(request(STOP)))["status"] == "confirmed"
    assert executor._clock() == 0.5
    assert server.readback_count == 3
    assert len(server.calls) == 1


@pytest.mark.parametrize("uncertain", [False, True])
def test_stop_service_failure_or_uncertainty_is_safe_and_never_retried(tmp_path, uncertain):
    server = active_server()
    server.service_failures[PATH] = (500, "private-upstream-body")
    _, _, _, executor = stop_stack(tmp_path, server)
    if uncertain:
        async def timeout_dispatch(request):
            server(request)
            raise httpx.ReadTimeout("private-upstream-body")
        executor._transport = httpx.MockTransport(timeout_dispatch)
    with pytest.raises(HTTPException) as failure:
        run(executor.execute(request(STOP)))
    assert failure.value.status_code == 502
    assert failure.value.detail == "ha_service_failed"
    assert "private-upstream-body" not in str(failure.value)
    assert len(server.calls) == 1


@pytest.mark.parametrize("options,availability", [
    ({"writes": False}, "gate_disabled"), ({"kettle_gate": False}, "gate_disabled"),
    ({"profile": "read_only"}, "profile_blocked"),
])
def test_stop_preserves_write_gate_kettle_gate_and_profile(tmp_path, options, availability):
    server, _, _, executor = stop_stack(tmp_path, active_server(), **options)
    assert executor.availability()["actions"][STOP]["availability"] == availability
    with pytest.raises(HTTPException):
        run(executor.execute(request(STOP)))
    assert server.calls == []


def test_stop_preserves_integration_gate_and_low_risk_descriptor(tmp_path):
    server, adapter, _, executor = stop_stack(tmp_path)
    descriptor = next(action for service in adapter.services() if service.id == "kettle"
                      for action in service.actions if action.id == STOP)
    assert descriptor.risk == "low"
    assert executor.availability()["actions"][STOP]["minimumProfile"] == "standard"
    adapter._states.pop(KETTLE_ENTITY)
    assert executor.availability()["actions"][STOP]["availability"] == "integration_unavailable"
    with pytest.raises(HTTPException):
        run(executor.execute(request(STOP)))
    assert server.calls == []


def test_stop_shares_kettle_lock_and_busy_handling(tmp_path):
    _, _, _, executor = stop_stack(tmp_path)

    async def check():
        lock = executor._lock_for(STOP)
        assert lock is executor._lock_for("home.kettle.boil")
        assert lock is executor._lock_for("home.kettle.set_tea_mode")
        async with lock:
            decisions = executor.availability()["actions"]
            assert all(decisions[action]["availability"] == "busy" for action in KETTLE_ACTION_IDS)

    run(check())
