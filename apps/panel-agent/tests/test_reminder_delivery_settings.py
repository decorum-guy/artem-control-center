import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_reminder_delivery_settings_exposes_safe_health_and_revision_guard(monkeypatch):
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
