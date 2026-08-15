import type { PlanningCalendarEvent, PlanningCalendarIdentity } from "@artem/contracts";

const fallbackCalendarIdentity = (event: PlanningCalendarEvent): PlanningCalendarIdentity => ({
  providerId: event.source,
  providerLabel: event.sourceLabel,
  calendarId: `${event.source}:default`,
  calendarLabel: "Основной календарь"
});

/**
 * Normalizes the optional identity extension without exposing provider
 * transport details. B3 events without the extension remain readable.
 */
export function calendarIdentityForEvent(event: PlanningCalendarEvent): PlanningCalendarIdentity {
  return event.calendarIdentity ?? fallbackCalendarIdentity(event);
}

export function calendarIdentityLabel(event: PlanningCalendarEvent): string {
  const identity = calendarIdentityForEvent(event);
  return `${identity.providerLabel} · ${identity.calendarLabel}`;
}
