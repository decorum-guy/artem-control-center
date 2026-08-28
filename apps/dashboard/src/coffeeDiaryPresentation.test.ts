import { describe, expect, it } from "vitest";
import type { CoffeeDiaryBean, CoffeeDiaryCollection, CoffeeDiaryExtraction } from "@artem/contracts";
import { activeCoffeeDiaryBeans, bestCoffeeDiaryExtraction, coffeeDiaryShotSummary, formatCoffeeDiaryGrams, preferredDrinkLabel } from "./coffeeDiaryPresentation";

const extraction: CoffeeDiaryExtraction = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  beanId: "22222222-2222-4222-8222-222222222222",
  brewedAt: "2026-08-28T10:00:00Z",
  doseGrams: 17.5,
  extractionSeconds: 27,
  yieldGrams: 36,
  notes: "Баланс",
  rating: null,
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:00:00Z",
  deletedAt: null
};

const bean: CoffeeDiaryBean = {
  id: extraction.beanId,
  version: 2,
  name: "Эфиопия",
  grindDescription: "Чуть мельче среднего",
  preferredDrink: "espresso",
  roaster: null,
  roastDate: null,
  roastLevel: null,
  roastNotes: null,
  origin: null,
  processing: null,
  notes: "Шоколад и ягоды",
  favoriteExtractionId: extraction.id,
  photoIds: [],
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:00:00Z",
  deletedAt: null
};

const collection: CoffeeDiaryCollection = {
  schemaVersion: "coffee.diary.v1",
  revision: 3,
  updatedAt: "2026-08-28T10:00:00Z",
  beans: [bean, { ...bean, id: "33333333-3333-4333-8333-333333333333", name: "Удалённое зерно", deletedAt: "2026-08-28T11:00:00Z" }],
  recentExtractions: [extraction],
  photos: [],
  beanCount: 1,
  extractionCount: 1
};

describe("coffee diary presentation", () => {
  it("renders explicit drink labels and deterministic one-decimal shot values", () => {
    expect(preferredDrinkLabel("espresso")).toBe("Эспрессо");
    expect(preferredDrinkLabel("milk")).toBe("Молочный напиток");
    expect(preferredDrinkLabel("universal")).toBe("Универсально");
    expect(preferredDrinkLabel(null)).toBe("Не указано");
    expect(formatCoffeeDiaryGrams(36)).toBe("36.0");
    expect(coffeeDiaryShotSummary(extraction)).toBe("17.5 г · 27 с · 36.0 г");
  });

  it("shows only a selected active favourite and filters tombstoned beans", () => {
    expect(bestCoffeeDiaryExtraction(bean, [extraction])).toBe(extraction);
    expect(bestCoffeeDiaryExtraction({ ...bean, favoriteExtractionId: null }, [extraction])).toBeNull();
    expect(bestCoffeeDiaryExtraction(bean, [{ ...extraction, deletedAt: "2026-08-28T11:00:00Z" }])).toBeNull();
    expect(activeCoffeeDiaryBeans(collection).map((item) => item.name)).toEqual(["Эфиопия"]);
  });
});
