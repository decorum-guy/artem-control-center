import type { CoffeeDiaryBean, CoffeeDiaryCollection, CoffeeDiaryRecipe } from "@artem/contracts";

export function coffeeDiaryRecipeLines(recipe: CoffeeDiaryRecipe | null): string[] {
  if (!recipe) return [];
  return [
    recipe.method,
    ...recipe.fields.map((field) => `${field.label}: ${field.value}${field.unit ? ` ${field.unit}` : ""}`)
  ];
}

export function activeCoffeeDiaryBeans(collection: CoffeeDiaryCollection): CoffeeDiaryBean[] {
  return collection.beans.filter((bean) => bean.deletedAt === null);
}
