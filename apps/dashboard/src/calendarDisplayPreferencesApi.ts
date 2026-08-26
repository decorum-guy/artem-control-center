import type { CalendarDisplayPreferences } from "@artem/contracts";

export class CalendarDisplayPreferencesApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

function isColor(value: unknown): value is string { return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value); }

function parsePreferences(value: unknown): CalendarDisplayPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid preferences");
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== "calendar.display-preferences.v1" || !Number.isInteger(payload.revision) || typeof payload.updatedAt !== "string" || typeof payload.available !== "boolean" || typeof payload.writesEnabled !== "boolean" || !Array.isArray(payload.overrides) || !Array.isArray(payload.warnings)) throw new Error("invalid preferences");
  const overrides = payload.overrides.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid preference override");
    const item = entry as Record<string, unknown>;
    if (typeof item.providerId !== "string" || typeof item.calendarId !== "string" || !isColor(item.color)) throw new Error("invalid preference override");
    return { providerId: item.providerId, calendarId: item.calendarId, color: item.color.toUpperCase() };
  });
  if (!payload.warnings.every((warning) => warning === "stored_preferences_unavailable")) throw new Error("invalid preference warnings");
  return { schemaVersion: "calendar.display-preferences.v1", revision: payload.revision as number, updatedAt: payload.updatedAt as string, overrides, available: payload.available as boolean, warnings: payload.warnings as "stored_preferences_unavailable"[], writesEnabled: payload.writesEnabled as boolean };
}

async function request(path: string, init?: RequestInit): Promise<CalendarDisplayPreferences> {
  let response: Response;
  try { response = await fetch(path, { ...init, cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...init?.headers } }); }
  catch { throw new CalendarDisplayPreferencesApiError(0, "network"); }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* sanitized error below */ }
  if (!response.ok) {
    const code = payload && typeof payload === "object" && typeof (payload as { detail?: unknown }).detail === "string" ? (payload as { detail: string }).detail : `http_${response.status}`;
    throw new CalendarDisplayPreferencesApiError(response.status, code);
  }
  try { return parsePreferences(payload); } catch { throw new CalendarDisplayPreferencesApiError(response.status, "contract"); }
}

export function getCalendarDisplayPreferences(): Promise<CalendarDisplayPreferences> { return request("/api/v1/settings/calendar/display-colors"); }

export function patchCalendarDisplayPreference(payload: { expectedRevision: number; providerId: string; calendarId: string; color: string | null }): Promise<CalendarDisplayPreferences> {
  return request("/api/v1/settings/calendar/display-colors", { method: "PATCH", body: JSON.stringify(payload) });
}
