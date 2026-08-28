import { CoffeeDiaryApiError } from "./coffeeDiaryApi";

export function coffeeDiaryApiMessage(reason: unknown): string {
  const code = reason instanceof CoffeeDiaryApiError ? reason.code : "";
  if (code === "revision_conflict") return "Данные изменились. Показана актуальная версия.";
  if (code === "network") return "Ответ сервера не получен. Можно повторить сохранение — дубликат создан не будет.";
  if (code === "coffee_diary_grams_precision_invalid") return "Укажите вес с точностью до 0,1 г.";
  if (code === "coffee_diary_grams_invalid") return "Укажите положительный вес до 1000 г.";
  if (code === "coffee_diary_preferred_drink_invalid") return "Выберите допустимый вариант напитка.";
  if (code === "coffee_diary_extraction_belongs_to_another_bean") return "Рецепт принадлежит другому кофе.";
  if (code === "coffee_diary_extraction_not_found") return "Приготовление не найдено.";
  if (code === "coffee_diary_write_disabled") return "Изменения недоступны в режиме только чтения.";
  if (code === "coffee_diary_store_unavailable" || code.startsWith("coffee_diary_store_")) return "Дневник временно недоступен: сохранённые данные не изменены.";
  if (code === "coffee_diary_idempotency_key_reused") return "Повторная команда с другим содержимым отклонена.";
  if (code === "coffee_diary_bean_not_found") return "Зерно не найдено в активном дневнике.";
  return "Не удалось сохранить дневник. Проверьте поля и повторите попытку.";
}
