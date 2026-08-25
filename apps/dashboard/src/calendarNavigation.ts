import type { PlanningCalendarEvent } from "@artem/contracts";
import { localDateForInstant } from "./calendarRange";

export type CalendarNavigationTarget = {
  readonly path: "/calendar";
  readonly search: `?date=${string}`;
};

function validCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Browser-safe Calendar route state: date only, never event/provider identity. */
export function calendarDateFromSearch(search: string): string | null {
  const date = new URLSearchParams(search).get("date");
  return validCalendarDate(date) ? date : null;
}

export function calendarNavigationForDate(localDate: string): CalendarNavigationTarget | null {
  return validCalendarDate(localDate)
    ? { path: "/calendar", search: `?date=${localDate}` }
    : null;
}

/** Match Calendar's rendering semantics: all-day is date-only; timed uses its event timezone. */
export function calendarLocalDateForEvent(event: PlanningCalendarEvent): string | null {
  if (event.allDay) return validCalendarDate(event.startDate) ? event.startDate : null;
  if (!event.startAtUtc) return null;
  const instant = new Date(event.startAtUtc);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    return localDateForInstant(instant, event.timezone);
  } catch {
    return null;
  }
}
