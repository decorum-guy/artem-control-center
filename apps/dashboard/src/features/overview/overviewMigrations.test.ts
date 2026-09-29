import { describe, expect, it } from "vitest";
import { migratePresetV2ToV3, migratePresetV3ToV4, migratePresetV4ToV5, migratePresetV5ToV6, migrateV1ToV2, parseRawLayout } from "./overviewMigrations";

describe("pure Overview migrations and recovery", () => {
  it("retires only Quick Actions in v6 and leaves unrelated saved values intact", () => {
    const coffee = { instanceId: "owner.coffee", widgetType: "home.coffee-machine", visibility: "hidden",
      placement: { x: 2, y: 6, w: 7, h: 4 }, sizeVariant: "standard", config: { imageScalePct: 115, stateReadyXOffsetPx: 8 } };
    const planning = { instanceId: "owner.planning", widgetType: "planning.summary", visibility: "visible",
      placement: { x: 7, y: 1, w: 5, h: 4 }, sizeVariant: "standard", config: { density: "compact" } };
    const quick = { instanceId: "owner.quick", widgetType: "home.quick-actions", visibility: "visible",
      placement: { x: 0, y: 1, w: 4, h: 2 }, sizeVariant: "compact", config: {} };
    const input = { schemaVersion: "overview.layout.v2", presetVersion: 5, items: [coffee, quick, planning] };
    const migrated = migratePresetV5ToV6(input) as typeof input;
    expect(migrated).toEqual({ ...input, presetVersion: 6, items: [coffee, planning] });
    expect(migratePresetV5ToV6(migrated)).toEqual(migrated);
    const parsed = parseRawLayout(input);
    expect(parsed.items.map((item) => item.widgetType)).toEqual(["home.coffee-machine", "planning.summary"]);
    expect(parsed.unplaced).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items.some((item) => item.widgetType === "home.kettle")).toBe(false);
    const unchanged = migratePresetV5ToV6({ ...input, items: [coffee, planning] }) as typeof input;
    expect(unchanged.items).toEqual([coffee, planning]);
    expect(parseRawLayout({ ...input, items: [quick] })).toEqual({
      items: [], warnings: [], unplaced: [], usedFallback: false
    });
  });
  it("adds the Station without moving persisted widgets", () => {
    const existing = { instanceId: "owner.widget", widgetType: "home.coffee-machine", sizeVariant: "standard",
      visibility: "visible", placement: { x: 0, y: 0, w: 7, h: 4 }, config: {} };
    const migrated = migratePresetV4ToV5({ schemaVersion: "overview.layout.v2", presetVersion: 4,
      items: [existing] }) as { presetVersion: number; items: Array<typeof existing> };
    expect(migrated.presetVersion).toBe(5);
    expect(migrated.items[0]).toEqual(existing);
    expect(migrated.items[1].widgetType).toBe("home.station-mini-2");
    expect(migrated.items[1].placement.x).toBe(7);
    expect(migratePresetV4ToV5(migrated)).toEqual(migrated);
  });
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

  it("shrinks preset v3 Climate standard in place while preserving config, visibility, and siblings", () => {
    const raw = {
      schemaVersion: "overview.layout.v2",
      presetVersion: 3,
      items: [
        {
          instanceId: "fixture.coffee",
          widgetType: "home.coffee-machine",
          visibility: "visible",
          placement: { x: 0, y: 1, w: 7, h: 4 },
          sizeVariant: "standard",
          config: { imageScalePct: 100 }
        },
        {
          instanceId: "fixture.climate",
          widgetType: "home.climate",
          visibility: "hidden",
          placement: { x: 0, y: 5, w: 7, h: 4 },
          sizeVariant: "standard",
          config: { showAuthority: false }
        }
      ]
    };
    const migrated = migratePresetV3ToV4(raw) as { presetVersion: number; items: Array<Record<string, unknown>> };
    expect(migrated.presetVersion).toBe(4);
    expect(migrated.items[0]).toEqual(raw.items[0]);
    expect(migrated.items[1]).toEqual({
      ...raw.items[1],
      placement: { x: 0, y: 5, w: 7, h: 3 }
    });
    expect(migratePresetV3ToV4(migrated)).toEqual(migrated);

    const parsed = parseRawLayout(raw);
    expect(parsed.usedFallback).toBe(false);
    expect(parsed.items.find((item) => item.instanceId === "fixture.climate")).toMatchObject({
      visibility: "hidden",
      placement: { x: 0, y: 5, w: 7, h: 3 },
      config: {}
    });
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
