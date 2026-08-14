export type WeatherKind = "clear" | "partly" | "cloudy" | "fog" | "rain" | "snow" | "storm" | "unknown";

export type WeatherCelestialBody = "sun" | "moon" | null;

export type WeatherStaticLayer =
  | "sun"
  | "sun-rays"
  | "moon"
  | "stars"
  | "cloud-mass"
  | "neutral";

export type WeatherMovingLayer = "clouds" | "fog-far" | "fog-near" | "rain" | "snow-far" | "snow-near";

const CONDITION_LABELS: Readonly<Record<number, string>> = {
  0: "Ясно",
  1: "Преимущественно ясно",
  2: "Переменная облачность",
  3: "Облачно",
  45: "Туман",
  48: "Туман",
  51: "Морось",
  53: "Морось",
  55: "Морось",
  56: "Морось",
  57: "Морось",
  61: "Дождь",
  63: "Дождь",
  65: "Дождь",
  66: "Дождь",
  67: "Дождь",
  71: "Снег",
  73: "Снег",
  75: "Снег",
  77: "Снег",
  80: "Ливни",
  81: "Ливни",
  82: "Ливни",
  85: "Снегопад",
  86: "Снегопад",
  95: "Гроза",
  96: "Гроза",
  99: "Гроза"
};

/**
 * The backend owns WMO numeric codes. This map is the only place where those
 * provider values become the bounded visual vocabulary used by the route.
 */
export function weatherKind(code: number): WeatherKind {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "unknown";
}

/** Keep condition truth visible even when the compositor falls back. */
export function weatherLabel(code: number): string {
  return CONDITION_LABELS[code] ?? "Погода меняется";
}

export interface WeatherConditionPresentation {
  kind: WeatherKind;
  isDay: boolean;
  label: string;
  heroTone: string;
  celestialBody: WeatherCelestialBody;
  staticLayers: readonly WeatherStaticLayer[];
  movingLayers: readonly WeatherMovingLayer[];
}

function staticLayersFor(kind: WeatherKind, isDay: boolean): readonly WeatherStaticLayer[] {
  if (kind === "clear") return isDay ? ["sun", "sun-rays"] : ["moon", "stars"];
  if (kind === "partly") return isDay ? ["sun"] : ["moon"];
  if (kind === "rain" || kind === "storm") return ["cloud-mass"];
  if (kind === "unknown") return ["neutral"];
  return [];
}

function movingLayersFor(kind: WeatherKind): readonly WeatherMovingLayer[] {
  if (kind === "partly" || kind === "cloudy") return ["clouds"];
  if (kind === "fog") return ["fog-far", "fog-near"];
  if (kind === "rain" || kind === "storm") return ["rain"];
  if (kind === "snow") return ["snow-far", "snow-near"];
  return [];
}

/**
 * Pure condition presentation. `isDay` is a trusted backend input and is
 * deliberately used for palette, celestial glyph, and contrast tone.
 */
export function presentWeatherCondition(input: {
  weatherCode: number;
  isDay: boolean;
  label?: string;
}): WeatherConditionPresentation {
  const kind = weatherKind(input.weatherCode);
  const isDay = Boolean(input.isDay);
  const celestialBody = kind === "clear" || kind === "partly" ? (isDay ? "sun" : "moon") : null;

  return {
    kind,
    isDay,
    label: input.label ?? weatherLabel(input.weatherCode),
    heroTone: `${kind}-${isDay ? "day" : "night"}`,
    celestialBody,
    staticLayers: staticLayersFor(kind, isDay),
    movingLayers: movingLayersFor(kind)
  };
}
