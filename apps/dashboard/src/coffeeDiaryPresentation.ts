import type { CoffeeDiaryBean, CoffeeDiaryCollection, CoffeeDiaryExtraction, CoffeeDiaryPreferredDrink } from "@artem/contracts";

export function preferredDrinkLabel(value: CoffeeDiaryPreferredDrink | null): string {
  if (value === "espresso") return "Эспрессо";
  if (value === "milk") return "Молочный напиток";
  if (value === "universal") return "Универсально";
  return "Не указано";
}

export function formatCoffeeDiaryGrams(value: number): string {
  return value.toFixed(1);
}

export function coffeeDiaryShotSummary(extraction: Pick<CoffeeDiaryExtraction, "doseGrams" | "extractionSeconds" | "yieldGrams">): string {
  return `${formatCoffeeDiaryGrams(extraction.doseGrams)} г · ${extraction.extractionSeconds} с · ${formatCoffeeDiaryGrams(extraction.yieldGrams)} г`;
}

export function bestCoffeeDiaryExtraction(bean: CoffeeDiaryBean, extractions: CoffeeDiaryExtraction[]): CoffeeDiaryExtraction | null {
  if (!bean.favoriteExtractionId) return null;
  return extractions.find((extraction) => extraction.id === bean.favoriteExtractionId && extraction.deletedAt === null) ?? null;
}

export function activeCoffeeDiaryBeans(collection: CoffeeDiaryCollection): CoffeeDiaryBean[] {
  return collection.beans.filter((bean) => bean.deletedAt === null);
}
