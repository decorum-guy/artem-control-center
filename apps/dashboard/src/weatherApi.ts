export interface WeatherLocation {
  id: string;
  title: string;
  normalizedAddress: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
  order: number;
}

export interface WeatherCandidate {
  title: string;
  normalizedAddress: string;
  latitude: number;
  longitude: number;
}

export interface WeatherSearchResult extends WeatherCandidate {
  providerId: string;
}

export interface WeatherCurrent {
  time: string;
  temperature: number;
  apparentTemperature: number;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
  windDirection: number;
  isDay: boolean;
}

export interface WeatherHour {
  time: string;
  temperature: number;
  precipitationProbability: number;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
}

export interface WeatherDay {
  date: string;
  weatherCode: number;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbabilityMax: number;
  sunrise: string;
  sunset: string;
}

export interface WeatherForecast {
  schemaVersion: 1;
  location: WeatherLocation | WeatherCandidate;
  timezone: string;
  timezoneAbbreviation: string;
  observedAt: string;
  ageSeconds: number;
  sourceMode: "live" | "cached" | "fixture" | "stale";
  stale: boolean;
  current: WeatherCurrent;
  hourly: WeatherHour[];
  daily: WeatherDay[];
  attribution: string;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `weather_request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the bounded status-based error.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchWeatherLocations(): Promise<WeatherLocation[]> {
  return json<WeatherLocation[]>(await fetch("/api/v1/weather/locations", { cache: "no-store" }));
}

export async function fetchWeather(locationId?: string, refresh = false): Promise<WeatherForecast> {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", locationId);
  if (refresh) params.set("refresh", "true");
  const suffix = params.size ? `?${params.toString()}` : "";
  return json<WeatherForecast>(await fetch(`/api/v1/weather${suffix}`, { cache: "no-store" }));
}

export async function searchWeatherLocations(query: string): Promise<WeatherSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  return json<WeatherSearchResult[]>(await fetch(`/api/v1/weather/search?${params}`, { cache: "no-store" }));
}

export async function previewWeather(candidate: WeatherCandidate): Promise<WeatherForecast> {
  return json<WeatherForecast>(await fetch("/api/v1/weather/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(candidate)
  }));
}

export async function addWeatherLocation(candidate: WeatherCandidate): Promise<WeatherLocation> {
  return json<WeatherLocation>(await fetch("/api/v1/weather/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(candidate)
  }));
}

export async function renameWeatherLocation(locationId: string, title: string): Promise<WeatherLocation> {
  return json<WeatherLocation>(await fetch(`/api/v1/weather/locations/${encodeURIComponent(locationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  }));
}

export async function deleteWeatherLocation(locationId: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/v1/weather/locations/${encodeURIComponent(locationId)}`, {
    method: "DELETE"
  }));
}

export async function setDefaultWeatherLocation(locationId: string): Promise<WeatherLocation> {
  return json<WeatherLocation>(await fetch(`/api/v1/weather/locations/${encodeURIComponent(locationId)}/default`, {
    method: "POST"
  }));
}

export async function reorderWeatherLocations(locationIds: string[]): Promise<WeatherLocation[]> {
  return json<WeatherLocation[]>(await fetch("/api/v1/weather/locations/order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locationIds })
  }));
}
