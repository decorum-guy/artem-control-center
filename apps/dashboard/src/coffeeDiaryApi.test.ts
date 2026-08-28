import { describe, expect, it } from "vitest";
import { parseCoffeeDiaryExport, parseCoffeeDiaryRecipe } from "./coffeeDiaryApi";

const bean = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  name: "Эфиопия",
  roaster: null,
  roastDate: null,
  roastLevel: null,
  roastNotes: null,
  origin: null,
  processing: null,
  notes: null,
  defaultRecipe: { method: "Эспрессо", fields: [{ key: "dose", label: "Кофе", kind: "number", value: 18, unit: "г" }] },
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:00:00Z",
  deletedAt: null
};

describe("coffee diary API contracts", () => {
  it("accepts the export schema and preserves recipe snapshots", () => {
    const parsed = parseCoffeeDiaryExport({
      schemaVersion: "coffee.diary.export.v1",
      sourceSchemaVersion: "coffee.diary.v1",
      revision: 2,
      updatedAt: "2026-08-28T10:00:00Z",
      beans: [bean],
      extractions: []
    });
    expect(parsed.beans[0]?.defaultRecipe?.fields[0]?.value).toBe(18);
  });

  it("rejects unknown persisted fields", () => {
    expect(() => parseCoffeeDiaryRecipe({ method: "V60", fields: [], extra: true })).toThrow("invalid_recipe");
  });

  it("rejects export payloads above the bounded collection size", () => {
    expect(() => parseCoffeeDiaryExport({
      schemaVersion: "coffee.diary.export.v1",
      sourceSchemaVersion: "coffee.diary.v1",
      revision: 1,
      updatedAt: "2026-08-28T10:00:00Z",
      beans: Array.from({ length: 501 }, () => bean),
      extractions: []
    })).toThrow("invalid_coffee_diary_export");
  });
});
