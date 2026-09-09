import { describe, expect, it } from "vitest";
import { migratePresetV2ToV3, migrateV1ToV2, parseRawLayout } from "./overviewMigrations";

describe("pure Overview migrations and recovery", () => {
  it("migrates configured v1 vocabulary while preserving instance ids", () => {
    const migrated = migrateV1ToV2({
      version: 1,
      profiles: [{ id: "desk", items: [{ widget_id: "widget.coffee.primary", x: 0, y: 2, width: 7, height: 4 }] }]
    }) as { schemaVersion: string; items: Array<{ instanceId: string; widgetType: string }> };
    expect(migrated.schemaVersion).toBe("overview.layout.v2");
    expect(migrated.items[0]).toMatchObject({ instanceId: "widget.coffee.primary", widgetType: "home.coffee-machine" });
  });

  it("keeps valid widgets and exposes unknown records as inert unplaced metadata", () => {
    const parsed = parseRawLayout({
      schemaVersion: "overview.layout.v2",
      items: [
        {
          instanceId: "known",
          widgetType: "planning.summary",
          visibility: "visible",
          placement: { x: 0, y: 0, w: 5, h: 4 },
          sizeVariant: "standard",
          config: { density: "compact" }
        },
        {
          instanceId: "unknown",
          widgetType: "remote.plugin",
          visibility: "visible",
          placement: { x: 0, y: 4, w: 4, h: 3 },
          sizeVariant: "standard",
          config: { html: "<script>" }
        }
      ]
    });
    expect(parsed.usedFallback).toBe(false);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.unplaced).toEqual([{ instanceId: "unknown", widgetType: "remote.plugin", reason: expect.any(String) }]);
  });

  it("falls back safely for corrupt roots and zero valid widgets", () => {
    expect(parseRawLayout("not an object").usedFallback).toBe(true);
    expect(parseRawLayout({ schemaVersion: "overview.layout.v2", items: [{ widgetType: "remote.plugin" }] }).usedFallback).toBe(true);
  });

  it("converts the exact old quick-actions slot into the climate widget", () => {
    const migrated = migratePresetV2ToV3({
      schemaVersion: "overview.layout.v2",
      presetVersion: 2,
      items: [{
        instanceId: "fixture.quick-actions",
        widgetType: "home.quick-actions",
        visibility: "visible",
        placement: { x: 8, y: 5, w: 7, h: 2 },
        sizeVariant: "standard",
        config: {}
      }]
    }) as { presetVersion: number; items: Array<Record<string, unknown>> };
    expect(migrated.presetVersion).toBe(3);
    expect(migrated.items).toEqual([{
      instanceId: "fixture.climate",
      widgetType: "home.climate",
      visibility: "visible",
      placement: { x: 5, y: 5, w: 7, h: 4 },
      sizeVariant: "standard",
      config: {}
    }]);
  });

  it("appends climate with deterministic first-fit without resetting customized items", () => {
    const coffee = {
      instanceId: "owner.coffee",
      widgetType: "home.coffee-machine",
      visibility: "visible",
      placement: { x: 0, y: 0, w: 7, h: 4 },
      sizeVariant: "standard",
      config: {}
    };
    const migrated = migratePresetV2ToV3({
      schemaVersion: "overview.layout.v2",
      presetVersion: 2,
      items: [coffee]
    }) as { presetVersion: number; items: Array<Record<string, unknown>> };
    expect(migrated.presetVersion).toBe(3);
    expect(migrated.items[0]).toEqual(coffee);
    expect(migrated.items[1]).toMatchObject({
      instanceId: "fixture.climate",
      widgetType: "home.climate",
      placement: { x: 0, y: 4, w: 7, h: 4 }
    });
  });

  it("preserves a hidden old slot and does not duplicate an existing climate", () => {
    const hidden = migratePresetV2ToV3({
      schemaVersion: "overview.layout.v2",
      presetVersion: 2,
      items: [{
        instanceId: "fixture.quick-actions",
        widgetType: "home.quick-actions",
        visibility: "hidden",
        placement: { x: 0, y: 5, w: 7, h: 2 },
        sizeVariant: "standard",
        config: { ignored: true }
      }]
    }) as { items: Array<Record<string, unknown>> };
    expect(hidden.items[0]).toMatchObject({ instanceId: "fixture.climate", visibility: "hidden", config: {} });

    const existing = migratePresetV2ToV3({
      schemaVersion: "overview.layout.v2",
      presetVersion: 2,
      items: [{
        instanceId: "owner.climate",
        widgetType: "home.climate",
        visibility: "visible",
        placement: { x: 0, y: 0, w: 7, h: 4 },
        sizeVariant: "standard",
        config: {}
      }]
    }) as { items: Array<Record<string, unknown>> };
    expect(existing.items.filter((item) => item.widgetType === "home.climate")).toHaveLength(1);
  });

  it("reflows an exact migrated slot when its larger climate bounds collide", () => {
    const migrated = migratePresetV2ToV3({
      schemaVersion: "overview.layout.v2",
      presetVersion: 2,
      items: [
        {
          instanceId: "owner.other",
          widgetType: "home.coffee-machine",
          visibility: "visible",
          placement: { x: 0, y: 0, w: 7, h: 4 },
          sizeVariant: "standard",
          config: {}
        },
        {
          instanceId: "fixture.quick-actions",
          widgetType: "home.quick-actions",
          visibility: "visible",
          placement: { x: 0, y: 0, w: 7, h: 2 },
          sizeVariant: "standard",
          config: {}
        }
      ]
    }) as { items: Array<{ instanceId: string; placement: { x: number; y: number; w: number; h: number } }> };
    const climate = migrated.items.find((item) => item.instanceId === "fixture.climate")!;
    expect(climate.placement).toEqual({ x: 0, y: 4, w: 7, h: 4 });
  });
});
