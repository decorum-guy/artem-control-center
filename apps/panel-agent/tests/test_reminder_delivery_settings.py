import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_reminder_delivery_settings_exposes_safe_health_and_revision_guard(monkeypatch):
    monkeypatch.setenv("PANEL_JARVIS_ENABLED", "true")
    module = load_app(monkeypatch)
    client = TestClient(module.app)

    current = client.get("/api/v1/settings/reminders/delivery")
    assert current.status_code == 200
    payload = current.json()
    assert payload["schemaVersion"] == "reminder.delivery-settings.v1"
    assert payload["spokenEndpoint"] == "alice"
    assert payload["phoneChannels"] == ["telegram"]
    assert payload["channelHealth"]["spoken"]["jarvis"] == {
        "status": "unavailable",
        "code": "jarvis_runtime_unavailable",
    }
    assert "token" not in current.text.lower()
    assert "secret" not in current.text.lower()

    saved = client.patch(
        "/api/v1/settings/reminders/delivery",
        json={
            "expectedRevision": payload["revision"],
            "spokenEndpoint": "jarvis",
            "phoneChannels": ["telegram", "home_assistant"],
        },
    )
    assert saved.status_code == 200
    assert saved.json()["spokenEndpoint"] == "jarvis"
    assert saved.json()["phoneChannels"] == ["telegram", "home_assistant"]
    assert client.patch(
        "/api/v1/settings/reminders/delivery",
        json={
            "expectedRevision": payload["revision"],
            "spokenEndpoint": "alice",
            "phoneChannels": ["telegram"],
        },
    ).status_code == 409


def test_reminder_delivery_settings_rejects_empty_or_unknown_phone_channels(monkeypatch):
    module = load_app(monkeypatch)
    client = TestClient(module.app)
    assert client.patch(
        "/api/v1/settings/reminders/delivery",
        json={"expectedRevision": 0, "spokenEndpoint": "alice", "phoneChannels": []},
    ).status_code == 422
    assert client.patch(
        "/api/v1/settings/reminders/delivery",
        json={"expectedRevision": 0, "spokenEndpoint": "alice", "phoneChannels": ["sms"]},
    ).status_code == 422

def test_disabled_jarvis_cannot_start_or_be_selected_but_keeps_existing_phone_delivery(monkeypatch):
    monkeypatch.delenv("PANEL_JARVIS_ENABLED", raising=False)
    monkeypatch.setenv("PANEL_JARVIS_VOICE_ENABLED", "true")
    module = load_app(monkeypatch)
    client = TestClient(module.app)
    assert client.get("/api/v1/snapshot").json()["jarvisEnabled"] is False
    assert client.get("/api/v1/jarvis/voice/state").status_code == 404
    assert client.post("/api/v1/jarvis/turn", json={"text": "Тест"}).status_code == 404
    path = "/api/v1/settings/reminders/delivery"
    saved = client.get(path).json()
    assert saved["channelHealth"]["spoken"]["jarvis"]["code"] == "jarvis_disabled"
    patch = {"expectedRevision": saved["revision"], "spokenEndpoint": "jarvis", "phoneChannels": ["home_assistant"]}
    assert client.patch(path, json=patch).json()["detail"] == "jarvis_disabled"
    assert client.get(path).json()["spokenEndpoint"] == "alice"
    monkeypatch.setitem(module.fixture_reminder_delivery, "spokenEndpoint", "jarvis")
    updated = client.patch(path, json=patch)
    assert updated.status_code == 200
    assert updated.json()["spokenEndpoint"] == "jarvis"
    assert updated.json()["phoneChannels"] == ["home_assistant"]
    assert updated.json()["channelHealth"]["spoken"]["jarvis"]["code"] == "jarvis_disabled"
