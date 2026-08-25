import { describe, expect, it } from "vitest";
import type { PlanningCalendarEvent, PlanningProject, PlanningReminder, PlanningTask } from "@artem/contracts";
import {
  deliveryLabels,
  calendarEventColor,
  calendarEventsForLocalDay,
  calendarEventsInRange,
  eventOverlapIds,
  eventTemporalState,
  formatEventRange,
  formatTaskDueForRoute,
  groupCalendarEvents,
  planningRouteReferenceTime,
  priorityLabels,
  projectNameForTask,
  reminderMatchesView
} from "./planningRouteLogic";
import { calendarAgendaRangeUtc, calendarDayRangeUtc, currentLocalDate } from "./calendarRange";

const baseTask: PlanningTask = {
  id: "00000000-0000-4000-8000-000000000101",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Задача",
  notes: null,
  priority: "normal",
  status: "open",
  dueDate: "2026-08-12",
  dueTime: null,
  timezone: null,
  projectId: null,
  sourceRef: null,
  completedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const baseEvent = (overrides: Partial<PlanningCalendarEvent> = {}): PlanningCalendarEvent => ({
  id: "00000000-0000-4000-8000-000000000201",
  version: 1,
  source: "system",
  sourceLabel: "System",
  title: "Событие",
  notes: null,
  location: null,
  allDay: false,
  timezone: "Europe/Moscow",
  syncState: "local_only",
  localOnlyMutable: true,
  startAtUtc: "2026-08-12T10:00:00Z",
  endAtUtc: "2026-08-12T11:00:00Z",
  startDate: null,
  endDateExclusive: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z",
  ...overrides
});

const baseReminder: PlanningReminder = {
  id: "00000000-0000-4000-8000-000000000301",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Напоминание",
  dueAtUtc: "2026-08-12T10:00:00Z",
  timezone: "Europe/Moscow",
  status: "due",
  deliveryState: "delivered",
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const sourceCalendars = [
  {
    id: "icloud-source",
    kind: "external" as const,
    provider: "icloud" as const,
    label: "iCloud",
    status: "current" as const,
    configured: true,
    lastSyncedAt: "2026-08-12T09:00:00Z",
    observedAt: "2026-08-12T09:00:00Z",
    calendars: [
      { id: "work", label: "Работа", color: "#A1B2C3", enabled: true, status: "current" as const, lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" },
      { id: "home", label: "Дом", color: "#D4E5F6", enabled: true, status: "current" as const, lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" }
    ]
  },
  {
    id: "native-planning",
    kind: "native" as const,
    provider: "local" as const,
    label: "Local Planning",
    status: "current" as const,
    configured: true,
    lastSyncedAt: "2026-08-12T09:00:00Z",
    observedAt: "2026-08-12T09:00:00Z",
    calendars: []
  }
];

describe("B3 route semantics", () => {
  it("keeps date-only tasks free of midnight/timezone inventions", () => {
    const label = formatTaskDueForRoute(baseTask);
    expect(label).toContain("12 авг");
    expect(label).not.toContain("00:00");
    expect(label).not.toContain("Europe/");
  });

  it("keeps selected-day filtering date-only safe and includes cross-midnight timed overlap", () => {
    const allDay = baseEvent({
      id: "00000000-0000-4000-8000-000000000210",
      allDay: true,
      startAtUtc: null,
      endAtUtc: null,
      startDate: "2026-08-12",
      endDateExclusive: "2026-08-13"
    });
    const crossesMidnight = baseEvent({
      id: "00000000-0000-4000-8000-000000000211",
      startAtUtc: "2026-08-12T20:30:00Z",
      endAtUtc: "2026-08-13T00:30:00Z"
    });
    expect(calendarEventsForLocalDay([allDay, crossesMidnight], "2026-08-12").map((event) => event.id)).toEqual([allDay.id, crossesMidnight.id]);
    expect(calendarEventsForLocalDay([crossesMidnight], "2026-08-13").map((event) => event.id)).toEqual([crossesMidnight.id]);
  });

  it("joins accepted source calendar colors and uses stable fallbacks", () => {
    const work = baseEvent({
      calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "work", calendarLabel: "Работа" },
      localOnlyMutable: false,
      syncState: "synced"
    });
    const home = { ...work, id: "00000000-0000-4000-8000-000000000212", calendarIdentity: { ...work.calendarIdentity!, calendarId: "home", calendarLabel: "Дом" } };
    const local = baseEvent({ id: "00000000-0000-4000-8000-000000000213", calendarIdentity: { providerId: "native-planning", providerLabel: "Local Planning", calendarId: "local", calendarLabel: "Локальный" } });
    const invalid = { ...work, id: "00000000-0000-4000-8000-000000000214", calendarIdentity: { ...work.calendarIdentity!, calendarId: "missing", calendarLabel: "Нет цвета" } };
    expect(calendarEventColor(work, sourceCalendars)).toBe("#A1B2C3");
    expect(calendarEventColor(home, sourceCalendars)).toBe("#D4E5F6");
    expect(calendarEventColor(local, sourceCalendars)).toBe("#5B6EE1");
    expect(calendarEventColor(invalid, sourceCalendars)).toBe(calendarEventColor(invalid, sourceCalendars));
    expect(calendarEventColor(invalid, sourceCalendars)).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("keeps normal event cards human-readable while retaining timezone detail for the sheet", () => {
    const event = baseEvent({ startAtUtc: "2026-08-12T10:00:00Z", endAtUtc: "2026-08-12T11:00:00Z", timezone: "Europe/Moscow" });
    expect(formatEventRange(event)).toBe("12 авг., 13:00 — 14:00");
    expect(formatEventRange(event, true)).toContain("Europe/Moscow");
  });

  it("formats timed tasks with the canonical IANA timezone", () => {
    const label = formatTaskDueForRoute({ ...baseTask, dueTime: "14:30", timezone: "Europe/Berlin" });
    expect(label).toContain("14:30");
    expect(label).toContain("Europe/Berlin");
  });

  it("preserves distinct priority labels", () => {
    expect(Object.values(priorityLabels)).toEqual(["Высокий", "Обычный", "Низкий", "Без приоритета"]);
  });

  it("uses a safe project fallback when a project is not in the loaded page", () => {
    const task = { ...baseTask, projectId: "00000000-0000-4000-8000-000000000401" };
    const projects: PlanningProject[] = [];
    expect(projectNameForTask(task, projects)).toBe("Проект недоступен");
  });

  it("uses half-open overlap semantics", () => {
    const first = baseEvent();
    const boundary = baseEvent({ id: "00000000-0000-4000-8000-000000000202", startAtUtc: "2026-08-12T11:00:00Z", endAtUtc: "2026-08-12T12:00:00Z" });
    const overlap = baseEvent({ id: "00000000-0000-4000-8000-000000000203", startAtUtc: "2026-08-12T10:30:00Z", endAtUtc: "2026-08-12T11:30:00Z" });
    expect(eventOverlapIds([first, boundary])).toEqual(new Set());
    expect(eventOverlapIds([first, overlap])).toEqual(new Set([first.id, overlap.id]));
  });

  it("groups all-day before timed events and sorts timed events chronologically", () => {
    const allDay = baseEvent({
      id: "00000000-0000-4000-8000-000000000204",
      allDay: true,
      startAtUtc: null,
      endAtUtc: null,
      startDate: "2026-08-12",
      endDateExclusive: "2026-08-13"
    });
    const late = baseEvent({ id: "00000000-0000-4000-8000-000000000205", startAtUtc: "2026-08-12T12:00:00Z", endAtUtc: "2026-08-12T13:00:00Z" });
    const early = baseEvent({ id: "00000000-0000-4000-8000-000000000206", startAtUtc: "2026-08-12T08:00:00Z", endAtUtc: "2026-08-12T09:00:00Z" });
    const groups = groupCalendarEvents([late, allDay, early], "2026-08-12", "2026-08-13");
    expect(groups).toHaveLength(1);
    expect(groups[0].allDay[0].id).toBe(allDay.id);
    expect(groups[0].timed.map((event) => event.id)).toEqual([early.id, late.id]);
  });

  it("keeps delivered-open reminders active but out of delivery attention", () => {
    const now = new Date("2026-08-12T12:00:00Z");
    expect(reminderMatchesView(baseReminder, "overdue", now)).toBe(true);
    expect(reminderMatchesView(baseReminder, "delivery", now)).toBe(false);
    expect(deliveryLabels.delivered).toBe("Доставлено · ждёт завершения");
    expect(reminderMatchesView({ ...baseReminder, deliveryState: "failed" }, "delivery", now)).toBe(true);
    expect(reminderMatchesView({ ...baseReminder, status: "completed" }, "overdue", now)).toBe(false);
  });

  it("freezes stale and offline calendar temporal state at last sync while current data advances", () => {
    const meeting = baseEvent({
      startAtUtc: "2026-08-12T10:00:00Z",
      endAtUtc: "2026-08-12T11:00:00Z"
    });
    const lastSyncedAt = "2026-08-12T10:30:00Z";
    const liveLater = new Date("2026-08-12T12:00:00Z");
    for (const sourceStatus of ["stale", "offline"] as const) {
      const frozen = planningRouteReferenceTime(
        sourceStatus,
        "2026-08-12T09:00:00Z",
        lastSyncedAt,
        liveLater,
        false
      );
      const frozenLater = planningRouteReferenceTime(
        sourceStatus,
        "2026-08-12T09:00:00Z",
        lastSyncedAt,
        new Date("2026-08-12T23:00:00Z"),
        false
      );
      expect(eventTemporalState(meeting, frozen)).toBe("running");
      expect(eventTemporalState(meeting, frozenLater)).toBe("running");
    }
    expect(eventTemporalState(meeting, planningRouteReferenceTime(
      "current",
      lastSyncedAt,
      lastSyncedAt,
      liveLater,
      false
    ))).toBe("past");
  });

  it("prefers lastSyncedAt, falls back to generatedAt, and freezes preview even when its snapshot says current", () => {
    const liveLater = new Date("2026-08-13T00:05:00Z");
    expect(planningRouteReferenceTime(
      "stale",
      "2026-08-12T09:00:00Z",
      "2026-08-12T11:00:00Z",
      liveLater,
      false
    ).toISOString()).toBe("2026-08-12T11:00:00.000Z");
    expect(planningRouteReferenceTime(
      "offline",
      "2026-08-12T09:00:00Z",
      null,
      liveLater,
      false
    ).toISOString()).toBe("2026-08-12T09:00:00.000Z");
    expect(planningRouteReferenceTime(
      "current",
      "2026-08-12T09:00:00Z",
      "2026-08-12T11:00:00Z",
      liveLater,
      true
    ).toISOString()).toBe("2026-08-12T11:00:00.000Z");
  });

  it("keeps a stale or offline preview on its original local day across midnight", () => {
    const lastSyncedAt = new Date("2026-08-12T20:55:00Z");
    const later = new Date("2026-08-12T21:05:00Z");
    const reference = planningRouteReferenceTime(
      "offline",
      "2026-08-12T20:55:00Z",
      lastSyncedAt.toISOString(),
      later,
      true
    );
    expect(currentLocalDate(reference, "Europe/Moscow")).toBe("2026-08-12");
    expect(currentLocalDate(later, "Europe/Moscow")).toBe("2026-08-13");
  });

  it("filters bounded calendar previews to the selected shifted agenda range", () => {
    const range = calendarAgendaRangeUtc("2026-08-19", 7, "Europe/Moscow");
    const inside = baseEvent({
      id: "00000000-0000-4000-8000-000000000207",
      startAtUtc: "2026-08-20T10:00:00Z",
      endAtUtc: "2026-08-20T11:00:00Z"
    });
    const outside = baseEvent({
      id: "00000000-0000-4000-8000-000000000208",
      startAtUtc: "2026-08-12T10:00:00Z",
      endAtUtc: "2026-08-12T11:00:00Z"
    });
    const allDayBoundary = baseEvent({
      id: "00000000-0000-4000-8000-000000000209",
      allDay: true,
      startAtUtc: null,
      endAtUtc: null,
      startDate: "2026-08-18",
      endDateExclusive: "2026-08-20"
    });
    expect(calendarEventsInRange([outside, inside, allDayBoundary], range).map((event) => event.id)).toEqual([
      inside.id,
      allDayBoundary.id
    ]);
  });

  it("keeps the current route on the live presentation clock", () => {
    const meeting = baseEvent({
      startAtUtc: "2026-08-12T10:00:00Z",
      endAtUtc: "2026-08-12T11:00:00Z"
    });
    const currentAtStart = planningRouteReferenceTime(
      "current",
      "2026-08-12T09:00:00Z",
      "2026-08-12T09:00:00Z",
      new Date("2026-08-12T10:30:00Z"),
      false
    );
    const currentLater = planningRouteReferenceTime(
      "current",
      "2026-08-12T09:00:00Z",
      "2026-08-12T09:00:00Z",
      new Date("2026-08-12T12:00:00Z"),
      false
    );
    expect(eventTemporalState(meeting, currentAtStart)).toBe("running");
    expect(eventTemporalState(meeting, currentLater)).toBe("past");
    expect(calendarDayRangeUtc(currentLocalDate(currentLater, "Europe/Moscow"), "Europe/Moscow").fromLocalDate).toBe("2026-08-12");
  });
});
