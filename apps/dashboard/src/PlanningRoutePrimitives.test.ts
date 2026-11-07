import { describe, expect, it } from "vitest";
import { syncTimeLabel } from "./PlanningRoutePrimitives";
import { calendarSourceRefreshPresentation } from "./calendarRefreshPresentation";

const refreshResult = {
  schemaVersion: "planning.calendar-sources.refresh.v1",
  kind: "calendar_sources_refresh",
  result: "success",
  status: "current",
  observedAt: "2026-11-07T12:00:00Z",
  lastSuccessfulSyncAt: "2026-11-06T10:57:57Z",
  calendarsSeen: 2,
  eventsSeen: 12,
  errorCode: null,
  correlation_id: "00000000-0000-4000-8000-000000000097"
} as const;

function source(status: "current" | "stale" | "error" | "disabled" | "not_configured", label: string, lastSyncedAt: string | null = "2026-11-06T10:57:57Z", kind: "native" | "external" = "external") {
  return {
    id: label,
    kind,
    provider: kind === "external" ? "icloud" as const : "local" as const,
    label,
    status,
    configured: status !== "not_configured",
    lastSyncedAt,
    observedAt: "2026-11-07T12:00:00Z",
    calendars: []
  };
}

describe("Planning route freshness presentation", () => {
  it("formats freshness in the canonical Moscow display timezone", () => {
    expect(syncTimeLabel("2026-08-12T09:00:00Z")).toBe("12:00");
  });

  it("confirms freshness only when the refresh result and every configured source are current", () => {
    expect(calendarSourceRefreshPresentation(refreshResult, [source("current", "iCloud")])).toMatchObject({
      severity: "success",
      title: "Актуальные данные календаря подтверждены",
      detail: expect.stringContaining("Последнее подтверждённое обновление: 6 нояб., 13:57")
    });
  });

  it("reports cached data and the last confirmed time when a configured source remains stale", () => {
    const result = { ...refreshResult, status: "stale" as const };
    expect(calendarSourceRefreshPresentation(result, [source("stale", "iCloud")])).toMatchObject({
      severity: "warning",
      title: "Данные получены из сохранённой копии; источник остался устаревшим",
      detail: expect.stringContaining("Последнее подтверждённое обновление: 6 нояб., 13:57")
    });
  });

  it("does not treat current native Planning as a successful refresh of stale external providers", () => {
    const result = { ...refreshResult, status: "stale" as const };
    expect(calendarSourceRefreshPresentation(result, [
      source("current", "Local Planning", "2026-11-07T12:00:00Z", "native"),
      source("stale", "iCloud")
    ])).toMatchObject({ severity: "warning", title: "Данные получены из сохранённой копии; источник остался устаревшим" });
    expect(calendarSourceRefreshPresentation(result, [
      source("current", "iCloud"),
      source("error", "Avalar")
    ])).toMatchObject({ severity: "warning", title: "Частичное обновление календаря" });
  });

  it("reports a genuine partial external-provider refresh by calendar label", () => {
    const result = { ...refreshResult, status: "stale" as const };
    const sourceWithCalendars = {
      ...source("current", "iCloud"),
      calendars: [
        { id: "calendar-a", label: "AVALAR", color: null, enabled: true, status: "current" as const, lastSyncedAt: "2026-11-07T12:00:00Z", observedAt: "2026-11-07T12:00:00Z" },
        { id: "calendar-b", label: "Plans", color: null, enabled: true, status: "stale" as const, lastSyncedAt: "2026-11-06T10:57:57Z", observedAt: "2026-11-07T12:00:00Z" }
      ]
    };
    expect(calendarSourceRefreshPresentation(result, [sourceWithCalendars])).toMatchObject({
      severity: "warning",
      title: "Частичное обновление календаря",
      detail: expect.stringContaining("iCloud · AVALAR. iCloud · Plans")
    });
  });

  it("does not claim success from the refresh result without verified provider source statuses", () => {
    expect(calendarSourceRefreshPresentation(refreshResult, null, [source("stale", "iCloud")])).toMatchObject({
      severity: "error",
      title: "Синхронизация выполнена, но статус источника не удалось проверить",
      detail: expect.stringContaining("Последнее подтверждённое обновление: 6 нояб., 13:57")
    });
  });

  it("does not invent a last-confirmed time when source metadata is unavailable", () => {
    const presentation = calendarSourceRefreshPresentation(refreshResult, null);
    expect(presentation).toMatchObject({
      severity: "error",
      title: "Синхронизация выполнена, но статус источника не удалось проверить",
      detail: "Синхронизация не подтверждена; время последнего обновления неизвестно."
    });
    expect(presentation.detail).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });

  it("does not claim freshness when status observation predates the refresh response", () => {
    const result = { ...refreshResult, observedAt: "2026-11-07T12:01:00Z" };
    expect(calendarSourceRefreshPresentation(result, [source("current", "iCloud")])).toMatchObject({
      severity: "warning",
      title: "Синхронизация запрошена, но новый статус источника не подтверждён"
    });
  });

  it("keeps last-known provider freshness visible after a failed follow-up read", () => {
    expect(calendarSourceRefreshPresentation(null, null, [source("stale", "iCloud")])).toMatchObject({
      severity: "error",
      title: "Ошибка синхронизации календаря",
      detail: expect.stringContaining("Последнее подтверждённое обновление: 6 нояб., 13:57")
    });
  });

  it("does not treat disabled or unconfigured calendars as a refresh failure", () => {
    expect(calendarSourceRefreshPresentation(refreshResult, [
      source("current", "iCloud"),
      source("disabled", "Disabled calendar"),
      source("not_configured", "Optional source", null)
    ])).toMatchObject({ severity: "success" });
  });

  it("keeps provider synchronization errors explicit", () => {
    const result = { ...refreshResult, result: "failure" as const, status: "error" as const, errorCode: "provider_timeout" };
    expect(calendarSourceRefreshPresentation(result, [source("error", "iCloud")])).toMatchObject({
      severity: "error",
      title: "Ошибка синхронизации календаря"
    });
  });
});
