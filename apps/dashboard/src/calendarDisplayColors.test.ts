import { describe, expect, it } from "vitest";
import type { PlanningCalendarEvent, PlanningCalendarSource } from "@artem/contracts";
import { calendarEventDisplayColor, calendarSourceDisplayColor } from "./calendarDisplayColors";

const sources: PlanningCalendarSource[] = [{
  id: "icloud-safe", kind: "external", provider: "icloud", label: "iCloud", status: "current", configured: true,
  lastSyncedAt: null, observedAt: null,
  calendars: [
    { id: "work-a", label: "Рабочий", color: "#A1B2C3", enabled: true, status: "current", lastSyncedAt: null, observedAt: null },
    { id: "work-b", label: "Рабочий", color: "#D4E5F6", enabled: true, status: "current", lastSyncedAt: null, observedAt: null }
  ]
}];

function event(calendarId: string, calendarLabel = "Рабочий"): PlanningCalendarEvent {
  return {
    id: "00000000-0000-4000-8000-000000000900", version: 1, source: "calendar-provider", sourceLabel: "iCloud",
    calendarIdentity: { providerId: "icloud-safe", providerLabel: "iCloud", calendarId, calendarLabel },
    title: "Событие", notes: null, location: null, allDay: false, timezone: "Europe/Moscow", syncState: "synced", localOnlyMutable: false,
    startAtUtc: "2026-08-26T10:00:00Z", endAtUtc: "2026-08-26T11:00:00Z", startDate: null, endDateExclusive: null, deletedAt: null,
    createdAt: "2026-08-26T09:00:00Z", updatedAt: "2026-08-26T09:00:00Z"
  };
}

describe("Calendar display colour resolution", () => {
  it("uses provider colours without an override and the override wins when set", () => {
    expect(calendarEventDisplayColor(event("work-a"), sources)).toBe("#A1B2C3");
    expect(calendarEventDisplayColor(event("work-a"), sources, [{ providerId: "icloud-safe", calendarId: "work-a", color: "#d65a4a" }])).toBe("#D65A4A");
  });

  it("keeps provider changes visible when unoverridden and preserves explicit colours", () => {
    const recoloured = [{ ...sources[0], calendars: [{ ...sources[0].calendars[0], color: "#112233" }, sources[0].calendars[1]] }];
    expect(calendarEventDisplayColor(event("work-a"), recoloured)).toBe("#112233");
    expect(calendarEventDisplayColor(event("work-a"), recoloured, [{ providerId: "icloud-safe", calendarId: "work-a", color: "#D65A4A" }])).toBe("#D65A4A");
  });

  it("keys duplicate names, rename, disappearance, and return by stable identity", () => {
    const overrides = [
      { providerId: "icloud-safe", calendarId: "work-a", color: "#D65A4A" },
      { providerId: "icloud-safe", calendarId: "work-b", color: "#3E8FC4" }
    ];
    expect(calendarEventDisplayColor(event("work-a"), sources, overrides)).toBe("#D65A4A");
    expect(calendarEventDisplayColor(event("work-b"), sources, overrides)).toBe("#3E8FC4");
    expect(calendarEventDisplayColor(event("work-a", "Переименован"), sources, overrides)).toBe("#D65A4A");
    const missingA = [{ ...sources[0], calendars: [sources[0].calendars[1]] }];
    expect(calendarSourceDisplayColor(missingA[0], missingA[0].calendars[0], overrides)).toBe("#3E8FC4");
    expect(calendarEventDisplayColor(event("work-a"), sources, overrides)).toBe("#D65A4A");
  });

  it("falls back deterministically when neither source nor override has a valid colour", () => {
    const missing = event("missing");
    expect(calendarEventDisplayColor(missing, sources)).toMatch(/^#[0-9A-F]{6}$/);
    expect(calendarEventDisplayColor(missing, sources)).toBe(calendarEventDisplayColor(missing, sources));
  });
});
