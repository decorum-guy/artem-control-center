from __future__ import annotations

import asyncio
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.settings import IntegrationSettings
from panel_agent.station_actions import ACTION_NAMES, StationActionExecutor, StationActionRequest, build_station_action_router


def make_executor(tmp_path, *, writes=True, gate=True, available=True, profile="standard", transport=None):
    settings = IntegrationSettings(
        writes_enabled=writes, alice_station_actions_enabled=gate,
        alice_base_url="http://alice.test", alice_control_center_token="test-token",
    )
    access = AccessPolicyStore(tmp_path / "access.json")
    if profile != "read_only":
        access.set_profile(profile)
    return StationActionExecutor(settings, access, lambda: available, transport=transport)


def test_fixed_action_contract_and_gate(tmp_path):
    assert len(ACTION_NAMES) == 7
    for action_id in ACTION_NAMES:
        assert action_id.startswith("media.alice.")
    for kwargs in ({"writes": False}, {"gate": False}, {"profile": "read_only"}, {"available": False}):
        executor = make_executor(tmp_path / str(len(str(kwargs))), **kwargs)
        decision = executor.availability()["actions"]["media.alice.next"]
        assert decision["allowed"] is False
        with pytest.raises(HTTPException):
            asyncio.run(executor.execute(StationActionRequest(actionId="media.alice.next", requestId=uuid4())))


def test_route_forbids_arbitrary_payload_and_sends_one_bounded_request(tmp_path):
    calls = []
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.path == "/internal/control-center/station/action"
        assert request.headers["Authorization"] == "Bearer test-token"
        body = __import__("json").loads(request.content)
        assert set(body) == {"action", "requestId"}
        return httpx.Response(200, json={"schemaVersion": 1, "action": body["action"],
                                         "requestId": body["requestId"], "status": "dispatched"})
    executor = make_executor(tmp_path, transport=httpx.MockTransport(handler))
    app = FastAPI()
    app.include_router(build_station_action_router(executor))
    with TestClient(app) as client:
        path = "/api/v1/actions/station"
        body = {"actionId": "media.alice.next", "requestId": str(uuid4())}
        assert client.post(path, json={**body, "entity_id": "media_player.other"}).status_code == 422
        assert client.post(path, json={**body, "command": "arbitrary"}).status_code == 422
        assert client.post(path, json={**body, "service": "turn_on"}).status_code == 422
        assert client.post(path, json={**body, "actionId": "media.alice.unknown"}).status_code == 422
        result = client.post(path, json=body)
        assert result.status_code == 200
        assert result.json()["status"] == "dispatched"
    assert len(calls) == 1


def test_uncertain_transport_is_not_retried(tmp_path):
    calls = 0
    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("uncertain")
    executor = make_executor(tmp_path, transport=httpx.MockTransport(handler))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(executor.execute(StationActionRequest(actionId="media.alice.volume_up", requestId=uuid4())))
    assert exc.value.detail == "station_dispatch_uncertain"
    assert calls == 1


def test_second_action_cannot_overlap_first(tmp_path):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            body = __import__("json").loads(request.content)
            return httpx.Response(200, json={"schemaVersion": 1, "action": body["action"], "requestId": body["requestId"],
                                             "status": "dispatched"})
        executor = make_executor(tmp_path, transport=httpx.MockTransport(handler))
        first = asyncio.create_task(executor.execute(StationActionRequest(actionId="media.alice.next", requestId=uuid4())))
        await started.wait()
        with pytest.raises(HTTPException):
            await executor.execute(StationActionRequest(actionId="media.alice.previous", requestId=uuid4()))
        release.set()
        assert (await first)["status"] == "dispatched"
        assert calls == 1
    asyncio.run(scenario())
