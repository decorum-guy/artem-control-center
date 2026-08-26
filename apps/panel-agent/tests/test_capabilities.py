from __future__ import annotations

import importlib
import json
import threading

from fastapi.testclient import TestClient


def _manifest(dist, *, active=None, baseline=None):
    dist.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": "dashboard-capabilities.v1",
        "profile": "accepted-v2",
        "baseline": baseline or {
            "planning_overview": True,
            "planning_tasks_route": True,
            "planning_calendar_route": True,
            "planning_reminders_route": True,
        },
        "active": active or {
            "planning_overview": True,
            "planning_tasks_route": True,
            "planning_calendar_route": True,
            "planning_reminders_route": True,
        },
    }
    (dist / "dashboard-capabilities.json").write_text(json.dumps(payload), encoding="utf-8")


def _load(monkeypatch, tmp_path, *, writes=True):
    store = tmp_path / "capability-overrides.json"
    dist = tmp_path / "dist"
    _manifest(dist)
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_CAPABILITY_OVERRIDES_PATH", str(store))
    monkeypatch.setenv("PANEL_DASHBOARD_DIST", str(dist))
    import panel_agent.main
    return importlib.reload(panel_agent.main), store


def _get(client):
    response = client.get("/api/v1/settings/capabilities")
    assert response.status_code == 200
    return response.json()


def _patch(client, revision, capability_id, enabled):
    return client.patch("/api/v1/settings/capabilities", json={
        "expectedRevision": revision,
        "capabilityId": capability_id,
        "enabled": enabled,
    })


def _entry(payload, capability_id):
    return next(entry for entry in payload["entries"] if entry["id"] == capability_id)


def test_inventory_is_explicit_safe_and_two_behaviors_only(tmp_path, monkeypatch):
    module, _ = _load(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        payload = _get(client)
    assert payload["schemaVersion"] == "capabilities.v1"
    assert {entry["behavior"] for entry in payload["entries"]} == {"immediate", "delayed"}
    assert _entry(payload, "calendar_display_colors")["mutable"] is True
    assert _entry(payload, "planning_calendar_route")["mutable"] is True
    assert _entry(payload, "panel_writes")["mutable"] is False
    serialized = json.dumps(payload)
    for forbidden in ("PANEL_HA_TOKEN", "PANEL_PLANNING_SECRET", "runtime.env", "password", "http://"):
        assert forbidden not in serialized


def test_immediate_persists_reset_and_master_gate_stays_hard(tmp_path, monkeypatch):
    module, store = _load(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        initial = _get(client)
        saved = _patch(client, initial["revision"], "calendar_display_colors", False)
        assert saved.status_code == 200
        assert _entry(saved.json(), "calendar_display_colors")["activeEnabled"] is False
        reset = _patch(client, saved.json()["revision"], "calendar_display_colors", None)
        assert reset.status_code == 200
        assert _entry(reset.json(), "calendar_display_colors")["activeEnabled"] is True
    assert json.loads(store.read_text(encoding="utf-8"))["overrides"] == {}

    module, _ = _load(monkeypatch, tmp_path / "blocked", writes=False)
    with TestClient(module.app) as client:
        payload = _get(client)
        assert _patch(client, payload["revision"], "overview_layout_editor", False).status_code == 403


def test_delayed_desired_state_is_pending_until_manifest_changes(tmp_path, monkeypatch):
    module, _ = _load(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        initial = _get(client)
        changed = _patch(client, initial["revision"], "planning_calendar_route", False)
        assert changed.status_code == 200
        entry = _entry(changed.json(), "planning_calendar_route")
        assert entry["activeEnabled"] is True
        assert entry["desiredEnabled"] is False
        assert entry["pending"] is True


def test_invalid_and_read_only_ids_are_rejected_by_typed_contract(tmp_path, monkeypatch):
    module, _ = _load(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        revision = _get(client)["revision"]
        assert _patch(client, revision, "PANEL_WRITES_ENABLED", True).status_code == 422
        assert _patch(client, revision, "panel_writes", True).status_code == 422


def test_store_serializes_same_revision_writers(tmp_path):
    from panel_agent.capabilities import CapabilityOverrideStore, CapabilityRevisionConflict

    store = CapabilityOverrideStore(tmp_path / "capability-overrides.json")
    barrier = threading.Barrier(2)
    outcomes = []

    def writer(capability_id):
        barrier.wait()
        try:
            outcomes.append(store.write(capability_id=capability_id, enabled=False, expected_revision=0))
        except Exception as error:
            outcomes.append(error)

    first = threading.Thread(target=writer, args=("planning_calendar_route",))
    second = threading.Thread(target=writer, args=("planning_tasks_route",))
    first.start(); second.start(); first.join(timeout=5); second.join(timeout=5)
    assert len(outcomes) == 2
    assert sum(isinstance(item, CapabilityRevisionConflict) for item in outcomes) == 1
    assert sum(isinstance(item, tuple) for item in outcomes) == 1
