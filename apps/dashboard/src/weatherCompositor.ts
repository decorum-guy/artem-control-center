import {
  presentWeatherCondition,
  type WeatherConditionPresentation,
  type WeatherMovingLayer
} from "./weatherPresentation";

export type WeatherPhase = "live" | "before" | "zero" | "end";

export const WEATHER_PHASES: readonly WeatherPhase[] = ["live", "before", "zero", "end"];

export const WEATHER_MOTION_LAYER_MAX = 2;

export interface WeatherLoopGeometry {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly translationX: number;
  readonly translationY: number;
  readonly durationMs: number;
}

/**
 * Every moving plane owns its repeat dimensions. CSS mirrors these exact
 * values; tests use them to prove the endpoint is a one-tile translation.
 */
export const WEATHER_LOOP_GEOMETRY: Readonly<Record<WeatherMovingLayer, WeatherLoopGeometry>> = {
  clouds: {
    tileWidth: 560,
    tileHeight: 160,
    translationX: -560,
    translationY: 0,
    durationMs: 60_000
  },
  "fog-far": {
    tileWidth: 420,
    tileHeight: 160,
    translationX: -420,
    translationY: 0,
    durationMs: 52_000
  },
  "fog-near": {
    tileWidth: 520,
    tileHeight: 180,
    translationX: -520,
    translationY: 0,
    durationMs: 60_000
  },
  rain: {
    tileWidth: 24,
    tileHeight: 72,
    translationX: -24,
    translationY: 72,
    durationMs: 1_800
  },
  "snow-far": {
    tileWidth: 64,
    tileHeight: 96,
    translationX: -64,
    translationY: 96,
    durationMs: 19_000
  },
  "snow-near": {
    tileWidth: 40,
    tileHeight: 80,
    translationX: -40,
    translationY: 80,
    durationMs: 12_000
  }
};

export interface WeatherCompositorModel extends WeatherConditionPresentation {
  movingLayerCount: number;
  maxMovingLayerCount: number;
  loopGeometry: Readonly<Partial<Record<WeatherMovingLayer, WeatherLoopGeometry>>>;
}

/** Pure source-owned compositor model used by the route and unit tests. */
export function composeWeather(input: {
  weatherCode: number;
  isDay: boolean;
  label?: string;
}): WeatherCompositorModel {
  const presentation = presentWeatherCondition(input);
  const movingLayerCount = presentation.movingLayers.length;

  return {
    ...presentation,
    movingLayerCount,
    maxMovingLayerCount: WEATHER_MOTION_LAYER_MAX,
    loopGeometry: Object.fromEntries(
      presentation.movingLayers.map((layer) => [layer, WEATHER_LOOP_GEOMETRY[layer]])
    )
  };
}

/**
 * Deterministic synthetic review phase. Only the fixed enum is accepted; no
 * caller can inject arbitrary transforms into production presentation.
 */
export function readWeatherPhase(search = typeof window === "undefined" ? "" : window.location.search): WeatherPhase {
  if (!import.meta.env.DEV) return "live";
  const value = new URLSearchParams(search).get("weatherPhase");
  return WEATHER_PHASES.includes(value as WeatherPhase) ? value as WeatherPhase : "live";
}

export function phaseTransform(geometry: WeatherLoopGeometry, phase: WeatherPhase): string {
  if (phase === "zero") return "translate3d(0px, 0px, 0px)";
  if (phase === "end") return `translate3d(${geometry.translationX}px, ${geometry.translationY}px, 0px)`;
  if (phase === "before") {
    const epsilon = 0.001;
    const x = geometry.translationX * (1 - epsilon);
    const y = geometry.translationY * (1 - epsilon);
    return `translate3d(${x}px, ${y}px, 0px)`;
  }
  return "";
}
