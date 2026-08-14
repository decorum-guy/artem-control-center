import { describe, expect, it } from "vitest";
import { composeWeather } from "./weatherCompositor";
import {
  presentWeatherCondition,
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
    expect(weatherLabel(7)).toBe("Погода меняется");
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
});
