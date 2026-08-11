from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from .contracts import PanelMode


OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "ArtemControlCenter/0.3 (personal weather dashboard)"


class WeatherLocation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{5,39}$")
    title: str = Field(min_length=1, max_length=80)
    normalizedAddress: str = Field(min_length=1, max_length=240)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    isDefault: bool = False
    order: int = Field(ge=0, le=1000)


class WeatherCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)
    normalizedAddress: str = Field(min_length=1, max_length=240)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class WeatherLocationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)


class WeatherOrderPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    locationIds: list[str] = Field(min_length=1, max_length=20)


class WeatherSearchResult(WeatherCandidate):
    model_config = ConfigDict(extra="forbid")

    providerId: str = Field(min_length=1, max_length=120)


class WeatherCurrent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    time: str
    temperature: float
    apparentTemperature: float
    precipitation: float
    weatherCode: int
    windSpeed: float
    windDirection: float
    isDay: bool


class WeatherHour(BaseModel):
    model_config = ConfigDict(extra="forbid")

    time: str
    temperature: float
    precipitationProbability: int
    precipitation: float
    weatherCode: int
    windSpeed: float


class WeatherDay(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str
    weatherCode: int
    temperatureMax: float
    temperatureMin: float
    precipitationProbabilityMax: int
    sunrise: str
    sunset: str


class WeatherForecast(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    location: WeatherLocation | WeatherCandidate
    timezone: str
    timezoneAbbreviation: str
    observedAt: str
    ageSeconds: int = Field(ge=0)
    sourceMode: Literal["live", "cached", "fixture", "stale"]
    stale: bool
    current: WeatherCurrent
    hourly: list[WeatherHour]
    daily: list[WeatherDay]
    attribution: str = "Weather data by Open-Meteo"


class WeatherError(RuntimeError):
    pass


class WeatherLocationStore:
    def __init__(self, path: Path | None, *, fixture: bool = False) -> None:
        self.path = path
        self.fixture = fixture
        self._locations = self._load()

    def _seed(self) -> list[WeatherLocation]:
        return [
            WeatherLocation(
                id="moscow-default",
                title="Москва",
                normalizedAddress="Москва, Россия",
                latitude=55.7558,
                longitude=37.6176,
                isDefault=True,
                order=0,
            )
        ]

    def _load(self) -> list[WeatherLocation]:
        if self.fixture or self.path is None or not self.path.exists():
            return self._seed()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            items = [WeatherLocation.model_validate(item) for item in raw.get("locations", [])]
            return sorted(items, key=lambda item: item.order)
        except Exception:
            return self._seed()

    def _persist(self) -> None:
        if self.fixture or self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "locations": [item.model_dump() for item in self.list()],
        }
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    def list(self) -> list[WeatherLocation]:
        return sorted(self._locations, key=lambda item: item.order)

    def get(self, location_id: str | None = None) -> WeatherLocation:
        if location_id:
            for item in self._locations:
                if item.id == location_id:
                    return item
            raise KeyError(location_id)
        if not self._locations:
            raise KeyError("no-weather-locations")
        return next((item for item in self._locations if item.isDefault), self.list()[0])

    def add(self, candidate: WeatherCandidate) -> WeatherLocation:
        item = WeatherLocation(
            id=f"loc-{uuid.uuid4().hex[:12]}",
            **candidate.model_dump(),
            isDefault=not self._locations,
            order=len(self._locations),
        )
        self._locations.append(item)
        self._persist()
        return item

    def rename(self, location_id: str, title: str) -> WeatherLocation:
        item = self.get(location_id)
        updated = item.model_copy(update={"title": title})
        self._locations = [updated if candidate.id == location_id else candidate for candidate in self._locations]
        self._persist()
        return updated

    def delete(self, location_id: str) -> None:
        item = self.get(location_id)
        remaining = [candidate for candidate in self._locations if candidate.id != location_id]
        if item.isDefault and remaining:
            remaining[0] = remaining[0].model_copy(update={"isDefault": True})
        self._locations = [candidate.model_copy(update={"order": index}) for index, candidate in enumerate(remaining)]
        self._persist()

    def set_default(self, location_id: str) -> WeatherLocation:
        self.get(location_id)
        self._locations = [
            item.model_copy(update={"isDefault": item.id == location_id})
            for item in self._locations
        ]
        self._persist()
        return self.get(location_id)

    def reorder(self, location_ids: list[str]) -> list[WeatherLocation]:
        existing = {item.id: item for item in self._locations}
        if len(location_ids) != len(existing) or set(location_ids) != set(existing):
            raise ValueError("location_order_mismatch")
        self._locations = [existing[location_id].model_copy(update={"order": index}) for index, location_id in enumerate(location_ids)]
        self._persist()
        return self.list()


def _runtime_root() -> Path:
    local = os.getenv("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / "ArtemControlCenter"
    return Path.home() / ".artem-control-center"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _age_seconds(observed_at: str) -> int:
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - observed.astimezone(timezone.utc)).total_seconds()))
    except Exception:
        return 0


