import { describe, expect, it } from "vitest";
import type { PlanningCalendarEvent } from "@artem/contracts";
import {
  calendarEditorFromParsedBody, calendarEditorWithDuration, calendarEditorWithStart,
  calendarEventBodyFromEditor, initialCalendarEventEditorState
} from "./calendarEventEditor";

const event: PlanningCalendarEvent = {
  id: "00000000-0000-4000-8000-000000000001", version: 4, source: "panel-agent", sourceLabel: "Panel Agent",
  title: "Встреча", notes: "Сохранить текст", location: "Зал", allDay: false, timezone: "Europe/Moscow",
  syncState: "local_only", localOnlyMutable: true, startAtUtc: "2026-08-12T15:30:00Z", endAtUtc: "2026-08-12T16:45:00Z",
  startDate: null, endDateExclusive: null, deletedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z"
};

describe("Calendar structured editor body", () => {
  it("uses the selected day and configured timezone, not the browser timezone", () => {
    const state = { ...initialCalendarEventEditorState("2026-08-12", "local"), title: "Новая встреча" };
    expect(calendarEventBodyFromEditor(state).body).toMatchObject({
      title: "Новая встреча", all_day: false, timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T06:00:00Z", end_at_utc: "2026-08-12T07:00:00Z",
      start_date: null, end_date_exclusive: null
    });
  });

  it("prefills every editable field and keeps notes/location in a full edit", () => {
    const state = initialCalendarEventEditorState("2026-08-14", "local", event);
    expect(state).toMatchObject({ title: "Встреча", notes: "Сохранить текст", location: "Зал", startDate: "2026-08-12", startTime: "18:30", endTime: "19:45", durationMinutes: null });
    expect(calendarEventBodyFromEditor({ ...state, title: "Обновлено" }).body).toMatchObject({
      title: "Обновлено", notes: "Сохранить текст", location: "Зал",
      start_at_utc: event.startAtUtc, end_at_utc: event.endAtUtc
    });
  });

  it("uses inclusive dates in the form and exclusive dates in the all-day mutation", () => {
    const allDay = { ...event, allDay: true, startAtUtc: null, endAtUtc: null, startDate: "2026-08-12", endDateExclusive: "2026-08-15" };
    const state = initialCalendarEventEditorState("2026-08-14", "local", allDay);
    expect(state.endDate).toBe("2026-08-14");
    expect(calendarEventBodyFromEditor(state).body).toMatchObject({ all_day: true, start_date: "2026-08-12", end_date_exclusive: "2026-08-15", start_at_utc: null, end_at_utc: null });
  });

  it("moves the end with an active preset and rejects a manually invalid end", () => {
    let state = { ...initialCalendarEventEditorState("2026-08-12", "local"), title: "Встреча" };
    state = calendarEditorWithDuration(state, 30);
    state = calendarEditorWithStart(state, { startTime: "23:45" });
    expect(state).toMatchObject({ endDate: "2026-08-13", endTime: "00:15", durationMinutes: 30 });
    expect(calendarEventBodyFromEditor(state).body?.end_at_utc).toBe("2026-08-12T21:15:00Z");
    expect(calendarEventBodyFromEditor({ ...state, endDate: "2026-08-12", endTime: "23:00", durationMinutes: null }).error).toBe("Конец должен быть позже начала.");
  });

  it("transfers a confirmed parser candidate into structured fields", () => {
    const state = initialCalendarEventEditorState("2026-08-12", "local");
    const transferred = calendarEditorFromParsedBody(state, { title: "По фразе", all_day: false, timezone: "Europe/Moscow", start_at_utc: "2026-08-14T15:30:00Z", end_at_utc: "2026-08-14T16:30:00Z" });
    expect(transferred).toMatchObject({ title: "По фразе", startDate: "2026-08-14", startTime: "18:30", endTime: "19:30" });
  });

  it("refuses nonexistent local wall time instead of guessing through DST", () => {
    const state = { ...initialCalendarEventEditorState("2026-03-29", "local"), title: "DST", timezone: "Europe/Berlin", startTime: "02:30", endTime: "03:30" };
    expect(calendarEventBodyFromEditor(state)).toMatchObject({ body: null, error: expect.stringContaining("недоступно") });
  });
});
