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
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)

    status = client.get("/api/v1/system/runtime")
    assert status.status_code == 200
    assert status.headers["cache-control"] == "no-store"
    assert status.json()["enabled"] is True

    rejected = client.post("/api/v1/system/runtime/hide")
    assert rejected.status_code == 403
    assert not command_path.exists()


def test_runtime_control_writes_only_narrow_commands(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    module = load_app(monkeypatch, command_path, enabled=True)
    client = TestClient(module.app)
    headers = {"x-panel-intent": "kiosk-control"}

    hidden = client.post("/api/v1/system/runtime/hide", headers=headers)
    assert hidden.status_code == 202
    assert hidden.json() == {"accepted": True, "action": "hide"}
    assert json.loads(command_path.read_text(encoding="utf-8"))["action"] == "hide"

    shutdown = client.post("/api/v1/system/runtime/shutdown", headers=headers)
    assert shutdown.status_code == 202
    assert shutdown.json() == {"accepted": True, "action": "shutdown"}
    assert json.loads(command_path.read_text(encoding="utf-8"))["action"] == "shutdown"


def test_runtime_control_is_disabled_without_explicit_gate(monkeypatch, tmp_path):
    command_path = tmp_path / "runtime-command.json"
    module = load_app(monkeypatch, command_path, enabled=False)
    client = TestClient(module.app)

    assert client.get("/api/v1/system/runtime").json()["enabled"] is False
    response = client.post(
        "/api/v1/system/runtime/hide",
        headers={"x-panel-intent": "kiosk-control"},
    )
    assert response.status_code == 409
    assert not command_path.exists()