def _safe_list(payload: dict[str, Any], section: str, field: str) -> list[Any]:
    value = payload.get(section, {}).get(field, [])
    return value if isinstance(value, list) else []


def normalize_forecast(payload: dict[str, Any], location: WeatherLocation | WeatherCandidate) -> WeatherForecast:
    current = payload.get("current") or {}
    hourly_times = _safe_list(payload, "hourly", "time")
    current_time = str(current.get("time") or (hourly_times[0] if hourly_times else ""))
    start_index = 0
    for index, value in enumerate(hourly_times):
        if str(value) >= current_time:
            start_index = index
            break

    hourly_temperature = _safe_list(payload, "hourly", "temperature_2m")
    hourly_probability = _safe_list(payload, "hourly", "precipitation_probability")
    hourly_precipitation = _safe_list(payload, "hourly", "precipitation")
    hourly_code = _safe_list(payload, "hourly", "weather_code")
    hourly_wind = _safe_list(payload, "hourly", "wind_speed_10m")
    hourly: list[WeatherHour] = []
    for index in range(start_index, min(start_index + 24, len(hourly_times))):
        hourly.append(
            WeatherHour(
                time=str(hourly_times[index]),
                temperature=float(hourly_temperature[index]),
                precipitationProbability=int(hourly_probability[index] or 0),
                precipitation=float(hourly_precipitation[index] or 0),
                weatherCode=int(hourly_code[index]),
                windSpeed=float(hourly_wind[index] or 0),
            )
        )

    daily_dates = _safe_list(payload, "daily", "time")
    daily_codes = _safe_list(payload, "daily", "weather_code")
    daily_max = _safe_list(payload, "daily", "temperature_2m_max")
    daily_min = _safe_list(payload, "daily", "temperature_2m_min")
    daily_probability = _safe_list(payload, "daily", "precipitation_probability_max")
    daily_sunrise = _safe_list(payload, "daily", "sunrise")
    daily_sunset = _safe_list(payload, "daily", "sunset")
    daily = [
        WeatherDay(
            date=str(daily_dates[index]),
            weatherCode=int(daily_codes[index]),
            temperatureMax=float(daily_max[index]),
            temperatureMin=float(daily_min[index]),
            precipitationProbabilityMax=int(daily_probability[index] or 0),
            sunrise=str(daily_sunrise[index]),
            sunset=str(daily_sunset[index]),
        )
        for index in range(min(7, len(daily_dates)))
    ]

    observed_at = _iso_now()
    return WeatherForecast(
        location=location,
        timezone=str(payload.get("timezone") or "GMT"),
        timezoneAbbreviation=str(payload.get("timezone_abbreviation") or ""),
        observedAt=observed_at,
        ageSeconds=0,
        sourceMode="live",
        stale=False,
        current=WeatherCurrent(
            time=current_time,
            temperature=float(current.get("temperature_2m", 0)),
            apparentTemperature=float(current.get("apparent_temperature", current.get("temperature_2m", 0))),
            precipitation=float(current.get("precipitation", 0)),
            weatherCode=int(current.get("weather_code", 0)),
            windSpeed=float(current.get("wind_speed_10m", 0)),
            windDirection=float(current.get("wind_direction_10m", 0)),
            isDay=bool(current.get("is_day", 1)),
        ),
        hourly=hourly,
        daily=daily,
    )


