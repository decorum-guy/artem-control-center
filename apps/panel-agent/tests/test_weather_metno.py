import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from panel_agent.weather import WeatherForecast, WeatherService
from panel_agent.weather_metno import project_forecast


def model(first):
    points = []
    for step in range(24 * 8):
        when = first + timedelta(hours=step)
        points.append({"time": when.isoformat(), "data": {
            "instant": {"details": {"air_temperature": step % 24, "wind_speed": 3, "wind_from_direction": 100}},
            "next_1_hours": {"summary": {"symbol_code": "lightsleet"}, "details": {"precipitation_amount": 0.5}},
        }})
    return {"meta": {"updated_at": first.isoformat()}, "timeseries": points}


def test_projection_uses_current_hour_real_units_and_local_calendar():
    first = datetime(2026, 11, 18, 5, tzinfo=timezone.utc)
    data = model(first)
    now = first + timedelta(hours=5, minutes=40)
    result = project_forecast(data, 55.75, 37.62, now)
    assert result["timezone"] == "Europe/Moscow" and result["timezoneAbbreviation"] == "MSK"
    assert result["current"]["time"] == "2026-11-18T13:00+03:00"
    assert result["current"]["temperature"] == 5 and result["current"]["windSpeed"] == 10.8
    assert result["current"]["apparentTemperature"] is None and result["current"]["isDay"]
    assert result["current"]["weatherCode"] == 68
    assert result["hourly"][0]["precipitationProbability"] is None
    assert result["daily"][0]["precipitationTotal"] is None
    assert result["daily"][1]["precipitationTotal"] == 12
    assert result["daily"][1]["sunrise"].startswith("2026-11-19T")
    assert len(result["daily"]) == 7 and len(result["hourly"]) == 24
    assert project_forecast(data, 55.75, 37.62, first + timedelta(hours=18))["stale"]
    with pytest.raises(ValueError, match="current hour"):
        project_forecast(data, 55.75, 37.62, first + timedelta(days=10))


def test_operator_source_through_service_and_restart(monkeypatch, tmp_path):
    first = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    payload = {"properties": model(first)}
    calls = []
    upstream = ["live"]

    def respond(request):
        assert request.url.host == "api.met.no" and request.url.params["lat"] == "55.7558"
        calls.append(request)
        if upstream[0] == "offline":
            raise httpx.ConnectTimeout("offline", request=request)
        if upstream[0] == "unchanged":
            assert "if-modified-since" in request.headers
            return httpx.Response(304)
        return httpx.Response(200, json=payload, headers={"Last-Modified": "Wed, 18 Nov 2026 05:00:00 GMT"})

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("PANEL_WEATHER_PROVIDER", "metno")

    async def exercise():
        service = WeatherService(mode="production")
        results = await asyncio.gather(service.forecast(), service.forecast(force=True))
        assert all(isinstance(result, WeatherForecast) and not result.stale for result in results)
        restored = WeatherService(mode="production")
        result = await restored.forecast(force=True)
        assert result.provider == "metno" and result.sourceMode == "cached" and len(calls) == 1
        assert result.current.precipitation == 0.5

        path = next(restored.cache_root.glob("metno-*.json"))
        model_cache = json.loads(path.read_text())
        model_cache["expires"] = (first - timedelta(minutes=1)).isoformat()
        path.write_text(json.dumps(model_cache))
        upstream[0] = "offline"
        restarted = WeatherService(mode="production")
        failed = await restarted.forecast(force=True)
        assert failed.stale and failed.sourceMode == "stale" and failed.observedAt == result.observedAt
        upstream[0] = "unchanged"
        recovered = await restarted.forecast(force=True)
        assert not recovered.stale and recovered.observedAt == result.observedAt and len(calls) == 3

    asyncio.run(exercise())
