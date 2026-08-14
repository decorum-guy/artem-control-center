import { describe, expect, it } from "vitest";
import type { OverviewLayoutItem } from "@artem/contracts";
import {
  appearanceControlsFor,
  coffeeAppearanceConfig,
  defaultAppearanceConfig,
  normalizeLayoutItem,
  sourceOwnedCoffeeScale,
  validateAppearanceConfig,
  appearanceSchemaParityKeys,
  overviewAppearanceSchemas
} from "./appearanceConfig";
import { overviewWidgetRegistry } from "./overviewRegistry";

function coffee(): OverviewLayoutItem {
  return normalizeLayoutItem({
    instanceId: "coffee",
    widgetType: "home.coffee-machine",
    visibility: "visible",
    placement: { x: 0, y: 1, w: 7, h: 4 },
    sizeVariant: "standard",
    config: {}
  });
}

describe("bounded Overview appearance schema", () => {
  it("materializes the merged PR4 Coffee appearance as the default", () => {
    expect(defaultAppearanceConfig("home.coffee-machine")).toEqual({
      imageScalePct: 100,
      imageXStep: 0,
      imageYStep: 0,
      composition: "auto",
      showStateMarker: true,
      showAuthority: true,
      showImage: true
    });
    expect(coffeeAppearanceConfig(coffee()).imageScalePct).toBe(100);
  });

  it("rejects arbitrary config and enforces every numeric bound", () => {
    expect(validateAppearanceConfig("home.coffee-machine", { style: "x" }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageScalePct: 70 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageScalePct: 120 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageScalePct: 65 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageScalePct: 125 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageXStep: -3 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageXStep: 3 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageXStep: -4 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageXStep: 4 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageYStep: -2 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageYStep: 2 }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { imageYStep: -3 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { imageYStep: 3 }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { composition: "compact" }, true).valid).toBe(true);
    expect(validateAppearanceConfig("home.coffee-machine", { composition: "spacious" }, true).valid).toBe(true);
  });

  it("keeps schemas source-owned and conservative for unsupported widgets", () => {
    expect(appearanceControlsFor("system.rog-g703-operational")).toEqual([]);
    expect(appearanceControlsFor("system.health-summary")).toEqual([]);
    expect(appearanceControlsFor("home.quick-actions")).toEqual([]);
    expect(appearanceControlsFor("planning.summary").map((control) => control.key)).toEqual(["density"]);
  });

  it("keeps every registered widget represented in the trusted schema", () => {
    expect(Object.keys(overviewAppearanceSchemas).sort()).toEqual(
      overviewWidgetRegistry.map((definition) => definition.widgetType).sort()
    );
    expect(appearanceSchemaParityKeys()["home.coffee-machine"]).toEqual([
      "imageScalePct",
      "imageXStep",
      "imageYStep",
      "composition",
      "showStateMarker",
      "showAuthority",
      "showImage"
    ]);
  });

  it("clamps only in the source-owned runtime resolver", () => {
    expect(sourceOwnedCoffeeScale(70)).toBe(70);
    expect(sourceOwnedCoffeeScale(120)).toBe(120);
    expect(sourceOwnedCoffeeScale(120, 100)).toBe(100);
  });
});
