from __future__ import annotations

import importlib
import json

from fastapi.testclient import TestClient


def load_app(monkeypatch, command_path, *, enabled: bool):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_RUNTIME_COMMAND_PATH", str(command_path))
    monkeypatch.setenv(
        "PANEL_KIOSK_CONTROLS_ENABLED",
        "true" if enabled else "false",
    )
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_runtime_control_status_and_intent_gate(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    close_request_path = tmp_path / "kiosk-close-request.json"
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)

    status = client.get("/api/v1/system/runtime")
    assert status.status_code == 200
    assert status.headers["cache-control"] == "no-store"
    assert status.json()["enabled"] is True

    rejected = client.post("/api/v1/system/runtime/hide")
    assert rejected.status_code == 403
    assert not command_path.exists()
    assert not close_request_path.exists()


def test_kiosk_presence_writes_only_bounded_local_heartbeat(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    presence_path = tmp_path / "kiosk-presence.json"
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)

    rejected = client.post(
        "/api/v1/system/runtime/kiosk-presence",
        json={"pageId": "0123456789abcdef01234567"},
    )
    assert rejected.status_code == 403
    assert not presence_path.exists()

    accepted = client.post(
        "/api/v1/system/runtime/kiosk-presence",
        headers={"x-panel-intent": "kiosk-presence"},
        json={"pageId": "0123456789abcdef01234567"},
    )
    assert accepted.status_code == 204
    assert accepted.headers["cache-control"] == "no-store"
    heartbeat = json.loads(presence_path.read_text(encoding="utf-8"))
    assert heartbeat["schemaVersion"] == 1
    assert heartbeat["pageId"] == "0123456789abcdef01234567"
    assert isinstance(heartbeat["observedAt"], str)
    assert set(heartbeat) == {"schemaVersion", "pageId", "observedAt"}

    malformed = client.post(
        "/api/v1/system/runtime/kiosk-presence",
        headers={"x-panel-intent": "kiosk-presence"},
        json={"pageId": "not-bounded", "extra": True},
    )
    assert malformed.status_code == 422


def test_runtime_control_writes_only_narrow_commands(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    close_request_path = tmp_path / "kiosk-close-request.json"
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)
    headers = {"x-panel-intent": "kiosk-control"}

    hidden = client.post("/api/v1/system/runtime/hide", headers=headers)
    assert hidden.status_code == 202
    assert hidden.json() == {"accepted": True, "action": "hide"}
    assert json.loads(command_path.read_text(encoding="utf-8"))["action"] == "hide"
    assert json.loads(close_request_path.read_text(encoding="utf-8"))["action"] == "hide"

    shutdown = client.post("/api/v1/system/runtime/shutdown", headers=headers)
    assert shutdown.status_code == 202
    assert shutdown.json() == {"accepted": True, "action": "shutdown"}
    assert json.loads(command_path.read_text(encoding="utf-8"))["action"] == "shutdown"
    assert json.loads(close_request_path.read_text(encoding="utf-8"))["action"] == "shutdown"


def test_runtime_control_is_disabled_without_explicit_gate(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    close_request_path = tmp_path / "kiosk-close-request.json"
    module = load_app(monkeypatch, command_path, enabled=False)
    client = TestClient(module.app)

    assert client.get("/api/v1/system/runtime").json()["enabled"] is False
    response = client.post(
        "/api/v1/system/runtime/hide",
        headers={"x-panel-intent": "kiosk-control"},
    )
    assert response.status_code == 409
    assert not command_path.exists()
    assert not close_request_path.exists()


def test_capability_apply_fails_closed_when_global_panel_writes_were_disabled(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    store_path = tmp_path / "capability-overrides.json"
    store_path.write_text(json.dumps({
        "schemaVersion": "capability-overrides.v1", "revision": 7,
        "updatedAt": "2026-08-26T00:00:00Z",
        "overrides": {"planning_calendar_route": False},
    }), encoding="utf-8")
    monkeypatch.setenv("PANEL_CAPABILITY_OVERRIDES_PATH", str(store_path))
    monkeypatch.setenv("PANEL_CAPABILITY_APPLY_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "false")
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)

    assert client.get("/api/v1/system/runtime").json()["capabilityApplyEnabled"] is False
    response = client.post(
        "/api/v1/system/runtime/apply-capabilities",
        headers={"x-panel-intent": "capability-apply"},
        json={"expectedRevision": 7},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "capability_apply_disabled"
    assert not command_path.exists()