def fixture_forecast(location: WeatherLocation | WeatherCandidate) -> WeatherForecast:
    base = datetime(2026, 8, 11, 14, 0)
    hourly = [
        WeatherHour(
            time=base.replace(hour=(14 + index) % 24).isoformat(timespec="minutes"),
            temperature=22 - index * 0.25,
            precipitationProbability=12 if index < 5 else 28,
            precipitation=0,
            weatherCode=1 if index < 6 else 2,
            windSpeed=9 + (index % 4),
        )
        for index in range(12)
    ]
    daily = [
        WeatherDay(
            date=f"2026-08-{11 + index:02d}",
            weatherCode=[1, 2, 61, 3, 1, 80, 2][index],
            temperatureMax=[24, 23, 19, 21, 25, 22, 23][index],
            temperatureMin=[15, 14, 12, 13, 16, 15, 14][index],
            precipitationProbabilityMax=[15, 25, 78, 35, 10, 65, 20][index],
            sunrise=f"2026-08-{11 + index:02d}T05:03",
            sunset=f"2026-08-{11 + index:02d}T20:24",
        )
        for index in range(7)
    ]
    return WeatherForecast(
        location=location,
        timezone="Europe/Moscow",
        timezoneAbbreviation="GMT+3",
        observedAt="2026-08-11T11:00:00+00:00",
        ageSeconds=0,
        sourceMode="fixture",
        stale=False,
        current=WeatherCurrent(
            time="2026-08-11T14:00",
            temperature=22.4,
            apparentTemperature=22.1,
            precipitation=0,
            weatherCode=1,
            windSpeed=11.2,
            windDirection=248,
            isDay=True,
        ),
        hourly=hourly,
        daily=daily,
    )


