from __future__ import annotations

import asyncio
import importlib
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.settings import IntegrationSettings
from panel_agent.station_actions import ACTION_NAMES, StationActionExecutor, StationActionRequest, build_station_action_router, PresetExecutionRequest


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


def test_fixture_overview_gets_disabled_station_availability(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_ACCESS_POLICY_PATH", str(tmp_path / "policy.json"))
    import panel_agent.main
    module = importlib.reload(panel_agent.main)
    with TestClient(module.app) as client:
        response = client.get("/api/v1/actions/station/availability")
        assert response.status_code == 200
        assert response.json()["actions"]["media.alice.play"]["allowed"] is False


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


def test_preset_proxy_keeps_command_only_in_management(tmp_path):
    calls = []
    preset_id = "a1b2c3d4e5f6"
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        body = __import__("json").loads(request.content) if request.content else None
        if request.method == "GET":
            return httpx.Response(200, json={"schemaVersion": 1, "revision": "r1", "updatedAt": "now",
                "presets": [{"id": preset_id, "title": "Избранное"}]})
        if request.url.path.endswith("/execute"):
            assert body == {"requestId": body["requestId"]}
            return httpx.Response(200, json={"schemaVersion": 1, "presetId": preset_id,
                "requestId": body["requestId"], "status": "dispatched"})
        assert set(body) == {"expectedRevision", "title", "command"}
        return httpx.Response(200, json={"schemaVersion": 1, "revision": "r2", "updatedAt": "later",
            "presets": [{"id": preset_id, "title": body["title"]}]})
    executor = make_executor(tmp_path, transport=httpx.MockTransport(handler))
    app = FastAPI()
    app.include_router(build_station_action_router(executor))
    with TestClient(app) as client:
        inventory = client.get("/api/v1/actions/station/presets")
        assert inventory.status_code == 200
        assert "command" not in inventory.text
        execution = client.post("/api/v1/actions/station/presets/execute",
            json={"presetId": preset_id, "requestId": str(uuid4())})
        assert execution.status_code == 200
        assert client.post("/api/v1/actions/station/presets/execute",
            json={"presetId": preset_id, "requestId": str(uuid4()), "command": "bad"}).status_code == 422
        assert client.post("/api/v1/actions/station/presets/execute",
            content='{"presetId":"a1b2c3d4e5f6","requestId":"00000000-0000-0000-0000-000000000000"}',
            headers={"content-type": "text/plain"}).status_code in {415, 422}
        created = client.post("/api/v1/actions/station/presets",
            json={"expectedRevision": "r1", "title": "Тест", "command": "Включи тест"})
        assert created.status_code == 200
    assert len(calls) == 3
    assert calls[1].url.path == f"/internal/control-center/station/presets/{preset_id}/execute"
    assert b"command" not in calls[1].content


def test_preset_policy_conflict_unknown_and_uncertain(tmp_path):
    request = PresetExecutionRequest(presetId="a1b2c3d4e5f6", requestId=uuid4())
    for kwargs in ({"writes": False}, {"gate": False}, {"profile": "read_only"}, {"available": False}):
        executor = make_executor(tmp_path / str(len(str(kwargs))), **kwargs)
        with pytest.raises(HTTPException):
            asyncio.run(executor.execute_preset(request))
        with pytest.raises(HTTPException):
            asyncio.run(executor.mutate_preset("POST", None,
                {"expectedRevision": "r1", "title": "Тест", "command": "Команда"}))
    count = 0
    def handler(http_request):
        nonlocal count
        count += 1
        if http_request.url.path.endswith("/execute"):
            raise httpx.ReadTimeout("uncertain")
        return httpx.Response(409, json={"error": "revision_conflict"})
    executor = make_executor(tmp_path / "errors", transport=httpx.MockTransport(handler))
    with pytest.raises(HTTPException) as conflict:
        asyncio.run(executor.mutate_preset("POST", None,
            {"expectedRevision": "r1", "title": "Тест", "command": "Команда"}))
    assert conflict.value.status_code == 409
    with pytest.raises(HTTPException) as uncertain:
        asyncio.run(executor.execute_preset(request))
    assert uncertain.value.detail == "station_dispatch_uncertain"
    assert count == 2
    missing = make_executor(tmp_path / "missing", transport=httpx.MockTransport(
        lambda _request: httpx.Response(404, json={"error": "unknown_station_preset"})))
    with pytest.raises(HTTPException) as unknown:
        asyncio.run(missing.execute_preset(request))
    assert unknown.value.status_code == 404
    assert unknown.value.detail == "unknown_station_preset"


def test_preset_execution_shares_station_lock(tmp_path):
    calls = 0
    def handler(_request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})
    executor = make_executor(tmp_path, transport=httpx.MockTransport(handler))
    async def scenario():
        executor._lock = asyncio.Lock()
        await executor._lock.acquire()
        try:
            with pytest.raises(HTTPException) as busy:
                await executor.execute_preset(PresetExecutionRequest(
                    presetId="a1b2c3d4e5f6", requestId=uuid4()))
            assert busy.value.status_code == 409
        finally:
            executor._lock.release()
    asyncio.run(scenario())
    assert calls == 0


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
