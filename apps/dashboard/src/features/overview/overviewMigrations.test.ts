import { describe, expect, it } from "vitest";
import { migrateV1ToV2, parseRawLayout } from "./overviewMigrations";

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
});