class WeatherService:
    def __init__(self, *, mode: PanelMode) -> None:
        self.mode = mode
        root = _runtime_root()
        self.store = WeatherLocationStore(
            None if mode in {"fixtures", "integration_test"} else root / "weather-locations.json",
            fixture=mode in {"fixtures", "integration_test"},
        )
        self.cache_root = root / "weather-cache"
        self.refresh_seconds = max(60, int(os.getenv("PANEL_WEATHER_REFRESH_SECONDS", "900")))
        self.request_timeout_seconds = max(2, int(os.getenv("PANEL_WEATHER_TIMEOUT_SECONDS", "10")))
        self.forecast_url = os.getenv("PANEL_WEATHER_FORECAST_URL", OPEN_METEO_URL).strip()
        self.geocode_url = os.getenv("PANEL_WEATHER_GEOCODE_URL", NOMINATIM_URL).strip()
        self._memory_cache: dict[str, WeatherForecast] = {}
        self._geocode_lock = asyncio.Lock()
        self._last_geocode_at = 0.0

    def locations(self) -> list[WeatherLocation]:
        return self.store.list()

    def _cache_key(self, location: WeatherLocation | WeatherCandidate) -> str:
        if isinstance(location, WeatherLocation):
            return location.id
        return f"preview-{location.latitude:.4f}-{location.longitude:.4f}"

    def _cache_path(self, location: WeatherLocation) -> Path:
        return self.cache_root / f"{location.id}.json"

    def _load_disk_cache(self, location: WeatherLocation) -> WeatherForecast | None:
        path = self._cache_path(location)
        if not path.exists():
            return None
        try:
            forecast = WeatherForecast.model_validate_json(path.read_text(encoding="utf-8"))
            if (
                abs(forecast.location.latitude - location.latitude) > 0.0001
                or abs(forecast.location.longitude - location.longitude) > 0.0001
            ):
                return None
            return forecast.model_copy(update={"location": location})
        except Exception:
            return None

    def _persist_cache(self, location: WeatherLocation, forecast: WeatherForecast) -> None:
        self.cache_root.mkdir(parents=True, exist_ok=True)
        path = self._cache_path(location)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(forecast.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, path)

    def _cached(self, location: WeatherLocation | WeatherCandidate) -> WeatherForecast | None:
        key = self._cache_key(location)
        forecast = self._memory_cache.get(key)
        if forecast is None and isinstance(location, WeatherLocation):
            forecast = self._load_disk_cache(location)
            if forecast is not None:
                self._memory_cache[key] = forecast
        if forecast is None:
            return None
        age = _age_seconds(forecast.observedAt)
        return forecast.model_copy(update={"ageSeconds": age})

    async def forecast(
        self,
        *,
        location_id: str | None = None,
        candidate: WeatherCandidate | None = None,
        force: bool = False,
    ) -> WeatherForecast:
        location: WeatherLocation | WeatherCandidate
        if candidate is not None:
            location = candidate
        else:
            try:
                location = self.store.get(location_id)
            except KeyError as exc:
                raise WeatherError("weather_location_not_found") from exc

        if self.mode in {"fixtures", "integration_test"}:
            return fixture_forecast(location)

        cached = self._cached(location)
        if cached is not None and not force and cached.ageSeconds < self.refresh_seconds:
            return cached.model_copy(update={"sourceMode": "cached", "stale": False})

        params = {
            "latitude": location.latitude,
            "longitude": location.longitude,
            "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day",
            "hourly": "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
            "timezone": "auto",
            "forecast_days": 7,
        }
        try:
            async with httpx.AsyncClient(timeout=self.request_timeout_seconds, headers={"User-Agent": USER_AGENT}) as client:
                response = await client.get(self.forecast_url, params=params)
                response.raise_for_status()
                payload = response.json()
            result = normalize_forecast(payload, location)
            self._memory_cache[self._cache_key(location)] = result
            if isinstance(location, WeatherLocation):
                self._persist_cache(location, result)
            return result
        except Exception as exc:
            if cached is not None:
                return cached.model_copy(update={"sourceMode": "stale", "stale": True})
            raise WeatherError("weather_provider_unavailable") from exc

    async def search(self, query: str) -> list[WeatherSearchResult]:
        normalized = " ".join(query.split()).strip()
        if len(normalized) < 2:
            return []
        if self.mode in {"fixtures", "integration_test"}:
            fixture = [
                WeatherSearchResult(
                    providerId="fixture-moscow",
                    title="Москва",
                    normalizedAddress="Москва, Центральный федеральный округ, Россия",
                    latitude=55.7558,
                    longitude=37.6176,
                ),
                WeatherSearchResult(
                    providerId="fixture-rotterdam",
                    title="Роттердам",
                    normalizedAddress="Роттердам, Южная Голландия, Нидерланды",
                    latitude=51.9244,
                    longitude=4.4777,
                ),
            ]
            lowered = normalized.lower()
            return [item for item in fixture if lowered in item.title.lower() or lowered in item.normalizedAddress.lower()]

        async with self._geocode_lock:
            wait = 1.05 - (time.monotonic() - self._last_geocode_at)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                async with httpx.AsyncClient(timeout=self.request_timeout_seconds, headers={"User-Agent": USER_AGENT}) as client:
                    response = await client.get(
                        self.geocode_url,
                        params={
                            "q": normalized,
                            "format": "jsonv2",
                            "addressdetails": 1,
                            "limit": 5,
                            "accept-language": "ru",
                        },
                    )
                    response.raise_for_status()
                    payload = response.json()
            except Exception as exc:
                raise WeatherError("weather_geocoder_unavailable") from exc
            finally:
                self._last_geocode_at = time.monotonic()

        results: list[WeatherSearchResult] = []
        for item in payload if isinstance(payload, list) else []:
            try:
                address = item.get("address") or {}
                title = (
                    item.get("name")
                    or address.get("city")
                    or address.get("town")
                    or address.get("village")
                    or address.get("municipality")
                    or str(item.get("display_name", "")).split(",", 1)[0]
                )
                results.append(
                    WeatherSearchResult(
                        providerId=str(item.get("place_id") or item.get("osm_id") or uuid.uuid4().hex),
                        title=str(title)[:80],
                        normalizedAddress=str(item.get("display_name") or title)[:240],
                        latitude=float(item["lat"]),
                        longitude=float(item["lon"]),
                    )
                )
            except Exception:
                continue
        return results[:5]


