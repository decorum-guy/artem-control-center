import { CoffeeDiaryApiError } from "./coffeeDiaryApi";

export function coffeeDiaryApiMessage(reason: unknown): string {
  const code = reason instanceof CoffeeDiaryApiError ? reason.code : "";
  if (code === "revision_conflict") return "Данные изменились. Показана актуальная версия.";
  if (code === "coffee_diary_write_disabled") return "Изменения недоступны в режиме только чтения.";
  if (code === "coffee_diary_store_unavailable" || code.startsWith("coffee_diary_store_")) return "Дневник временно недоступен: сохранённые данные не изменены.";
  if (code === "coffee_diary_idempotency_key_reused") return "Повторная команда с другим содержимым отклонена.";
  if (code === "coffee_diary_bean_not_found") return "Зерно не найдено в активном дневнике.";
  return "Не удалось сохранить дневник. Проверьте поля и повторите попытку.";
}
