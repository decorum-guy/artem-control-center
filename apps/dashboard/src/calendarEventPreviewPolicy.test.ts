import { describe, expect, it } from "vitest";
import type { PlanningParsePreview } from "./planningReadClient";
import { calendarEventPreviewSaveState } from "./calendarEventPreviewPolicy";

const basePreview = {
  schemaVersion: "planning.v1",
  kind: "parse_preview",
  candidate: {
    domain: "calendar_event",
    operation: "create",
    fields: {
      title: "Встреча",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-14T15:30:00Z",
      end_at_utc: "2026-08-14T16:30:00Z"
    },
    normalized_paraphrase: "Встреча 18:30–19:30"
  },
  confidence: "high",
  ambiguities: [],
  requires_confirmation: false,
  normalized_text: "завтра в 18:30–19:30 встреча",
  error_code: null,
  correlation_id: "00000000-0000-4000-8000-000000000799"
} satisfies PlanningParsePreview;

function preview(overrides: Partial<PlanningParsePreview>): PlanningParsePreview {
  return { ...basePreview, ...overrides };
}

function proposalPreview(extraAmbiguities: PlanningParsePreview["ambiguities"] = []): PlanningParsePreview {
  return preview({
    candidate: {
      ...basePreview.candidate,
      fields: {
        ...basePreview.candidate.fields,
        end_at_utc: undefined,
        proposed_end_at_utc: "2026-08-14T16:30:00Z",
        proposed_end_local: "19:30"
      }
    },
    ambiguities: [
      {
        field: "end_time",
        candidates: ["18:30–19:30"],
        reason: "Для события без конца предложена длительность 60 минут; повторите полную фразу для записи."
      },
      ...extraAmbiguities
    ],
    requires_confirmation: true
  });
}

describe("Calendar event preview save policy", () => {
  it("allows an explicit timed range", () => {
    expect(calendarEventPreviewSaveState(basePreview, false).canSave).toBe(true);
  });

  it("allows an unambiguous all-day event", () => {
    const allDay = preview({
      candidate: {
        ...basePreview.candidate,
        fields: {
          title: "Отпуск",
          all_day: true,
          timezone: "Europe/Moscow",
          start_date: "2026-08-14",
          end_date_exclusive: "2026-08-15"
        }
      }
    });
    expect(calendarEventPreviewSaveState(allDay, false).canSave).toBe(true);
  });

  it("blocks the canonical start-only proposal until it is accepted", () => {
    const result = calendarEventPreviewSaveState(proposalPreview(), false);
    expect(result.isCanonicalStartOnlyProposal).toBe(true);
    expect(result.hasMaterialAmbiguity).toBe(false);
    expect(result.canSave).toBe(false);
  });

  it("allows the canonical proposal after explicit acknowledgement", () => {
    expect(calendarEventPreviewSaveState(proposalPreview(), true).canSave).toBe(true);
  });

  it("keeps a proposal plus a second ambiguity blocked", () => {
    const result = calendarEventPreviewSaveState(proposalPreview([
      { field: "date", candidates: ["конкретная дата"], reason: "Событию нужна конкретная дата." }
    ]), true);
    expect(result.isCanonicalStartOnlyProposal).toBe(true);
    expect(result.hasMaterialAmbiguity).toBe(true);
    expect(result.canSave).toBe(false);
  });

  it("blocks confirmation without the exact supported proposal", () => {
    const unsupported = preview({ requires_confirmation: true });
    expect(calendarEventPreviewSaveState(unsupported, true).canSave).toBe(false);
  });

  it("blocks parser errors", () => {
    expect(calendarEventPreviewSaveState(preview({ error_code: "nonexistent_local_time" }), false).canSave).toBe(false);
  });

  it("blocks medium and low confidence previews", () => {
    expect(calendarEventPreviewSaveState(preview({ confidence: "medium" }), false).canSave).toBe(false);
    expect(calendarEventPreviewSaveState(preview({ confidence: "low" }), false).canSave).toBe(false);
  });
});
