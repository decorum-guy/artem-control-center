import { describe, expect, it } from "vitest";
import { getOverviewWidgetDefinition, overviewWidgetRegistry, resolveOverviewWidgetSize } from "./overviewRegistry";

describe("Overview V2 fixed registry", () => {
  it("contains only the bounded PR3 widget vocabulary", () => {
    expect(overviewWidgetRegistry.map((entry) => entry.widgetType)).toEqual([
      "home.coffee-machine",
      "home.kettle",
      "home.climate",
      "home.station-mini-2",
      "system.rog-g703-operational",
      "planning.summary",
      "system.health-summary",
      "weather.alert",
      "planning.calendar-agenda",
      "planning.task-list"
    ]);
  });

  it("declares the normative named sizes without runtime bindings", () => {
    const coffee = overviewWidgetRegistry.find((entry) => entry.widgetType === "home.coffee-machine")!;
    const climate = overviewWidgetRegistry.find((entry) => entry.widgetType === "home.climate")!;
    const kettle = overviewWidgetRegistry.find((entry) => entry.widgetType === "home.kettle")!;
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
      minH: 3,
      maxW: 8,
      maxH: 5,
      defaultSizeVariant: "standard",
      sizes: {
        compact: { w: 4, h: 5 },
        standard: { w: 7, h: 3 },
        large: { w: 8, h: 5 }
      }
    });
    expect(kettle).toMatchObject({
      title: "Чайник", category: "Дом", singleton: true,
      minW: 4,
      minH: 3,
      maxW: 7,
      maxH: 5,
      defaultSizeVariant: "standard",
      sizes: {
        compact: { w: 4, h: 4 },
        standard: { w: 5, h: 4 },
        large: { w: 7, h: 5 },
        detail: { w: 7, h: 3 }
      }
    });
    expect(Object.keys(kettle.sizes)).toEqual(["compact", "standard", "large", "detail"]);
    expect(resolveOverviewWidgetSize(kettle, "detail")).toEqual({ w: 7, h: 3 });
    expect(getOverviewWidgetDefinition("home.quick-actions")).toBeNull();
  });
});
