import type { WeatherForecast } from "./weatherApi";

export const WEATHER_FIXTURE_IDS = [
  "clear-day",
  "clear-night",
  "partly-day",
  "partly-night",
  "cloudy",
  "fog",
  "rain-day",
  "rain-night",
  "storm",
  "snow-day",
  "snow-night",
  "stale",
  "offline",
  "long-location"
] as const;

export type WeatherFixtureId = typeof WEATHER_FIXTURE_IDS[number];

const FIXTURE_CONDITIONS: Readonly<Partial<Record<WeatherFixtureId, { weatherCode: number; isDay: boolean }>>> = {
  "clear-day": { weatherCode: 0, isDay: true },
  "clear-night": { weatherCode: 0, isDay: false },
  "partly-day": { weatherCode: 2, isDay: true },
  "partly-night": { weatherCode: 2, isDay: false },
  cloudy: { weatherCode: 3, isDay: true },
  fog: { weatherCode: 45, isDay: true },
  "rain-day": { weatherCode: 61, isDay: true },
  "rain-night": { weatherCode: 61, isDay: false },
  storm: { weatherCode: 95, isDay: false },
  "snow-day": { weatherCode: 73, isDay: true },
  "snow-night": { weatherCode: 73, isDay: false },
  stale: { weatherCode: 61, isDay: false },
  "long-location": { weatherCode: 0, isDay: true }
};

export interface WeatherFixtureResult {
  forecast: WeatherForecast | null;
  offline: boolean;
}

export function readWeatherFixtureId(search = typeof window === "undefined" ? "" : window.location.search): WeatherFixtureId | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(search).get("weatherFixture");
  return WEATHER_FIXTURE_IDS.includes(value as WeatherFixtureId) ? value as WeatherFixtureId : null;
}

/**
 * Synthetic review data is intentionally bounded to the fixed enum above and
 * only adjusts fields already present in the trusted Weather contract.
 */
export function applyWeatherFixture(forecast: WeatherForecast, fixture: WeatherFixtureId): WeatherFixtureResult {
  if (fixture === "offline") return { forecast: null, offline: true };

  const condition = FIXTURE_CONDITIONS[fixture];
  const next: WeatherForecast = {
    ...forecast,
    location: fixture === "long-location"
      ? { ...forecast.location, title: "Санкт-Петербургский городской округ и пригородные районы" }
      : forecast.location,
    current: condition
      ? { ...forecast.current, weatherCode: condition.weatherCode, isDay: condition.isDay }
      : forecast.current,
    hourly: condition
      ? forecast.hourly.map((hour) => ({ ...hour, weatherCode: condition.weatherCode }))
      : forecast.hourly,
    daily: condition
      ? forecast.daily.map((day) => ({ ...day, weatherCode: condition.weatherCode }))
      : forecast.daily,
    stale: fixture === "stale" ? true : forecast.stale,
    sourceMode: fixture === "stale" ? "stale" : forecast.sourceMode,
    ageSeconds: fixture === "stale" ? Math.max(forecast.ageSeconds, 7_200) : forecast.ageSeconds
  };

  return { forecast: next, offline: false };
}
