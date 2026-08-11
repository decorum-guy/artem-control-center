from __future__ import annotations

import importlib

from fastapi.testclient import TestClient

from panel_agent.weather import (
    WeatherCandidate,
    WeatherLocationStore,
    WeatherService,
    fixture_forecast,
    normalize_forecast,
)


def load_app(monkeypatch, mode: str):
    monkeypatch.setenv("PANEL_AGENT_MODE", mode)
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_weather_fixture_api_is_deterministic(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)

    locations_response = client.get("/api/v1/weather/locations")
    assert locations_response.status_code == 200
    assert locations_response.headers["cache-control"] == "no-store"
    locations = locations_response.json()
    assert locations[0]["title"] == "Москва"
    assert locations[0]["isDefault"] is True

    forecast_response = client.get("/api/v1/weather")
    assert forecast_response.status_code == 200
    assert forecast_response.headers["cache-control"] == "no-store"
    forecast = forecast_response.json()
    assert forecast["sourceMode"] == "fixture"
    assert forecast["location"]["id"] == "moscow-default"
    assert forecast["current"]["temperature"] == 22.4
    assert len(forecast["daily"]) == 7
    assert len(forecast["hourly"]) == 12
    assert forecast["daily"][0]["sunrise"].endswith("05:03")


def test_weather_search_preview_and_location_management(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)

    search = client.get("/api/v1/weather/search?q=роттердам")
    assert search.status_code == 200
    candidate = search.json()[0]
    assert candidate["title"] == "Роттердам"

    preview_payload = {
        key: candidate[key]
        for key in ("title", "normalizedAddress", "latitude", "longitude")
    }
    preview = client.post("/api/v1/weather/preview", json=preview_payload)
    assert preview.status_code == 200
    assert preview.json()["location"]["title"] == "Роттердам"

    added = client.post("/api/v1/weather/locations", json=preview_payload)
    assert added.status_code == 201
    location_id = added.json()["id"]

    renamed = client.patch(
        f"/api/v1/weather/locations/{location_id}",
        json={"title": "Роттердам центр"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Роттердам центр"

    defaulted = client.post(f"/api/v1/weather/locations/{location_id}/default")
    assert defaulted.status_code == 200
    assert defaulted.json()["isDefault"] is True

    locations = client.get("/api/v1/weather/locations").json()
    ids = [item["id"] for item in locations]
    reordered = client.put(
        "/api/v1/weather/locations/order",
        json={"locationIds": list(reversed(ids))},
    )
    assert reordered.status_code == 200
    assert [item["id"] for item in reordered.json()] == list(reversed(ids))

    assert client.delete(f"/api/v1/weather/locations/{location_id}").status_code == 200
    remaining = client.get("/api/v1/weather/locations").json()
    assert all(item["id"] != location_id for item in remaining)
    assert remaining[0]["isDefault"] is True


def test_location_store_persists_atomically(tmp_path):
    path = tmp_path / "weather-locations.json"
    store = WeatherLocationStore(path)
    added = store.add(
        WeatherCandidate(
            title="Тест",
            normalizedAddress="Тестовая точка",
            latitude=59.93,
            longitude=30.31,
        )
    )
    store.set_default(added.id)
    store.rename(added.id, "Тест 2")

    restored = WeatherLocationStore(path)
    assert restored.get(added.id).title == "Тест 2"
    assert restored.get().id == added.id
    assert not path.with_suffix(".tmp").exists()


def test_weather_cache_is_scoped_to_location(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    service = WeatherService(mode="production")
    moscow = service.store.get()
    rotterdam = service.store.add(
        WeatherCandidate(
            title="Роттердам",
            normalizedAddress="Роттердам, Нидерланды",
            latitude=51.9244,
            longitude=4.4777,
        )
    )

    moscow_forecast = fixture_forecast(moscow)
    rotterdam_fixture = fixture_forecast(rotterdam)
    rotterdam_forecast = rotterdam_fixture.model_copy(
        update={
            "current": rotterdam_fixture.current.model_copy(
                update={"temperature": 17.1}
            )
        }
    )
    service._memory_cache[moscow.id] = moscow_forecast
    service._memory_cache[rotterdam.id] = rotterdam_forecast

    assert service._cached(moscow).location.id == moscow.id
    assert service._cached(moscow).current.temperature == 22.4
    assert service._cached(rotterdam).location.id == rotterdam.id
    assert service._cached(rotterdam).current.temperature == 17.1


def test_open_meteo_payload_is_sanitized_to_weather_contract():
    payload = {
        "timezone": "Europe/Moscow",
        "timezone_abbreviation": "GMT+3",
        "current": {
            "time": "2026-08-11T14:00",
            "temperature_2m": 21.8,
            "apparent_temperature": 21.2,
            "precipitation": 0.2,
            "weather_code": 61,
            "wind_speed_10m": 12.4,
            "wind_direction_10m": 250,
            "is_day": 1,
            "unexpected_secretish_field": "must-not-leak",
        },
        "hourly": {
            "time": ["2026-08-11T14:00", "2026-08-11T15:00"],
            "temperature_2m": [21.8, 21.2],
            "precipitation_probability": [70, 55],
            "precipitation": [0.2, 0.1],
            "weather_code": [61, 61],
            "wind_speed_10m": [12.4, 11.0],
            "unknown": ["x", "y"],
        },
        "daily": {
            "time": ["2026-08-11"],
            "weather_code": [61],
            "temperature_2m_max": [23.0],
            "temperature_2m_min": [14.0],
            "precipitation_probability_max": [75],
            "sunrise": ["2026-08-11T05:03"],
            "sunset": ["2026-08-11T20:24"],
        },
    }
    candidate = WeatherCandidate(
        title="Москва",
        normalizedAddress="Москва, Россия",
        latitude=55.7558,
        longitude=37.6176,
    )

    forecast = normalize_forecast(payload, candidate)
    dumped = forecast.model_dump()
    assert dumped["current"]["weatherCode"] == 61
    assert dumped["hourly"][0]["precipitationProbability"] == 70
    assert "unexpected_secretish_field" not in dumped["current"]
    assert "unknown" not in dumped["hourly"][0]
