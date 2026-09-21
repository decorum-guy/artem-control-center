import asyncio
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.home_assistant_maintenance import (
    CORE_UPDATE_ENTITY,
    HomeAssistantMaintenanceExecutor,
    RESTART_ACTION,
    UPDATE_CORE_ACTION,
    build_home_assistant_maintenance_router,
)
from panel_agent.settings import IntegrationSettings


def settings(**changes):
    values = {"ha_url": "http://ha.test", "ha_token": "secret", "writes_enabled": True, "ha_maintenance_actions_enabled": True}
    values.update(changes)
    return IntegrationSettings(**values)


def access(tmp_path: Path, profile="full"):
    store = AccessPolicyStore(tmp_path / "policy.json", audit_dir=tmp_path / "audit")
    store.set_pin("1234")
    store.set_profile(profile, pin="1234") if profile == "full" else None
    return store


def transport(state, calls):
    async def handler(request: httpx.Request):
        calls.append((request.method, request.url.path, request.content))
        if request.url.path == "/api/":
            return httpx.Response(200, json={"message": "API running"})
        if request.url.path == f"/api/states/{CORE_UPDATE_ENTITY}":
            return httpx.Response(200, json=state())
        if request.url.path == "/api/services/homeassistant/restart":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/services/update/install":
            return httpx.Response(200, json=[])
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def core(*, available=True, installed="2026.9.0", latest="2026.9.1", supported=3, progress=False):
    return {"entity_id": CORE_UPDATE_ENTITY, "state": "on" if available else "off", "attributes": {"installed_version": installed, "latest_version": latest, "supported_features": supported, "in_progress": progress}}


def make(tmp_path, *, values=None, profile="full", admin=True):
    values = values or [core()]
    calls = []
    executor = HomeAssistantMaintenanceExecutor(settings(), access(tmp_path, profile), transport=transport(lambda: values[0], calls), admin_checker=lambda: asyncio.sleep(0, result=admin), poll_interval=0, recovery_timeout=1)
    return executor, calls, values


def test_default_gate_is_off():
    assert IntegrationSettings().ha_maintenance_actions_enabled is False


def test_status_projects_admin_boolean_and_no_user_data(tmp_path):
    executor, _, _ = make(tmp_path, admin=False)
    result = asyncio.run(executor.availability())
    assert result["adminAuthorized"] is False
    assert set(result) >= {"configured", "reachable", "adminAuthorized", "actions"}
    assert "user" not in result


def test_restart_uses_exact_fixed_path_and_empty_body(tmp_path):
    executor, calls, _ = make(tmp_path)
    async def exercise():
        operation, accepted = await executor.submit(type("Request", (), {"actionId": RESTART_ACTION, "requestId": __import__("uuid").uuid4()})())
        assert accepted and operation["status"] == "requested"
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    asyncio.run(exercise())
    assert ("POST", "/api/services/homeassistant/restart", b"{}") in calls


def test_update_uses_fixed_entity_and_backup_only_when_supported(tmp_path):
    executor, calls, values = make(tmp_path, values=[core()])
    async def exercise():
        request = type("Request", (), {"actionId": UPDATE_CORE_ACTION, "requestId": __import__("uuid").uuid4()})()
        await executor.submit(request)
        values[0] = core(available=False, installed="2026.9.1", latest="2026.9.1")
        await asyncio.sleep(0); await asyncio.sleep(0); await asyncio.sleep(0)
    asyncio.run(exercise())
    update = next(item for item in calls if item[1] == "/api/services/update/install")
    assert update[2] == b'{"entity_id":"update.home_assistant_core_update","backup":true}'


def test_non_admin_blocks_both_mutations(tmp_path):
    executor, _, _ = make(tmp_path, admin=False)
    async def exercise():
        for action in (RESTART_ACTION, UPDATE_CORE_ACTION):
            try:
                await executor.submit(type("Request", (), {"actionId": action, "requestId": __import__("uuid").uuid4()})())
            except Exception as error:
                assert getattr(error, "detail", None) == "admin_required"
            else: assert False
    asyncio.run(exercise())


def test_request_contract_is_only_action_and_uuid(tmp_path):
    executor, _, _ = make(tmp_path)
    app = FastAPI(); app.include_router(build_home_assistant_maintenance_router(executor))
    client = TestClient(app)
    response = client.post("/api/v1/actions/home-assistant/maintenance", json={"actionId": RESTART_ACTION, "requestId": "06a12c75-a16d-4d12-99c6-6d3a44086280", "version": "bad"})
    assert response.status_code == 422


def test_duplicate_request_id_does_not_dispatch_twice(tmp_path):
    executor, calls, _ = make(tmp_path)
    async def exercise():
        request = type("Request", (), {"actionId": RESTART_ACTION, "requestId": __import__("uuid").uuid4()})()
        _, accepted = await executor.submit(request)
        _, duplicate = await executor.submit(request)
        assert accepted and not duplicate
        await asyncio.sleep(0); await asyncio.sleep(0)
    asyncio.run(exercise())
    assert len([call for call in calls if call[1] == "/api/services/homeassistant/restart"]) == 1
