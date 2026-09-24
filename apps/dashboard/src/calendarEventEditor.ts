import type { PlanningCalendarEvent } from "@artem/contracts";
import { addCalendarDays, DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import { localDateTimeForUtc, reminderUtcFromLocal } from "./reminderMutationBody";
import type { EventMutationBody } from "./eventMutationBody";

/** UI-only destination. #105 can supply provider-capable calendars without changing the form. */
export interface CalendarEditorDestination {
  id: string;
  label: string;
  color: string;
  writable: boolean;
  providerKind: "local" | "icloud";
}

export interface CalendarEventEditorState {
  destinationId: string;
  title: string;
  notes: string;
  location: string;
  allDay: boolean;
  timezone: string;
  startDate: string;
  endDate: string; // inclusive in the editor; the API uses an exclusive end
  startTime: string;
  endTime: string;
  durationMinutes: number | null;
}

export const calendarDurationPresets = [15, 30, 60, 120] as const;

function validDate(value: string): boolean {
  try { return addCalendarDays(value, 0) === value; } catch { return false; }
}

function endAfterDuration(state: CalendarEventEditorState, minutes: number): Pick<CalendarEventEditorState, "endDate" | "endTime"> | null {
  const start = reminderUtcFromLocal(state.startDate, state.startTime, state.timezone);
  if (!start) return null;
  const end = new Date(Date.parse(start) + minutes * 60_000);
  const local = localDateTimeForUtc(end.toISOString(), state.timezone);
  return { endDate: local.date, endTime: local.time };
}

export function initialCalendarEventEditorState(
  selectedDate: string,
  destinationId: string,
  event: PlanningCalendarEvent | null = null
): CalendarEventEditorState {
  if (!event) return {
    destinationId, title: "", notes: "", location: "", allDay: false,
    timezone: DEFAULT_PLANNING_TIME_ZONE, startDate: selectedDate, endDate: selectedDate,
    startTime: "09:00", endTime: "10:00", durationMinutes: 60
  };
  const start = event.startAtUtc ? localDateTimeForUtc(event.startAtUtc, event.timezone) : null;
  const end = event.endAtUtc ? localDateTimeForUtc(event.endAtUtc, event.timezone) : null;
  return {
    destinationId, title: event.title, notes: event.notes ?? "", location: event.location ?? "",
    allDay: event.allDay, timezone: event.timezone,
    startDate: event.allDay ? (event.startDate ?? selectedDate) : (start?.date ?? selectedDate),
    endDate: event.allDay ? addCalendarDays(event.endDateExclusive ?? addCalendarDays(selectedDate, 1), -1) : (end?.date ?? selectedDate),
    startTime: start?.time ?? "09:00", endTime: end?.time ?? "10:00", durationMinutes: null
  };
}

export function calendarEditorWithStart(
  state: CalendarEventEditorState,
  patch: Pick<CalendarEventEditorState, "startDate"> | Pick<CalendarEventEditorState, "startTime">
): CalendarEventEditorState {
  const next = { ...state, ...patch };
  if (next.allDay) return { ...next, endDate: next.endDate < next.startDate ? next.startDate : next.endDate };
  if (next.durationMinutes === null) return next;
  const end = endAfterDuration(next, next.durationMinutes);
  return end ? { ...next, ...end } : next;
}

export function calendarEditorWithDuration(state: CalendarEventEditorState, minutes: number): CalendarEventEditorState {
  const next = { ...state, durationMinutes: minutes };
  const end = endAfterDuration(next, minutes);
  return end ? { ...next, ...end } : next;
}

export function calendarEditorFromParsedBody(state: CalendarEventEditorState, body: EventMutationBody): CalendarEventEditorState {
  if (body.all_day) return {
    ...state, title: body.title ?? state.title, notes: body.notes ?? state.notes,
    location: body.location ?? state.location, allDay: true,
    timezone: body.timezone ?? state.timezone,
    startDate: body.start_date ?? state.startDate,
    endDate: body.end_date_exclusive ? addCalendarDays(body.end_date_exclusive, -1) : state.endDate,
    durationMinutes: null
  };
  const timezone = body.timezone ?? state.timezone;
  const start = body.start_at_utc ? localDateTimeForUtc(body.start_at_utc, timezone) : null;
  const end = body.end_at_utc ? localDateTimeForUtc(body.end_at_utc, timezone) : null;
  return {
    ...state, title: body.title ?? state.title, notes: body.notes ?? state.notes,
    location: body.location ?? state.location, allDay: false, timezone,
    startDate: start?.date ?? state.startDate, startTime: start?.time ?? state.startTime,
    endDate: end?.date ?? state.endDate, endTime: end?.time ?? state.endTime,
    durationMinutes: null
  };
}

export function calendarEventBodyFromEditor(state: CalendarEventEditorState): { body: EventMutationBody | null; error: string | null } {
  const title = state.title.trim();
  if (!title || title.length > 500) return { body: null, error: "Укажите название до 500 символов." };
  if (state.notes.length > 4000 || state.location.length > 1000) return { body: null, error: "Сократите заметки или место." };
  if (!validDate(state.startDate) || !validDate(state.endDate) || state.endDate < state.startDate) {
    return { body: null, error: "Проверьте даты начала и конца." };
  }
  const shared = {
    title, notes: state.notes.trim() || null, location: state.location.trim() || null,
    all_day: state.allDay, timezone: state.timezone
  };
  if (state.allDay) return {
    body: { ...shared, start_date: state.startDate, end_date_exclusive: addCalendarDays(state.endDate, 1), start_at_utc: null, end_at_utc: null },
    error: null
  };
  const start = reminderUtcFromLocal(state.startDate, state.startTime, state.timezone);
  const end = reminderUtcFromLocal(state.endDate, state.endTime, state.timezone);
  if (!start || !end) return { body: null, error: "Это время неоднозначно или недоступно в выбранном часовом поясе." };
  if (Date.parse(end) <= Date.parse(start)) return { body: null, error: "Конец должен быть позже начала." };
  return {
    body: { ...shared, start_at_utc: start, end_at_utc: end, start_date: null, end_date_exclusive: null },
    error: null
  };
}
