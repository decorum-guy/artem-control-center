import type { PlanningCalendarSource } from "@artem/contracts";
import type { PlanningCalendarSourcesRefresh } from "./planningReadClient";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";

export interface CalendarRefreshPresentation {
  severity: "success" | "warning" | "error";
  title: string;
  detail: string;
}

function confirmedSyncLabel(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DEFAULT_PLANNING_TIME_ZONE
  }).format(new Date(value));
}

function lastConfirmedExternalSync(sources: readonly PlanningCalendarSource[]): string | null {
  const latest = sources
    .filter((source) => source.kind === "external" && source.configured)
    .flatMap((source) => [source.lastSyncedAt, ...source.calendars.filter((calendar) => calendar.enabled).map((calendar) => calendar.lastSyncedAt)])
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  return confirmedSyncLabel(latest);
}

/**
 * A successful HTTP response is not enough to claim a fresh provider sync.
 * The refresh response must be followed by source metadata observed at or
 * after its observedAt timestamp.
 */
export function calendarSourceRefreshPresentation(
  result: PlanningCalendarSourcesRefresh | null,
  sources: PlanningCalendarSource[] | null,
  lastKnownSources: readonly PlanningCalendarSource[] = []
): CalendarRefreshPresentation {
  const evidence = sources ?? lastKnownSources;
  const lastConfirmed = lastConfirmedExternalSync(evidence);
  const timestampCopy = lastConfirmed ? ` Последнее подтверждённое обновление: ${lastConfirmed}.` : "";

  if (!result || !sources) {
    return {
      severity: "error",
      title: result ? "Синхронизация выполнена, но статус источника не удалось проверить" : "Ошибка синхронизации календаря",
      detail: lastConfirmed
        ? `Показан последний подтверждённый статус источника.${timestampCopy}`
        : "Синхронизация не подтверждена; время последнего обновления неизвестно."
    };
  }

  // This fixed action refreshes external providers. Native Planning is a
  // separate read path and cannot make provider failure look successful.
  const active = sources.filter((source) => source.kind === "external" && source.configured && source.status !== "disabled" && source.status !== "not_configured");
  const staleSources = active.filter((source) => source.status === "stale");
  const errorSources = active.filter((source) => source.status === "error");
  const currentSources = active.filter((source) => source.status === "current");
  const staleCalendars = active.flatMap((source) => source.calendars.filter((calendar) => calendar.enabled && calendar.status === "stale").map((calendar) => ({ source, calendar })));
  const errorCalendars = active.flatMap((source) => source.calendars.filter((calendar) => calendar.enabled && calendar.status === "error").map((calendar) => ({ source, calendar })));
  const currentCalendars = active.flatMap((source) => source.calendars.filter((calendar) => calendar.enabled && calendar.status === "current").map((calendar) => ({ source, calendar })));
  const staleLabels = [...new Set([...staleSources.map((source) => source.label), ...staleCalendars.map(({ source, calendar }) => `${source.label} · ${calendar.label}`)])];
  const errorLabels = [...new Set([...errorSources.map((source) => source.label), ...errorCalendars.map(({ source, calendar }) => `${source.label} · ${calendar.label}`)])];
  const currentLabels = [...new Set([...currentSources.map((source) => source.label), ...currentCalendars.map(({ source, calendar }) => `${source.label} · ${calendar.label}`)])];

  const refreshObservedAt = Date.parse(result.observedAt);
  const verifiedAfterRefresh = Number.isFinite(refreshObservedAt) && active.length > 0 && active.every((source) => {
    const observations = [source.observedAt, ...source.calendars.filter((calendar) => calendar.enabled).map((calendar) => calendar.observedAt)]
      .filter((value): value is string => Boolean(value))
      .map(Date.parse);
    return observations.length > 0 && observations.every((value) => Number.isFinite(value) && value >= refreshObservedAt);
  });

  if (result.result === "failure" || result.status === "error") {
    const knownStatuses = [...staleLabels, ...errorLabels];
    return {
      severity: "error",
      title: "Ошибка синхронизации календаря",
      detail: `${result.errorCode ? `Источник сообщил: ${result.errorCode}. ` : "Источник не подтвердил синхронизацию. "}${knownStatuses.length ? `Последний статус: ${knownStatuses.join(", ")}. ` : ""}${timestampCopy}`
    };
  }
  if (!verifiedAfterRefresh) {
    return {
      severity: "warning",
      title: "Синхронизация запрошена, но новый статус источника не подтверждён",
      detail: `Показан последний статус, подтверждённый до запроса.${timestampCopy}`
    };
  }
  if (staleLabels.length > 0) {
    const hasConfirmedCache = [...staleSources.map((source) => source.lastSyncedAt), ...staleCalendars.map(({ calendar }) => calendar.lastSyncedAt)].some(Boolean);
    return {
      severity: "warning",
      title: currentLabels.length > 0
        ? "Частичное обновление календаря"
        : hasConfirmedCache
          ? "Данные получены из сохранённой копии; источник остался устаревшим"
          : "Источник календаря остался устаревшим",
      detail: `${currentLabels.length > 0 ? `Обновлены: ${currentLabels.join(", ")}. ` : ""}${staleLabels.join(", ")}.${timestampCopy}`
    };
  }
  if (errorLabels.length > 0) {
    return currentLabels.length > 0
      ? { severity: "warning", title: "Частичное обновление календаря", detail: `Обновлены: ${currentLabels.join(", ")}. Ошибка: ${errorLabels.join(", ")}.${timestampCopy}` }
      : { severity: "error", title: "Ошибка синхронизации календаря", detail: `${errorLabels.join(", ")}.${timestampCopy}` };
  }
  const allEnabledCalendarsCurrent = active.every((source) => source.calendars.every((calendar) => !calendar.enabled || calendar.status === "current"));
  if (result.status === "current" && active.length > 0 && currentSources.length === active.length && allEnabledCalendarsCurrent) {
    return {
      severity: "success",
      title: "Актуальные данные календаря подтверждены",
      detail: `${active.map((source) => source.label).join(", ")} подтверждены как актуальные.${timestampCopy}`
    };
  }
  return active.length > 0
    ? { severity: "warning", title: "Данные получены, но актуальность источника не подтверждена", detail: `Статус источника: ${result.status}.${timestampCopy}` }
    : { severity: "warning", title: "Нет настроенных внешних источников для проверки", detail: timestampCopy || "Синхронизация внешнего календаря не подтверждена." };
}