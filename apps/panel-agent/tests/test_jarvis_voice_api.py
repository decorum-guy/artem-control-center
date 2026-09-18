from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.jarvis_api import JarvisTurnService
from panel_agent.jarvis_voice_api import VoiceBridgeState, build_jarvis_voice_router
from panel_agent.weather import WeatherCandidate, fixture_forecast


class Weather:
    async def forecast(self):
        return fixture_forecast(WeatherCandidate(title="Москва", normalizedAddress="Москва", latitude=55.75, longitude=37.62))


def client():
    app = FastAPI()
    service = JarvisTurnService(
        planning=lambda: None, weather=Weather(), timezone_name="Europe/Moscow",
        clock=lambda: datetime(2026, 9, 18, 12, 34, tzinfo=timezone.utc),
    )
    bridge = VoiceBridgeState(enabled=True, configured=True, token="local-only-token")
    app.include_router(build_jarvis_voice_router(service=service, bridge=bridge))
    return TestClient(app)


def test_disabled_default_state_is_no_store_and_has_no_text():
    result = client().get("/api/v1/jarvis/voice/state")
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    assert result.json()["recognizedText"] is None and result.json()["responseText"] is None


def test_worker_state_requires_token_ignores_stale_and_rejects_extra_fields():
    browser = client()
    payload = {"schemaVersion": "jarvis.voice.v1", "enabled": True, "configured": True, "health": "starting", "state": "starting", "sequence": 1,
               "recognizedText": None, "responseText": None, "safeErrorCode": None, "wakeLatencyMs": None, "sttLatencyMs": None}
    assert browser.post("/api/v1/jarvis/voice/state", json=payload).status_code == 403
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    assert browser.post("/api/v1/jarvis/voice/state", json=payload, headers=headers).status_code == 204
    assert browser.post("/api/v1/jarvis/voice/state", json={**payload, "health": "healthy", "state": "idle"}, headers=headers).status_code == 204
    idle = {**payload, "health": "healthy", "state": "idle", "sequence": 2}
    assert browser.post("/api/v1/jarvis/voice/state", json=idle, headers=headers).status_code == 204
    assert browser.get("/api/v1/jarvis/voice/state").json()["sequence"] == 2
    assert browser.post("/api/v1/jarvis/voice/state", json={**idle, "extra": True}, headers=headers).status_code == 422
    assert browser.post("/api/v1/jarvis/voice/state", json={**idle, "sequence": 3, "safeErrorCode": "raw exception text"}, headers=headers).status_code == 422


def test_loopback_turn_is_one_existing_service_path_and_lock_blocks_it():
    browser = client()
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    assert browser.post("/api/v1/jarvis/voice/turn", json={"text": "Который час?"}, headers=headers).status_code == 423
    assert browser.post("/api/v1/jarvis/voice/interaction-lock", json={"locked": False}).status_code == 204
    result = browser.post("/api/v1/jarvis/voice/turn", json={"text": "Который час?"}, headers=headers)
    assert result.status_code == 200 and result.json()["responseText"] == "Сейчас 15:34."
    assert browser.post("/api/v1/jarvis/voice/turn", json={"text": "x", "intentId": "shell"}, headers=headers).status_code == 422


def test_worker_restart_is_server_monotonic_but_old_updates_remain_ignored():
    browser = client()
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    starting = {"schemaVersion": "jarvis.voice.v1", "enabled": True, "configured": True, "health": "starting", "state": "starting", "sequence": 1,
                "recognizedText": None, "responseText": None, "safeErrorCode": None, "wakeLatencyMs": None, "sttLatencyMs": None}
    assert browser.post("/api/v1/jarvis/voice/state", json=starting, headers=headers).status_code == 204
    idle = {**starting, "health": "healthy", "state": "idle", "sequence": 2}
    assert browser.post("/api/v1/jarvis/voice/state", json=idle, headers=headers).status_code == 204
    before = browser.get("/api/v1/jarvis/voice/state").json()["sequence"]
    assert browser.post("/api/v1/jarvis/voice/state", json=starting, headers=headers).status_code == 204
    assert browser.get("/api/v1/jarvis/voice/state").json()["sequence"] == before + 1


def test_voice_state_allows_only_canonical_navigation():
    browser = client()
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    payload = {"schemaVersion": "jarvis.voice.v1", "enabled": True, "configured": True, "health": "starting", "state": "starting", "sequence": 1,
               "recognizedText": None, "responseText": None, "safeErrorCode": None, "wakeLatencyMs": None, "sttLatencyMs": None,
               "navigation": "/settings"}
    assert browser.post("/api/v1/jarvis/voice/state", json=payload, headers=headers).status_code == 204
    assert browser.get("/api/v1/jarvis/voice/state").json()["navigation"] == "/settings"
    for invalid in ("https://example.com", "javascript:alert(1)", "/not-a-real-jarvis-route"):
        assert browser.post("/api/v1/jarvis/voice/state", json={**payload, "navigation": invalid}, headers=headers).status_code == 422
