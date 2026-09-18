import { describe, test, expect } from "vitest";
import { coffeeDiaryApiMessage } from "./coffeeDiaryMessages";
import { CoffeeDiaryApiError } from "./coffeeDiaryApi";

describe("coffeeDiaryApiMessage", () => {
  const cases: Array<[string, string, string]> = [
    ["revision_conflict", "revision_conflict", "Данные изменились. Показана актуальная версия."],
    ["network", "network", "Ответ сервера не получен. Можно повторить сохранение — дубликат создан не будет."],
    ["coffee_diary_grams_precision_invalid", "coffee_diary_grams_precision_invalid", "Укажите вес с точностью до 0,1 г."],
    ["coffee_diary_grams_invalid", "coffee_diary_grams_invalid", "Укажите положительный вес до 1000 г."],
    ["coffee_diary_preferred_drink_invalid", "coffee_diary_preferred_drink_invalid", "Выберите допустимый вариант напитка."],
    ["coffee_diary_extraction_belongs_to_another_bean", "coffee_diary_extraction_belongs_to_another_bean", "Рецепт принадлежит другому кофе."],
    ["coffee_diary_extraction_not_found", "coffee_diary_extraction_not_found", "Приготовление не найдено."],
    ["coffee_diary_write_disabled", "coffee_diary_write_disabled", "Изменения недоступны в режиме только чтения."],
    ["coffee_diary_store_unavailable", "coffee_diary_store_unavailable", "Дневник временно недоступен: сохранённые данные не изменены."],
    ["coffee_diary_idempotency_key_reused", "coffee_diary_idempotency_key_reused", "Повторная команда с другим содержимым отклонена."],
    ["coffee_diary_bean_not_found", "coffee_diary_bean_not_found", "Зерно не найдено в активном дневнике."],
    ["another coffee_diary_store_* code", "coffee_diary_store_timeout", "Дневник временно недоступен: сохранённые данные не изменены."],
    ["unknown CoffeeDiaryApiError code", "unknown_error_code", "Не удалось сохранить дневник. Проверьте поля и повторите попытку."]
  ];

  test.each(cases)("maps %s to expected message", (_, code, expectedMessage) => {
    const error = new CoffeeDiaryApiError(400, code);
    expect(coffeeDiaryApiMessage(error)).toBe(expectedMessage);
  });

  test("maps arbitrary non-CoffeeDiaryApiError input to default message", () => {
    expect(coffeeDiaryApiMessage(new Error("Standard error"))).toBe("Не удалось сохранить дневник. Проверьте поля и повторите попытку.");
    expect(coffeeDiaryApiMessage("Just a string")).toBe("Не удалось сохранить дневник. Проверьте поля и повторите попытку.");
    expect(coffeeDiaryApiMessage(null)).toBe("Не удалось сохранить дневник. Проверьте поля и повторите попытку.");
  });
});
