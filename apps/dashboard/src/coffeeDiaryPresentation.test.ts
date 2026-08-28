import { describe, expect, it } from "vitest";
import type { CoffeeDiaryCollection, CoffeeDiaryRecipe } from "@artem/contracts";
import { activeCoffeeDiaryBeans, coffeeDiaryRecipeLines } from "./coffeeDiaryPresentation";

const recipe: CoffeeDiaryRecipe = {
  method: "Эспрессо",
  fields: [{ key: "dose", label: "Кофе", kind: "number", value: 18, unit: "г" }]
};

const collection: CoffeeDiaryCollection = {
  schemaVersion: "coffee.diary.v1",
  revision: 3,
  updatedAt: "2026-08-28T10:00:00Z",
  beans: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      name: "Активное зерно",
      roaster: null,
      roastDate: null,
      roastLevel: null,
      roastNotes: null,
      origin: null,
      processing: null,
      notes: null,
      defaultRecipe: recipe,
      createdAt: "2026-08-28T10:00:00Z",
      updatedAt: "2026-08-28T10:00:00Z",
      deletedAt: null
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      version: 2,
      name: "Удалённое зерно",
      roaster: null,
      roastDate: null,
      roastLevel: null,
      roastNotes: null,
      origin: null,
      processing: null,
      notes: null,
      defaultRecipe: null,
      createdAt: "2026-08-28T10:00:00Z",
      updatedAt: "2026-08-28T10:00:00Z",
      deletedAt: "2026-08-28T11:00:00Z"
    }
  ],
  recentExtractions: [],
  beanCount: 1,
  extractionCount: 0
};

describe("coffee diary presentation", () => {
  it("renders flexible recipe fields as readable lines", () => {
    expect(coffeeDiaryRecipeLines(recipe)).toEqual(["Эспрессо", "Кофе: 18 г"]);
    expect(coffeeDiaryRecipeLines(null)).toEqual([]);
  });

  it("filters tombstoned beans from collection helpers", () => {
    expect(activeCoffeeDiaryBeans(collection).map((bean) => bean.name)).toEqual(["Активное зерно"]);
  });
});
