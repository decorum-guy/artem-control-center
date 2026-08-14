import { describe, expect, it } from "vitest";
import { composeWeather } from "./weatherCompositor";
import {
  presentWeatherCondition,
  resolveWeatherHourPhase,
  weatherKind,
  weatherLabel,
  type WeatherKind
} from "./weatherPresentation";

describe("weather presentation", () => {
  it.each([
    [0, "clear", "Ясно"],
    [1, "partly", "Преимущественно ясно"],
    [2, "partly", "Переменная облачность"],
    [3, "cloudy", "Облачно"],
    [45, "fog", "Туман"],
    [48, "fog", "Туман"],
    [51, "rain", "Морось"],
    [61, "rain", "Дождь"],
    [80, "rain", "Ливни"],
    [71, "snow", "Снег"],
    [85, "snow", "Снегопад"],
    [95, "storm", "Гроза"],
    [96, "storm", "Гроза"],
    [99, "storm", "Гроза"]
  ] as const)("maps WMO %s to the fixed %s vocabulary", (code, kind, label) => {
    expect(weatherKind(code)).toBe(kind);
    expect(weatherLabel(code)).toBe(label);
  });

  it("uses the safe generic fallback for an unrecognized provider code", () => {
    expect(weatherKind(7)).toBe("unknown");
    expect(weatherLabel(7)).toBe("Условия не определены");
    const presentation = presentWeatherCondition({ weatherCode: 7, isDay: false, label: "Код провайдера 7" });
    expect(presentation.kind).toBe("unknown");
    expect(presentation.label).toBe("Код провайдера 7");
    expect(presentation.movingLayers).toEqual([]);
    expect(presentation.celestialBody).toBeNull();
  });

  it("uses isDay for palette tone and the celestial body, not for copy", () => {
    const day = presentWeatherCondition({ weatherCode: 0, isDay: true });
    const night = presentWeatherCondition({ weatherCode: 0, isDay: false });
    expect(day.heroTone).toBe("clear-day");
    expect(night.heroTone).toBe("clear-night");
    expect(day.celestialBody).toBe("sun");
    expect(night.celestialBody).toBe("moon");
    expect(day.label).toBe(night.label);
    expect(day.movingLayers).toEqual([]);
  });

  it.each([
    ["clear", 0],
    ["partly", 1],
    ["cloudy", 1],
    ["fog", 2],
    ["rain", 1],
    ["storm", 1],
    ["snow", 2]
  ] as const)("keeps %s at or below the two-layer ambience budget", (kind, expectedMovingCount) => {
    const codeByKind: Record<Exclude<WeatherKind, "unknown">, number> = {
      clear: 0,
      partly: 2,
      cloudy: 3,
      fog: 45,
      rain: 61,
      storm: 95,
      snow: 73
    };
    const model = composeWeather({ weatherCode: codeByKind[kind], isDay: true });
    expect(model.movingLayerCount).toBe(expectedMovingCount);
    expect(model.movingLayerCount).toBeLessThanOrEqual(model.maxMovingLayerCount);
    expect(model.maxMovingLayerCount).toBe(2);
  });

  it("is deterministic and keeps semantic labels independent of animation", () => {
    const input = { weatherCode: 61, isDay: false, label: "Дождь" };
    const first = composeWeather(input);
    const second = composeWeather(input);
    expect(first).toEqual(second);
    expect(first.label).toBe("Дождь");
    expect(first.movingLayers).toEqual(["rain"]);
  });

  it("resolves future local provider timestamps across the trusted sunset window", () => {
    const daylight = [{
      date: "2026-08-11",
      sunrise: "2026-08-11T05:03",
      sunset: "2026-08-11T20:24"
    }];

    expect(resolveWeatherHourPhase("2026-08-11T04:00", daylight, "Europe/Moscow")).toBe("night");
    expect(resolveWeatherHourPhase("2026-08-11T06:00", daylight, "Europe/Moscow")).toBe("day");
    expect(resolveWeatherHourPhase("2026-08-11T20:00", daylight, "Europe/Moscow")).toBe("day");
    expect(resolveWeatherHourPhase("2026-08-11T21:00", daylight, "Europe/Moscow")).toBe("night");
  });

  it("compares offset-bearing provider timestamps as absolute instants", () => {
    const daylight = [{
      date: "2026-08-11",
      sunrise: "2026-08-11T05:03",
      sunset: "2026-08-11T20:24"
    }];

    expect(resolveWeatherHourPhase("2026-08-11T17:00:00Z", daylight, "Europe/Moscow")).toBe("day");
    expect(resolveWeatherHourPhase("2026-08-11T18:00:00Z", daylight, "Europe/Moscow")).toBe("night");
  });

  it("returns the neutral phase when the trusted daylight window cannot be resolved", () => {
    expect(resolveWeatherHourPhase(
      "2026-08-12T12:00",
      [{ date: "2026-08-11", sunrise: "bad", sunset: "bad" }],
      "Europe/Moscow"
    )).toBe("neutral");
  });
});
