from __future__ import annotations

import importlib
import json

from fastapi.testclient import TestClient


def _load_app(monkeypatch, path, *, writes=True):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_CALENDAR_DISPLAY_COLOR_PATH", str(path))
    import panel_agent.main

    module = importlib.reload(panel_agent.main)
    from panel_agent.planning import PlanningCalendarSource, PlanningCalendarSourceCalendar, empty_planning_projection

    projection = empty_planning_projection(generated_at="2026-08-26T00:00:00Z", source_status="current")
    module.runtime.planning._projection = projection.model_copy(update={
        "providerStatuses": [
            PlanningCalendarSource(
                id="icloud-safe", kind="external", provider="icloud", label="iCloud",
                status="current", configured=True, lastSyncedAt=None, observedAt="2026-08-26T00:00:00Z",
                calendars=[
                    PlanningCalendarSourceCalendar(id="work-a", label="Рабочий", color="#112233", enabled=True, status="current", lastSyncedAt=None, observedAt="2026-08-26T00:00:00Z"),
                    PlanningCalendarSourceCalendar(id="work-b", label="Рабочий", color="#445566", enabled=True, status="current", lastSyncedAt=None, observedAt="2026-08-26T00:00:00Z"),
                ],
            )
        ]
    })
    return module


def _get(client):
    response = client.get("/api/v1/settings/calendar/display-colors")
    assert response.status_code == 200
    return response.json()


def _patch(client, revision, calendar_id, color):
    return client.patch("/api/v1/settings/calendar/display-colors", json={
        "expectedRevision": revision,
        "providerId": "icloud-safe",
        "calendarId": calendar_id,
        "color": color,
    })


def test_read_contract_is_safe_typed_and_write_is_narrowly_gated(tmp_path, monkeypatch):
    module = _load_app(monkeypatch, tmp_path / "calendar-colors.json", writes=False)
    with TestClient(module.app) as client:
        payload = _get(client)
        assert payload == {
            "schemaVersion": "calendar.display-preferences.v1", "revision": 0,
            "updatedAt": payload["updatedAt"], "overrides": [], "available": True,
            "warnings": [], "writesEnabled": False,
        }
        assert _patch(client, 0, "work-a", "#AABBCC").status_code == 403
        serialized = json.dumps(payload)
        for forbidden in ("INTERNAL_WEBHOOK_SECRET", "PLANNING_PANEL_AGENT_SECRET", "APPLE_PASSWORD", "runtime.env", "http://"):
            assert forbidden not in serialized


def test_valid_colour_is_normalized_persisted_and_duplicate_labels_stay_independent(tmp_path, monkeypatch):
    path = tmp_path / "nested" / "calendar-colors.json"
    module = _load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        first = _patch(client, 0, "work-a", "#a1b2c3")
        assert first.status_code == 200
        assert first.json()["overrides"] == [{"providerId": "icloud-safe", "calendarId": "work-a", "color": "#A1B2C3"}]
        second = _patch(client, 1, "work-b", "#D4E5F6")
        assert second.status_code == 200
        assert {entry["calendarId"]: entry["color"] for entry in second.json()["overrides"]} == {"work-a": "#A1B2C3", "work-b": "#D4E5F6"}
    assert path.exists()
    module = _load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        restored = _get(client)
        assert restored["revision"] == 2
        assert {entry["calendarId"]: entry["color"] for entry in restored["overrides"]} == {"work-a": "#A1B2C3", "work-b": "#D4E5F6"}


def test_rejects_malformed_css_and_unknown_identity_and_reset_only_changes_one_entry(tmp_path, monkeypatch):
    module = _load_app(monkeypatch, tmp_path / "calendar-colors.json")
    with TestClient(module.app) as client:
        for malformed in ("red", "var(--accent)", "rgb(1,2,3)", "#12345", "#11223344", "url(x)"):
            assert _patch(client, 0, "work-a", malformed).status_code == 422
        assert _patch(client, 0, "unknown-calendar", "#AABBCC").status_code == 404
        assert _patch(client, 0, "work-a", "#AABBCC").status_code == 200
        assert _patch(client, 1, "work-b", "#DDEEFF").status_code == 200
        reset = _patch(client, 2, "work-a", None)
        assert reset.status_code == 200
        assert reset.json()["overrides"] == [{"providerId": "icloud-safe", "calendarId": "work-b", "color": "#DDEEFF"}]


def test_corrupt_state_fails_safe_and_atomic_failure_preserves_confirmed_file(tmp_path, monkeypatch):
    from panel_agent.calendar_display_preferences import CalendarDisplayPreferencesStore

    path = tmp_path / "calendar-colors.json"
    path.write_text("{broken", encoding="utf-8")
    module = _load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        payload = _get(client)
        assert payload["available"] is False
        assert payload["overrides"] == []

    store = CalendarDisplayPreferencesStore(str(tmp_path / "atomic.json"), writes_enabled=True)
    first = store.write(provider_id="icloud-safe", calendar_id="work-a", color="#AABBCC", expected_revision=0, known_identities={("icloud-safe", "work-a")})
    before = store.path.read_bytes()
    monkeypatch.setattr("panel_agent.calendar_display_preferences.os.replace", lambda *_args: (_ for _ in ()).throw(OSError("disk full")))
    try:
        store.write(provider_id="icloud-safe", calendar_id="work-a", color="#DDEEFF", expected_revision=first.revision, known_identities=set())
    except OSError:
        pass
    assert store.path.read_bytes() == before
