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


def test_listening_activity_refresh_is_bounded_and_cannot_smuggle_turn_fields():
    browser = client()
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    base = {"schemaVersion": "jarvis.voice.v1", "enabled": True, "configured": True, "health": "starting",
            "state": "starting", "sequence": 1, "recognizedText": None, "responseText": None,
            "safeErrorCode": None, "wakeLatencyMs": None, "sttLatencyMs": None, "inputLevel": None}
    states = [("idle", "healthy"), ("wake_detected", "healthy"), ("listening", "healthy")]
    assert browser.post("/api/v1/jarvis/voice/state", json=base, headers=headers).status_code == 204
    for sequence, (state, health) in enumerate(states, start=2):
        assert browser.post("/api/v1/jarvis/voice/state", json={**base, "state": state, "health": health, "sequence": sequence}, headers=headers).status_code == 204

    activity = {**base, "state": "listening", "health": "healthy", "sequence": 5, "inputLevel": 0.73}
    assert browser.post("/api/v1/jarvis/voice/state", json=activity, headers=headers).status_code == 204
    current = browser.get("/api/v1/jarvis/voice/state").json()
    assert current["inputLevel"] == 0.73 and current["state"] == "listening"

    rejected = {**activity, "sequence": 6, "recognizedText": "must not appear"}
    assert browser.post("/api/v1/jarvis/voice/state", json=rejected, headers=headers).status_code == 204
    current = browser.get("/api/v1/jarvis/voice/state").json()
    assert current["sequence"] == 5 and current["recognizedText"] is None

    assert browser.post("/api/v1/jarvis/voice/state", json={**activity, "sequence": 7, "inputLevel": 1.2}, headers=headers).status_code == 422


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


def test_speaking_and_tts_failed_are_narrow_legal_worker_updates():
    browser = client()
    headers = {"X-Jarvis-Voice-Token": "local-only-token"}
    starting = {"schemaVersion": "jarvis.voice.v1", "enabled": True, "configured": True, "health": "starting", "state": "starting", "sequence": 1,
                "recognizedText": None, "responseText": None, "safeErrorCode": None, "wakeLatencyMs": None, "sttLatencyMs": None}
    states = [("idle", "healthy"), ("wake_detected", "healthy"), ("listening", "healthy"),
              ("transcribing", "healthy"), ("submitting", "healthy"), ("speaking", "healthy")]
    assert browser.post("/api/v1/jarvis/voice/state", json=starting, headers=headers).status_code == 204
    for sequence, (state, health) in enumerate(states, start=2):
        assert browser.post("/api/v1/jarvis/voice/state", json={**starting, "state": state, "health": health, "sequence": sequence}, headers=headers).status_code == 204
    ready = {**starting, "state": "ready", "health": "degraded", "sequence": 8,
             "responseText": "Готово.", "navigation": "/settings", "safeErrorCode": "tts_failed"}
    assert browser.post("/api/v1/jarvis/voice/state", json=ready, headers=headers).status_code == 204
    response = browser.get("/api/v1/jarvis/voice/state").json()
    assert response["state"] == "ready" and response["safeErrorCode"] == "tts_failed"
    assert response["responseText"] == "Готово." and response["navigation"] == "/settings"
