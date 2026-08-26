from __future__ import annotations

import importlib
import json
import subprocess
import threading
from dataclasses import fields
from pathlib import Path
from typing import get_type_hints

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
        "flags": {
            "VITE_V2_VISUAL_SHELL": True,
            "VITE_OVERVIEW_V2_ENABLED": True,
            "VITE_OVERVIEW_EDITOR_ENABLED": True,
            "VITE_PLANNING_OVERVIEW_ENABLED": True,
            "VITE_PLANNING_TASKS_ROUTE_ENABLED": True,
            "VITE_PLANNING_CALENDAR_ROUTE_ENABLED": True,
            "VITE_PLANNING_REMINDERS_ROUTE_ENABLED": True,
            "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED": True,
            "VITE_PLANNING_TASK_MUTATIONS_ENABLED": True,
            "VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED": True,
            "VITE_TOUCH_INPUT_LOCK_ENABLED": True,
            "VITE_TOUCH_INPUT_LOCK_START_LOCKED": True,
        },
    }
    (dist / "dashboard-capabilities.json").write_text(json.dumps(payload), encoding="utf-8")


def _load(monkeypatch, tmp_path, *, writes=True, active=None, baseline=None):
    store = tmp_path / "capability-overrides.json"
    dist = tmp_path / "dist"
    _manifest(dist, active=active, baseline=baseline)
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


def _declared_runtime_product_flags():
    from panel_agent.settings import IntegrationSettings

    hints = get_type_hints(IntegrationSettings)
    flags = set()
    for field in fields(IntegrationSettings):
        if hints.get(field.name) is not bool:
            continue
        name = field.name.upper()
        flags.add(name if field.name.startswith("panel_") else f"PANEL_{name}")
    flags.add("PANEL_KIOSK_CONTROLS_ENABLED")
    return flags


def _declared_production_build_flags():
    repository = Path(__file__).resolve().parents[3]
    profile = repository / "scripts" / "production-build-profile.mjs"
    module_url = json.dumps(profile.as_uri())
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            f'import {{ productionBuildProfile }} from {module_url}; process.stdout.write(JSON.stringify(Object.keys(productionBuildProfile)));',
        ],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    keys = json.loads(result.stdout)
    assert isinstance(keys, list)
    return set(keys)


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


def test_current_product_gate_set_has_explicit_registry_classification():
    """A newly introduced product gate requires a deliberate inventory choice."""
    from panel_agent.capabilities import CAPABILITY_REGISTRY

    classified = {definition.technical_flag for definition in CAPABILITY_REGISTRY}
    expected = (
        _declared_runtime_product_flags()
        | _declared_production_build_flags()
    )
    assert classified == expected
    assert "PANEL_FIXTURE_WRITES_ENABLED" not in classified
    assert "PANEL_CAPABILITY_APPLY_ENABLED" not in classified


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


def test_delayed_configured_baseline_is_explicit_and_reset_uses_it(tmp_path, monkeypatch):
    baseline = {
        "planning_overview": True,
        "planning_tasks_route": True,
        "planning_calendar_route": False,
        "planning_reminders_route": True,
    }
    active = {**baseline, "planning_calendar_route": True}
    module, store = _load(monkeypatch, tmp_path, active=active, baseline=baseline)
    store.write_text(json.dumps({
        "schemaVersion": "capability-overrides.v1",
        "revision": 0,
        "updatedAt": "2026-08-26T00:00:00Z",
        "overrides": {"planning_calendar_route": True},
    }), encoding="utf-8")

    with TestClient(module.app) as client:
        initial = _get(client)
        assert _entry(initial, "calendar_display_colors")["configuredEnabled"] is True
        delayed = _entry(initial, "planning_calendar_route")
        assert delayed["configuredEnabled"] is False
        assert delayed["activeEnabled"] is True
        assert delayed["desiredEnabled"] is True

        reset = _patch(client, initial["revision"], "planning_calendar_route", None)
        assert reset.status_code == 200
        reset_entry = _entry(reset.json(), "planning_calendar_route")
        assert reset_entry["configuredEnabled"] is False
        assert reset_entry["desiredEnabled"] is False
        assert reset_entry["pending"] is True


def test_invalid_and_read_only_ids_are_rejected_by_typed_contract(tmp_path, monkeypatch):
    module, _ = _load(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        revision = _get(client)["revision"]
        assert _patch(client, revision, "PANEL_WRITES_ENABLED", True).status_code == 422
        assert _patch(client, revision, "panel_writes", True).status_code == 422


def test_store_serializes_same_revision_writers(tmp_path):
    from panel_agent.capabilities import CapabilityOverrideStore, CapabilityRevisionConflict

    store = CapabilityOverrideStore(tmp_path / "capability-overrides.json")
    outcomes = []
    outcomes_lock = threading.Lock()
    first_entered_atomic_write = threading.Event()
    release_first_writer = threading.Event()

    class ObservedStoreLock:
        """Observe B immediately before it attempts the real acquire()."""

        def __init__(self):
            self._lock = threading.Lock()
            self._observed = threading.Lock()
            self._entries = 0
            self.second_attempted_acquire = threading.Event()

        def __enter__(self):
            with self._observed:
                self._entries += 1
                if self._entries == 2:
                    self.second_attempted_acquire.set()
            self._lock.acquire()
            return self

        def __exit__(self, exc_type, exc, traceback):
            self._lock.release()

    observed_lock = ObservedStoreLock()
    store._write_lock = observed_lock
    original_atomic_write = store._atomic_write

    def instrumented_atomic_write(document):
        first_entered_atomic_write.set()
        assert release_first_writer.wait(timeout=5), "test did not release writer A"
        original_atomic_write(document)

    store._atomic_write = instrumented_atomic_write

    def writer(capability_id):
        try:
            outcome = store.write(capability_id=capability_id, enabled=False, expected_revision=0)
        except Exception as error:
            outcome = error
        with outcomes_lock:
            outcomes.append(outcome)

    first = threading.Thread(target=writer, args=("planning_calendar_route",))
    second = threading.Thread(target=writer, args=("planning_tasks_route",))
    first.start()
    assert first_entered_atomic_write.wait(timeout=5)
    second.start()
    # If the production lock is removed/bypassed, B never reaches this
    # observed pre-acquire point and this test fails deterministically.
    assert observed_lock.second_attempted_acquire.wait(timeout=5)
    release_first_writer.set()
    first.join(timeout=5)
    second.join(timeout=5)
    assert not first.is_alive()
    assert not second.is_alive()
    assert len(outcomes) == 2
    assert sum(isinstance(item, CapabilityRevisionConflict) for item in outcomes) == 1
    assert sum(isinstance(item, tuple) for item in outcomes) == 1
