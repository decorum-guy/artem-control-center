"""MET Norway Locationforecast for panels configured to use it."""

from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from astral import Observer
from astral.sun import elevation, sunrise, sunset

FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/complete"
MODEL_MAX_AGE = timedelta(hours=16)
MIN_FETCH_INTERVAL = timedelta(hours=3)
UTC = timezone.utc


def _instant(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)


def _symbol_code(symbol: str) -> int:
    name = symbol.split("_")[0]
    if "thunder" in name:
        return 95
    if "snow" in name:
        if "showers" in name:
            return 86 if "heavy" in name else 85
        return 75 if "heavy" in name else 71 if "light" in name else 73
    if "sleet" in name:
        return 68
    if "rain" in name:
        if "showers" in name:
            return 82 if "heavy" in name else 80
        return 65 if "heavy" in name else 61 if "light" in name else 63
    return {"clearsky": 0, "fair": 1, "partlycloudy": 2, "cloudy": 3, "fog": 45}.get(name, -1)


def _time_zone(latitude: float, longitude: float, preferred: str | None) -> ZoneInfo:
    if preferred:
        try:
            return ZoneInfo(preferred)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    from tzfpy import get_tz

    return ZoneInfo(get_tz(longitude, latitude) or "UTC")


def _solar_time(event, observer: Observer, day, zone: ZoneInfo) -> str | None:
    try:
        return event(observer, date=day, tzinfo=zone).isoformat(timespec="minutes")
    except ValueError:  # Polar day or night.
        return None


def project_forecast(properties, latitude, longitude, now: datetime, preferred_zone=None):
    zone = _time_zone(latitude, longitude, preferred_zone)
    observer = Observer(latitude=latitude, longitude=longitude)
    updated = _instant(properties["meta"]["updated_at"])
    if updated > now + timedelta(minutes=10):
        raise ValueError("forecast model time is in the future")
    by_day = defaultdict(list)
    hours = []
    current = None
    for point in properties["timeseries"]:
        when = _instant(point["time"])
        local = when.astimezone(zone)
        if local.date() < now.astimezone(zone).date():
            continue
        data = point["data"]
        details = data["instant"]["details"]
        hourly = data.get("next_1_hours")
        period = hourly or data.get("next_6_hours")
        if not period:
            continue
        values = period["details"]
        temperature = details["air_temperature"]
        code = _symbol_code(period["summary"]["symbol_code"])
        by_day[local.date()].append((local, temperature, code, values, 1 if hourly else 6))
        if not hourly or when > now + timedelta(hours=24) or when + timedelta(hours=1) <= now:
            continue
        row = dict(
            time=local.isoformat(timespec="minutes"), temperature=temperature,
            precipitationProbability=values.get("probability_of_precipitation"),
            precipitation=values["precipitation_amount"], weatherCode=code,
            windSpeed=round(details["wind_speed"] * 3.6, 1),
        )
        hours.append(row)
        if when <= now:
            current = {k: row[k] for k in ("time", "temperature", "precipitation", "weatherCode", "windSpeed")}
            current.update(apparentTemperature=details.get("apparent_air_temperature"),
                           windDirection=details["wind_from_direction"], isDay=elevation(observer, now) >= -0.833)
    if current is None:
        raise ValueError("forecast does not cover the current hour")

    daily = []
    for day, rows in sorted(by_day.items())[:7]:
        temperatures = [row[1] for row in rows]
        probabilities = [row[3]["probability_of_precipitation"] for row in rows if "probability_of_precipitation" in row[3]]
        representative = min(rows, key=lambda row: abs(row[0].hour - 12))
        # A truncated day or a six-hour interval crossing local midnight does
        # not provide a measured total for this calendar day.
        start = datetime.combine(day, datetime.min.time(), zone).astimezone(UTC)
        end = datetime.combine(day + timedelta(days=1), datetime.min.time(), zone).astimezone(UTC)
        covered_until = start
        amount = 0.0
        for local, _, _, values, duration in rows:
            instant = local.astimezone(UTC)
            step_end = instant + timedelta(hours=duration)
            if step_end <= end:
                temperatures.extend(values[k] for k in ("air_temperature_min", "air_temperature_max") if k in values)
            if instant == covered_until and step_end <= end and "precipitation_amount" in values:
                covered_until = step_end
                amount += values["precipitation_amount"]
        daily.append(dict(
            date=day.isoformat(), weatherCode=representative[2],
            temperatureMax=max(temperatures), temperatureMin=min(temperatures),
            precipitationProbabilityMax=max(probabilities, default=None),
            precipitationTotal=round(amount, 1) if covered_until == end else None,
            sunrise=_solar_time(sunrise, observer, day, zone), sunset=_solar_time(sunset, observer, day, zone),
        ))
    age = max(0, int((now - updated).total_seconds()))
    stale = now - updated > MODEL_MAX_AGE
    return dict(
        provider="metno", timezone=zone.key, timezoneAbbreviation=now.astimezone(zone).tzname(),
        observedAt=updated.isoformat(), ageSeconds=age, sourceMode="stale" if stale else "live",
        stale=stale, current=current, hourly=hours[:24], daily=daily,
        attribution="Прогноз MET Norway (CC BY 4.0). Суточные значения рассчитаны по интервалам прогноза.",
    )


class MetNoProvider:
    def __init__(self):
        self._recent: dict[str, dict] = {}
        self._lock: asyncio.Lock | None = None

    async def forecast(self, client: httpx.AsyncClient, latitude: float, longitude: float,
                       cache_root: Path | None, preferred_zone: str | None):
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            now = datetime.now(UTC)
            key = f"{latitude:.4f},{longitude:.4f}"
            path = cache_root / f"metno-{key}.json" if cache_root else None
            entry = self._recent.get(key)
            if entry is None and path is not None:
                try:
                    entry = json.loads(path.read_text("utf-8"))
                    _instant(entry["expires"])
                    if not isinstance(entry["properties"]["timeseries"], list):
                        raise ValueError("invalid forecast")
                except (OSError, TypeError, ValueError, KeyError):
                    entry = None
            if entry and now < _instant(entry["expires"]):
                try:
                    result = project_forecast(entry["properties"], latitude, longitude, now, preferred_zone)
                except (ValueError, KeyError, IndexError, TypeError):
                    entry = None
                else:
                    if not result["stale"]:
                        result["sourceMode"] = "cached"
                    return result
            headers = {"If-Modified-Since": entry["modified"]} if entry and entry.get("modified") else {}
            try:
                response = await client.get(
                    FORECAST_URL, params={"lat": f"{latitude:.4f}", "lon": f"{longitude:.4f}"}, headers=headers,
                )
                if response.status_code == 304 and entry:
                    properties = entry["properties"]
                else:
                    response.raise_for_status()
                    properties = response.json()["properties"]
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                if not entry:
                    raise
                result = project_forecast(entry["properties"], latitude, longitude, now, preferred_zone)
                return dict(result, stale=True, sourceMode="stale")
            result = project_forecast(properties, latitude, longitude, now, preferred_zone)
            expires = now + MIN_FETCH_INTERVAL
            if response.headers.get("expires"):
                expires = max(expires, parsedate_to_datetime(response.headers["expires"]))
            entry = {"properties": properties, "expires": expires.isoformat(),
                     "modified": response.headers.get("last-modified") or (entry or {}).get("modified")}
            if len(self._recent) >= 20 and key not in self._recent:
                self._recent.pop(next(iter(self._recent)))
            self._recent[key] = entry
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps(entry, separators=(",", ":")), "utf-8")
                os.replace(temporary, path)
            return result
