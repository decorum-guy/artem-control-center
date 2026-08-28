from __future__ import annotations

import importlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
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


def gate_private_replacements(monkeypatch, module, barrier, sources=None):
    """Release writers after their temp is ready, before publication."""
    sources_lock = threading.Lock()
    original_publish = getattr(module, "_atomic_replace", None)
    if original_publish is not None:
        def synchronized_publish(source, destination):
            if sources is not None:
                with sources_lock:
                    sources.append(Path(source))
            barrier.wait(timeout=5)
            return original_publish(source, destination)

        monkeypatch.setattr(module, "_atomic_replace", synchronized_publish)
        return

    # Compatibility path used when this regression is run against the old
    # main implementation, which has no publication helper to instrument.
    original_replace = module.os.replace

    def synchronized_replace(source, destination):
        if sources is not None:
            with sources_lock:
                sources.append(Path(source))
        barrier.wait(timeout=5)
        return original_replace(source, destination)

    monkeypatch.setattr(module.os, "replace", synchronized_replace)


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


def test_concurrent_command_writers_use_private_atomic_temps(monkeypatch, tmp_path):
    from panel_agent import runtime_control

    command_path = tmp_path / "runtime-command.json"
    payloads = [
        {"schemaVersion": 1, "action": "hide", "writer": index}
        for index in range(4)
    ]
    replace_barrier = threading.Barrier(len(payloads))
    replace_sources: list[Path] = []
    gate_private_replacements(monkeypatch, runtime_control, replace_barrier, replace_sources)

    with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
        list(executor.map(lambda payload: runtime_control._write_command(command_path, payload), payloads))

    assert len(replace_sources) == len(payloads)
    assert len(set(replace_sources)) == len(payloads)
    assert all(source.parent == command_path.parent for source in replace_sources)
    assert json.loads(command_path.read_text(encoding="utf-8")) in payloads
    assert list(tmp_path.glob(f".{command_path.name}.*.tmp")) == []


def test_failed_command_write_preserves_target_and_cleans_only_own_temp(monkeypatch, tmp_path):
    from panel_agent import runtime_control

    command_path = tmp_path / "runtime-command.json"
    existing = {"schemaVersion": 1, "action": "existing"}
    command_path.write_text(json.dumps(existing), encoding="utf-8")
    unrelated_temp = tmp_path / f".{command_path.name}.unrelated.tmp"
    unrelated_temp.write_text("unrelated", encoding="utf-8")
    attempted_sources: list[Path] = []

    def failing_replace(source, destination):
        attempted_sources.append(Path(source))
        raise OSError("injected replace failure")

    monkeypatch.setattr(runtime_control.os, "replace", failing_replace)
    with pytest.raises(OSError, match="injected replace failure"):
        runtime_control._write_command(
            command_path,
            {"schemaVersion": 1, "action": "replacement"},
        )

    assert attempted_sources
    assert not attempted_sources[0].exists()
    assert json.loads(command_path.read_text(encoding="utf-8")) == existing
    assert unrelated_temp.read_text(encoding="utf-8") == "unrelated"
    assert list(tmp_path.glob(f".{command_path.name}.*.tmp")) == [unrelated_temp]


def test_concurrent_kiosk_presence_requests_publish_complete_heartbeats(monkeypatch, tmp_path):
    from panel_agent import runtime_control

    command_path = tmp_path / "runtime-command.json"
    module = load_app(monkeypatch, command_path, enabled=True)
    presence_path = tmp_path / "kiosk-presence.json"
    page_ids = [f"{index:024x}" for index in range(4)]
    replace_barrier = threading.Barrier(len(page_ids))
    gate_private_replacements(monkeypatch, runtime_control, replace_barrier)

    def send_presence(page_id):
        with TestClient(module.app, raise_server_exceptions=False) as client:
            return client.post(
                "/api/v1/system/runtime/kiosk-presence",
                headers={"x-panel-intent": "kiosk-presence"},
                json={"pageId": page_id},
            )

    with ThreadPoolExecutor(max_workers=len(page_ids)) as executor:
        responses = list(executor.map(send_presence, page_ids))

    assert [response.status_code for response in responses] == [204] * len(page_ids)
    heartbeat = json.loads(presence_path.read_text(encoding="utf-8"))
    assert heartbeat["schemaVersion"] == 1
    assert heartbeat["pageId"] in page_ids
    assert isinstance(heartbeat["observedAt"], str)
    assert set(heartbeat) == {"schemaVersion", "pageId", "observedAt"}
    assert list(tmp_path.glob(f".{presence_path.name}.*.tmp")) == []


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
