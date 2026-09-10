import type { ProjectRegistrySettings } from "@artem/contracts";

function projectWord(count: number): string {
  if (count === 1) return "проект";
  if (count >= 2 && count <= 4) return "проекта";
  return "проектов";
}

export function projectRegistrySummary(
  loading: boolean,
  registry: ProjectRegistrySettings | null,
  hasError = false
): string {
  if (loading && !registry) return "Загружаем список проектов…";
  if (hasError) return registry ? "Список проектов требует проверки" : "Не удалось подтвердить состояние проектов";
  if (!registry || !registry.available) return "Настройки проектов временно недоступны";
  if (registry.projects.length === 0) return "Нет добавленных проектов";
  if (registry.projects.length === 1) return "1 проект";
  const enabled = registry.projects.filter((project) => project.enabled).length;
  return `${registry.projects.length} ${projectWord(registry.projects.length)} · ${enabled} ${enabled === 1 ? "включён" : "включены"}`;
}

export function projectRegistryStateLabel(
  loading: boolean,
  registry: ProjectRegistrySettings | null,
  hasError = false
): string {
  if (loading && !registry) return "Загрузка";
  if (hasError || !registry || !registry.available) return "Недоступно";
  return registry.writesEnabled ? "Доступно" : "Только чтение";
}
