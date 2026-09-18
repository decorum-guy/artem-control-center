from __future__ import annotations

import asyncio
import importlib
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from panel_agent.jarvis_api import JarvisTurnService
from panel_agent.weather import WeatherCandidate, fixture_forecast


class CountingWeather:
    def __init__(self) -> None:
        self.calls = 0

    async def forecast(self):
        self.calls += 1
        return fixture_forecast(WeatherCandidate(title="Москва", normalizedAddress="Москва", latitude=55.75, longitude=37.62))


def test_time_is_server_owned_and_repeat_does_not_repeat_read_work():
    weather = CountingWeather()
    service = JarvisTurnService(
        planning=lambda: None,
        weather=weather,  # type: ignore[arg-type]
        timezone_name="Europe/Moscow",
        clock=lambda: datetime(2026, 9, 18, 12, 34, tzinfo=timezone.utc),
    )

    async def exercise():
        first = await service.turn("Джарвис, который час?")
        repeat = await service.turn("Повтори")
        weather_turn = await service.turn("Какая погода?")
        weather_repeat = await service.turn("Повтори")
        return first, repeat, weather_turn, weather_repeat

    first, repeat, weather_turn, weather_repeat = asyncio.run(exercise())
    assert first.response_text == "Сейчас 15:34."
    assert repeat.response_text == first.response_text
    assert weather_repeat.response_text == weather_turn.response_text
    assert weather.calls == 1


def test_turn_api_is_private_no_store_and_rejects_extra_or_oversized_schema(monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    import panel_agent.main
    module = importlib.reload(panel_agent.main)
    client = TestClient(module.app)
    result = client.post("/api/v1/jarvis/turn", json={"text": "Сколько времени?"})
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["intentId"] == "system.time.current"
    assert "text" not in result.json()
    assert client.post("/api/v1/jarvis/turn", json={"text": "x", "intentId": "navigation.system"}).status_code == 422
    assert client.post("/api/v1/jarvis/turn", json={"text": "x" * 513}).status_code == 422


def test_navigation_is_fixed_and_mutations_are_truthfully_unavailable(monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    import panel_agent.main
    module = importlib.reload(panel_agent.main)
    client = TestClient(module.app)
    navigation = client.post("/api/v1/jarvis/turn", json={"text": "Открой календарь"}).json()
    assert navigation["navigation"] == "/calendar"
    unsupported = client.post("/api/v1/jarvis/turn", json={"text": "Включи кофемашину"}).json()
    assert unsupported["status"] == "unavailable"
    assert unsupported["navigation"] is None
