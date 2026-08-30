import importlib
import json

import pytest
from fastapi.testclient import TestClient


def load_app(monkeypatch, tmp_path, *, writes=True):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_COFFEE_ACTIONS_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_DELAYED_START_PATH", str(tmp_path / "coffee-delayed-start.json"))
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_fixture_api_creates_reads_replaces_and_cancels_one_typed_schedule(monkeypatch, tmp_path):
    module = load_app(monkeypatch, tmp_path)
    client = TestClient(module.app)
    assert client.get("/api/v1/snapshot?scenario=coffee-off").status_code == 200

    initial = client.get("/api/v1/actions/home/coffee/delayed-start")
    assert initial.status_code == 200
    assert initial.json() == {"schemaVersion": 1, "schedule": None, "available": True, "writesEnabled": True}

    created = client.post(
        "/api/v1/actions/home/coffee/delayed-start",
        json={"delayMinutes": 5, "requestId": "api-request-5"},
    )
    assert created.status_code == 200
    schedule = created.json()["schedule"]
    assert schedule["delayMinutes"] == 5
    assert schedule["status"] == "pending"
    assert set(schedule) == {
        "schemaVersion", "scheduleId", "requestId", "delayMinutes", "status",
        "dueAt", "createdAt", "updatedAt", "failureCode",
    }

    readback = client.get("/api/v1/actions/home/coffee/delayed-start")
    assert readback.json()["schedule"] == schedule

    replaced = client.post(
        "/api/v1/actions/home/coffee/delayed-start",
        json={"delayMinutes": 10, "requestId": "api-request-10"},
    )
    assert replaced.status_code == 200
    assert replaced.json()["schedule"]["delayMinutes"] == 10
    assert replaced.json()["schedule"]["scheduleId"] != schedule["scheduleId"]

    cancelled = client.delete("/api/v1/actions/home/coffee/delayed-start")
    assert cancelled.status_code == 200
    assert cancelled.json()["schedule"]["status"] == "cancelled"
    assert cancelled.json()["schedule"]["failureCode"] == "cancelled_by_owner"
    assert client.delete("/api/v1/actions/home/coffee/delayed-start").json() == cancelled.json()
    document = json.loads((tmp_path / "coffee-delayed-start.json").read_text())
    assert isinstance(document, dict)


@pytest.mark.parametrize("payload", [
    {"delayMinutes": 0, "requestId": "api-request-0"},
    {"delayMinutes": -5, "requestId": "api-request-neg"},
    {"delayMinutes": 121, "requestId": "api-request-big"},
    {"delayMinutes": 1.5, "requestId": "api-request-decimal"},
    {"delayMinutes": "5", "requestId": "api-request-string"},
    {"delayMinutes": 5, "requestId": "bad"},
])
def test_fixture_api_rejects_malformed_or_out_of_bound_schedule_requests(monkeypatch, tmp_path, payload):
    module = load_app(monkeypatch, tmp_path)
    client = TestClient(module.app)
    client.get("/api/v1/snapshot?scenario=coffee-off")
    response = client.post("/api/v1/actions/home/coffee/delayed-start", json=payload)
    assert response.status_code == 422
    assert not (tmp_path / "coffee-delayed-start.json").exists()


def test_unavailable_or_stale_fixture_cannot_confirm_a_schedule(monkeypatch, tmp_path):
    module = load_app(monkeypatch, tmp_path)
    client = TestClient(module.app)
    client.get("/api/v1/snapshot?scenario=home-ha-stale")
    response = client.post(
        "/api/v1/actions/home/coffee/delayed-start",
        json={"delayMinutes": 5, "requestId": "api-request-stale"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "coffee_delayed_start_unavailable"


def test_write_gate_is_rechecked_for_creation(monkeypatch, tmp_path):
    module = load_app(monkeypatch, tmp_path, writes=False)
    client = TestClient(module.app)
    client.get("/api/v1/snapshot?scenario=coffee-off")
    response = client.post(
        "/api/v1/actions/home/coffee/delayed-start",
        json={"delayMinutes": 5, "requestId": "api-request-locked"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "coffee_write_disabled"


def test_manual_on_reconciles_the_pending_schedule(monkeypatch, tmp_path):
    module = load_app(monkeypatch, tmp_path)
    client = TestClient(module.app)
    client.get("/api/v1/snapshot?scenario=coffee-off")
    created = client.post(
        "/api/v1/actions/home/coffee/delayed-start",
        json={"delayMinutes": 5, "requestId": "api-request-manual"},
    )
    assert created.status_code == 200

    turned_on = client.post(
        "/api/v1/actions/home/coffee",
        json={"action": "turn_on", "requestId": "api-request-on"},
    )
    assert turned_on.status_code == 200
    schedule = client.get("/api/v1/actions/home/coffee/delayed-start").json()["schedule"]
    assert schedule["status"] == "cancelled"
    assert schedule["failureCode"] == "coffee_machine_turned_on_manually"
