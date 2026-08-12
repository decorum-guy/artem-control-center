import { describe, expect, it } from "vitest";
import type { PlanningCalendarEvent, PlanningProject, PlanningReminder, PlanningTask } from "@artem/contracts";
import {
  deliveryLabels,
  eventOverlapIds,
  formatTaskDueForRoute,
  groupCalendarEvents,
  priorityLabels,
  projectNameForTask,
  reminderMatchesView
} from "./planningRouteLogic";

const baseTask: PlanningTask = {
  id: "00000000-0000-4000-8000-000000000101",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Задача",
  priority: "normal",
  status: "open",
  dueDate: "2026-08-12",
  dueTime: null,
  timezone: null,
  projectId: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const baseEvent = (overrides: Partial<PlanningCalendarEvent> = {}): PlanningCalendarEvent => ({
  id: "00000000-0000-4000-8000-000000000201",
  version: 1,
  source: "system",
  sourceLabel: "System",
  title: "Событие",
  allDay: false,
  timezone: "Europe/Moscow",
  syncState: "local_only",
  startAtUtc: "2026-08-12T10:00:00Z",
  endAtUtc: "2026-08-12T11:00:00Z",
  startDate: null,
  endDateExclusive: null,
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

describe("B3 route semantics", () => {
  it("keeps date-only tasks free of midnight/timezone inventions", () => {
    const label = formatTaskDueForRoute(baseTask);
    expect(label).toContain("12 авг");
    expect(label).not.toContain("00:00");
    expect(label).not.toContain("Europe/");
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
});

