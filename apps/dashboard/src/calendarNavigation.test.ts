import { describe, expect, it } from "vitest";
import type { PlanningCalendarEvent } from "@artem/contracts";
import {
  calendarDateFromSearch,
  calendarLocalDateForEvent,
  calendarNavigationForDate
} from "./calendarNavigation";

function event(overrides: Partial<PlanningCalendarEvent>): PlanningCalendarEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    source: "calendar-provider",
    sourceLabel: "iCloud",
    calendarIdentity: { providerId: "icloud", providerLabel: "iCloud", calendarId: "primary", calendarLabel: "Основной" },
    title: "Событие",
    notes: null,
    location: null,
    allDay: false,
    timezone: "Europe/Moscow",
    syncState: "synced",
    localOnlyMutable: false,
    startAtUtc: "2026-08-31T21:30:00Z",
    endAtUtc: "2026-08-31T22:30:00Z",
    startDate: null,
    endDateExclusive: null,
    deletedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

describe("Calendar date navigation", () => {
  it("selects the event's own local date for a timed event crossing UTC midnight", () => {
    expect(calendarLocalDateForEvent(event({}))).toBe("2026-09-01");
  });

  it("keeps all-day values date-only without timezone shifting", () => {
    expect(calendarLocalDateForEvent(event({
      allDay: true,
      startAtUtc: null,
      endAtUtc: null,
      startDate: "2026-10-05",
      endDateExclusive: "2026-10-06"
    }))).toBe("2026-10-05");
  });

  it("accepts only canonical date query state", () => {
    expect(calendarDateFromSearch("?date=2026-02-28")).toBe("2026-02-28");
    expect(calendarDateFromSearch("?date=2026-02-30")).toBeNull();
    expect(calendarDateFromSearch("?date=tomorrow")).toBeNull();
    expect(calendarNavigationForDate("2026-09-01")).toEqual({ path: "/calendar", search: "?date=2026-09-01" });
    expect(calendarNavigationForDate("2026-02-30")).toBeNull();
  });
});
