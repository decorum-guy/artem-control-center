import { describe, expect, it } from "vitest";
import { overviewWidgetRegistry, resolveOverviewWidgetSize } from "./overviewRegistry";

describe("Overview V2 fixed registry", () => {
  it("contains only the bounded PR3 widget vocabulary", () => {
    expect(overviewWidgetRegistry.map((entry) => entry.widgetType)).toEqual([
      "home.coffee-machine",
      "home.climate",
      "system.rog-g703-operational",
      "planning.summary",
      "home.quick-actions",
      "system.health-summary",
      "weather.alert",
      "planning.calendar-agenda",
      "planning.task-list"
    ]);
  });

  it("declares the normative named sizes without runtime bindings", () => {
    const coffee = overviewWidgetRegistry.find((entry) => entry.widgetType === "home.coffee-machine")!;
    const climate = overviewWidgetRegistry.find((entry) => entry.widgetType === "home.climate")!;
    expect(coffee.sizes).toEqual({
      compact: { w: 4, h: 3 },
      standard: { w: 7, h: 4 },
      large: { w: 8, h: 5 }
    });
    expect(Object.values(overviewWidgetRegistry).every((entry) =>
      entry.minW >= 3 && entry.minH >= 1 && entry.maxW <= 12 && entry.maxH <= 8
    )).toBe(true);
    expect(overviewWidgetRegistry.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "renderer"))).toBe(true);
    expect(resolveOverviewWidgetSize(coffee, "unknown")).toBeNull();
    expect(climate).toMatchObject({
      singleton: true,
      minW: 4,
      minH: 4,
      maxW: 8,
      maxH: 5,
      defaultSizeVariant: "standard",
      sizes: {
        compact: { w: 4, h: 5 },
        standard: { w: 7, h: 4 },
        large: { w: 8, h: 5 }
      }
    });
  });
});
