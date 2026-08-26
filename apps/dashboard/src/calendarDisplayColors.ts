import type { CalendarDisplayColorOverride, PlanningCalendarEvent, PlanningCalendarSource } from "@artem/contracts";
import { calendarIdentityForEvent } from "./planningIdentity";

export const calendarDisplayPalette = [
  "#D65A4A", "#D6952E", "#2F9A7D", "#3E8FC4", "#5B6EE1",
  "#8B5FBF", "#B14C62", "#7B8B3A", "#4A8A90", "#B56B38"
] as const;

const localCalendarColor = "#5B6EE1";
const fallbackCalendarColors = ["#2F8F83", "#B47718", "#8B5FBF", "#B14C62"];
const colorPattern = /^#[0-9A-Fa-f]{6}$/;

export function normalizedCalendarColor(value: string | null | undefined): string | null {
  return typeof value === "string" && colorPattern.test(value) ? value.toUpperCase() : null;
}

export function calendarDisplayIdentityKey(providerId: string, calendarId: string): string {
  return `${providerId}:${calendarId}`;
}

function stableColorIndex(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % fallbackCalendarColors.length;
}

export function calendarDisplayOverrideColor(providerId: string, calendarId: string, overrides: readonly CalendarDisplayColorOverride[]): string | null {
  return normalizedCalendarColor(overrides.find((entry) => entry.providerId === providerId && entry.calendarId === calendarId)?.color);
}

/** The single display-colour resolution path for Settings and Calendar. */
export function resolveCalendarDisplayColor({ providerId, calendarId, providerColor, overrides, local = false }: {
  providerId: string;
  calendarId: string;
  providerColor?: string | null;
  overrides: readonly CalendarDisplayColorOverride[];
  local?: boolean;
}): string {
  return calendarDisplayOverrideColor(providerId, calendarId, overrides)
    ?? normalizedCalendarColor(providerColor)
    ?? (local ? localCalendarColor : fallbackCalendarColors[stableColorIndex(calendarDisplayIdentityKey(providerId, calendarId))]);
}

export function calendarSourceDisplayColor(source: PlanningCalendarSource, calendar: PlanningCalendarSource["calendars"][number], overrides: readonly CalendarDisplayColorOverride[]): string {
  return resolveCalendarDisplayColor({ providerId: source.id, calendarId: calendar.id, providerColor: calendar.color, overrides, local: source.kind === "native" });
}

export function calendarEventDisplayColor(event: PlanningCalendarEvent, sources: readonly PlanningCalendarSource[], overrides: readonly CalendarDisplayColorOverride[] = []): string {
  const identity = calendarIdentityForEvent(event);
  const source = sources.find((candidate) => candidate.id === identity.providerId);
  const calendar = source?.calendars.find((candidate) => candidate.id === identity.calendarId);
  return resolveCalendarDisplayColor({
    providerId: identity.providerId,
    calendarId: identity.calendarId,
    providerColor: calendar?.color,
    overrides,
    local: event.localOnlyMutable || identity.providerId === "local-planning" || identity.providerId === "native-planning"
  });
}
