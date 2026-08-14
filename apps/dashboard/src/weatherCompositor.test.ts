import { describe, expect, it } from "vitest";
import {
  composeWeather,
  phaseTransform,
  WEATHER_LOOP_GEOMETRY,
  WEATHER_MOTION_LAYER_MAX
} from "./weatherCompositor";

describe("weather compositor geometry", () => {
  it("uses exact one-tile translations for every moving plane", () => {
    for (const geometry of Object.values(WEATHER_LOOP_GEOMETRY)) {
      expect(Math.abs(geometry.translationX)).toBe(geometry.tileWidth);
      if (geometry.translationY !== 0) expect(Math.abs(geometry.translationY)).toBe(geometry.tileHeight);
    }
    expect(WEATHER_LOOP_GEOMETRY.clouds.translationY).toBe(0);
  });

  it("exposes deterministic before, zero and endpoint transforms", () => {
    const geometry = WEATHER_LOOP_GEOMETRY.rain;
    expect(phaseTransform(geometry, "zero")).toBe("translate3d(0px, 0px, 0px)");
    expect(phaseTransform(geometry, "end")).toBe("translate3d(-24px, 72px, 0px)");
    expect(phaseTransform(geometry, "before")).toBe("translate3d(-23.976px, 71.928px, 0px)");
    expect(phaseTransform(geometry, "live")).toBe("");
  });

  it("composes every moving condition without exceeding two continuously animated layers", () => {
    for (const weatherCode of [2, 3, 45, 61, 95, 73]) {
      const model = composeWeather({ weatherCode, isDay: true });
      expect(model.movingLayerCount).toBeLessThanOrEqual(WEATHER_MOTION_LAYER_MAX);
    }
  });
});
