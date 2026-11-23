import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

from panel_agent import weather
from panel_agent.weather import WeatherError, WeatherForecast, WeatherService
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
        if request.url.host == "api.open-meteo.com":
            return httpx.Response(503)
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


def open_meteo_model(first):
    hour = first.replace(tzinfo=None).isoformat()
    day = first.date().isoformat()
    return {
        "timezone": "UTC",
        "current": {
            "time": hour, "temperature_2m": 10, "precipitation": 0, "weather_code": 0,
            "wind_speed_10m": 9, "wind_direction_10m": 100, "is_day": 1,
        },
        "hourly": {
            "time": [hour], "temperature_2m": [10], "precipitation_probability": [0],
            "precipitation": [0], "weather_code": [0], "wind_speed_10m": [9],
        },
        "daily": {
            "time": [day], "weather_code": [0], "temperature_2m_max": [12],
            "temperature_2m_min": [3], "precipitation_probability_max": [0],
            "sunrise": [f"{day}T05:00"], "sunset": [f"{day}T18:00"],
        },
    }


@pytest.mark.parametrize(("preferred", "fallback"), [("open-meteo", "metno"), ("metno", "open-meteo")])
def test_automatic_failover_and_recovery(monkeypatch, tmp_path, preferred, fallback):
    first = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    providers = {"api.open-meteo.com": "open-meteo", "api.met.no": "metno"}
    payloads = {"open-meteo": open_meteo_model(first), "metno": {"properties": model(first)}}
    calls = []
    offline = {preferred}
    clock = [100.0]

    def respond(request):
        provider = providers[request.url.host]
        calls.append(provider)
        if provider in offline:
            raise httpx.ConnectTimeout("offline", request=request)
        return httpx.Response(200, json=payloads[provider])

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setattr(weather, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("PANEL_WEATHER_PROVIDER", preferred)

    async def exercise():
        service = WeatherService(mode="production")
        live, cached = await asyncio.gather(service.forecast(), service.forecast())
        assert (live.provider, live.stale, live.sourceMode) == (fallback, False, "live")
        assert (cached.provider, cached.stale, cached.sourceMode) == (fallback, False, "cached")
        assert calls == [preferred, fallback]
        assert WeatherForecast.model_validate_json(
            service._cache_path(service.store.get()).read_text()
        ).provider == fallback

        offline.clear()
        clock[0] += weather.PROVIDER_RETRY_SECONDS
        recovered = await service.forecast()
        assert (recovered.provider, recovered.stale, recovered.sourceMode) == (preferred, False, "live")
        assert calls == [preferred, fallback, preferred]

    asyncio.run(exercise())


@pytest.mark.parametrize("open_meteo_online", [True, False])
def test_old_metno_model_uses_alternate_or_latest_stale_cache(monkeypatch, tmp_path, open_meteo_online):
    first = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    def respond(request):
        if request.url.host == "api.met.no":
            return httpx.Response(200, json={"properties": model(first - timedelta(hours=20))})
        if open_meteo_online:
            return httpx.Response(200, json=open_meteo_model(first))
        return httpx.Response(200, json={})

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("PANEL_WEATHER_PROVIDER", "metno")

    async def exercise():
        service = WeatherService(mode="production")
        location = service.store.get()
        previous = weather.normalize_forecast(open_meteo_model(first), location).model_copy(
            update={"observedAt": (first - timedelta(hours=1)).isoformat()}
        )
        service._persist_cache(location, previous)

        result = await service.forecast()
        assert result.provider == "open-meteo"
        if open_meteo_online:
            assert result.sourceMode == "live" and not result.stale
        else:
            assert result.sourceMode == "stale" and result.stale
            assert result.observedAt == previous.observedAt

    asyncio.run(exercise())


def test_both_providers_fail_without_saved_forecast(monkeypatch, tmp_path):
    calls = []

    def respond(request):
        calls.append(request.url.host)
        return httpx.Response(503)

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("PANEL_WEATHER_PROVIDER", "open-meteo")

    async def exercise():
        service = WeatherService(mode="production")
        for _ in range(2):
            with pytest.raises(WeatherError, match="weather_provider_unavailable"):
                await service.forecast()
        assert calls == ["api.open-meteo.com", "api.met.no"]
        assert not service.cache_root.exists()

    asyncio.run(exercise())