def build_weather_router(service: WeatherService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/weather", tags=["weather"])

    def no_store(response: Response) -> None:
        response.headers["Cache-Control"] = "no-store"

    @router.get("/locations", response_model=list[WeatherLocation])
    async def locations(response: Response) -> list[WeatherLocation]:
        no_store(response)
        return service.locations()

    @router.get("", response_model=WeatherForecast)
    async def forecast(
        response: Response,
        locationId: str | None = Query(default=None, max_length=40),
        refresh: bool = False,
    ) -> WeatherForecast:
        no_store(response)
        try:
            return await service.forecast(location_id=locationId, force=refresh)
        except WeatherError as exc:
            code = str(exc)
            raise HTTPException(status_code=404 if code == "weather_location_not_found" else 503, detail=code)

    @router.get("/search", response_model=list[WeatherSearchResult])
    async def search(
        response: Response,
        q: str = Query(min_length=2, max_length=120),
    ) -> list[WeatherSearchResult]:
        no_store(response)
        try:
            return await service.search(q)
        except WeatherError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @router.post("/preview", response_model=WeatherForecast)
    async def preview(candidate: WeatherCandidate, response: Response) -> WeatherForecast:
        no_store(response)
        try:
            return await service.forecast(candidate=candidate, force=True)
        except WeatherError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @router.post("/locations", response_model=WeatherLocation, status_code=201)
    async def add_location(candidate: WeatherCandidate, response: Response) -> WeatherLocation:
        no_store(response)
        return service.store.add(candidate)

    @router.patch("/locations/{location_id}", response_model=WeatherLocation)
    async def rename_location(location_id: str, patch: WeatherLocationPatch, response: Response) -> WeatherLocation:
        no_store(response)
        try:
            return service.store.rename(location_id, patch.title)
        except KeyError:
            raise HTTPException(status_code=404, detail="weather_location_not_found")

    @router.delete("/locations/{location_id}")
    async def delete_location(location_id: str, response: Response) -> dict[str, bool]:
        no_store(response)
        try:
            service.store.delete(location_id)
            return {"ok": True}
        except KeyError:
            raise HTTPException(status_code=404, detail="weather_location_not_found")

    @router.post("/locations/{location_id}/default", response_model=WeatherLocation)
    async def set_default(location_id: str, response: Response) -> WeatherLocation:
        no_store(response)
        try:
            return service.store.set_default(location_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="weather_location_not_found")

    @router.put("/locations/order", response_model=list[WeatherLocation])
    async def reorder(patch: WeatherOrderPatch, response: Response) -> list[WeatherLocation]:
        no_store(response)
        try:
            return service.store.reorder(patch.locationIds)
        except ValueError:
            raise HTTPException(status_code=409, detail="weather_location_order_mismatch")

    return router
