import { describe, expect, it } from "vitest";
import type { OverviewLayoutItem } from "@artem/contracts";
import {
  appearanceControlsFor,
  appearanceControlsForPresentation,
  appearanceControlValueLabel,
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
      stateOffXOffsetPx: -18,
      stateWarmingXOffsetPx: 10,
      stateReadyXOffsetPx: -8,
      composition: "auto",
      buttonLayout: "balanced",
      showStateMarker: true,
      showAuthority: true,
      showImage: true
    });
    expect(coffeeAppearanceConfig(coffee()).imageScalePct).toBe(100);
  });

  it("normalizes older Coffee configs to the exact existing motion targets", () => {
    const old = { ...coffee(), config: { imageScalePct: 110, imageXStep: 2, imageYStep: -1 } };
    const normalized = normalizeLayoutItem(old);
    expect(coffeeAppearanceConfig(normalized)).toMatchObject({
      imageScalePct: 110,
      imageXStep: 2,
      imageYStep: -1,
      stateOffXOffsetPx: -18,
      stateWarmingXOffsetPx: 10,
      stateReadyXOffsetPx: -8
    });
    expect(normalized.placement).toEqual(old.placement);
  });

  it("exposes three stepped position controls with signed pixel labels", () => {
    const controls = appearanceControlsForPresentation("home.coffee-machine");
    expect(controls.map((control) => control.key).slice(0, 7)).toEqual([
      "showImage", "imageScalePct", "imageXStep", "imageYStep",
      "stateOffXOffsetPx", "stateWarmingXOffsetPx", "stateReadyXOffsetPx"
    ]);
    for (const key of ["stateOffXOffsetPx", "stateWarmingXOffsetPx", "stateReadyXOffsetPx"]) {
      const control = controls.find((entry) => entry.key === key)!;
      expect(control).toMatchObject({ control: "integer_range", min: -40, max: 40, step: 2 });
      for (const value of [-40, -18, -8, 0, 10, 40]) {
        expect(validateAppearanceConfig("home.coffee-machine", { [key]: value }, true).valid).toBe(true);
      }
      for (const value of [-42, 42, -39, 1, 2.5, "10px", null]) {
        expect(validateAppearanceConfig("home.coffee-machine", { [key]: value }, true).valid).toBe(false);
      }
    }
    const off = controls.find((entry) => entry.key === "stateOffXOffsetPx")!;
    const warming = controls.find((entry) => entry.key === "stateWarmingXOffsetPx")!;
    expect(appearanceControlValueLabel(off, -18)).toBe("-18 px");
    expect(appearanceControlValueLabel(warming, 10)).toBe("+10 px");
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

  it("accepts only the bounded Coffee action-row layout enum", () => {
    for (const buttonLayout of ["compact", "balanced", "wide"]) {
      expect(validateAppearanceConfig("home.coffee-machine", { buttonLayout }, true).valid).toBe(true);
    }
    expect(validateAppearanceConfig("home.coffee-machine", { buttonLayout: "1fr 2fr" }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", { buttonLayout: "wide-ish" }, true).valid).toBe(false);
    expect(validateAppearanceConfig("home.coffee-machine", {}).value.buttonLayout).toBe("balanced");
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
      "stateOffXOffsetPx",
      "stateWarmingXOffsetPx",
      "stateReadyXOffsetPx",
      "composition",
      "buttonLayout",
      "showStateMarker",
      "showAuthority",
      "showImage"
    ]);
  });

  it("does not expose the removed operational Coffee state marker control", () => {
    expect(appearanceControlsForPresentation("home.coffee-machine").map((control) => control.key))
      .not.toContain("showStateMarker");
  });

  it("clamps only in the source-owned runtime resolver", () => {
    expect(sourceOwnedCoffeeScale(70)).toBe(70);
    expect(sourceOwnedCoffeeScale(120)).toBe(120);
    expect(sourceOwnedCoffeeScale(120, 100)).toBe(100);
  });
});
