import { describe, expect, it } from "vitest";
import { eventMutationBodyFromPreview } from "./eventMutationBody";

describe("Calendar event mutation body", () => {
  it("accepts explicit timed and all-day canonical shapes", () => {
    expect(eventMutationBodyFromPreview("create", {
      title: "Встреча",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T10:00:00Z",
      end_at_utc: "2026-08-12T11:00:00Z"
    })).toEqual({
      title: "Встреча",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T10:00:00Z",
      end_at_utc: "2026-08-12T11:00:00Z",
      start_date: null,
      end_date_exclusive: null
    });

    expect(eventMutationBodyFromPreview("create", {
      title: "Отпуск",
      all_day: true,
      timezone: "Europe/Moscow",
      start_date: "2026-08-12",
      end_date_exclusive: "2026-08-13"
    })).toMatchObject({
      all_day: true,
      start_date: "2026-08-12",
      end_date_exclusive: "2026-08-13",
      start_at_utc: null,
      end_at_utc: null
    });
  });

  it("requires explicit acknowledgement before sending a start-only proposed end", () => {
    const fields = {
      title: "Встреча",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T10:00:00Z",
      proposed_end_at_utc: "2026-08-12T11:00:00Z"
    };
    expect(eventMutationBodyFromPreview("create", fields, false).end_at_utc).toBeUndefined();
    const accepted = eventMutationBodyFromPreview("create", fields, true);
    expect(accepted.end_at_utc).toBe("2026-08-12T11:00:00Z");
    expect(accepted).not.toHaveProperty("proposed_end_at_utc");
    expect(accepted).not.toHaveProperty("proposed_end_local");
    expect(accepted).not.toHaveProperty("sync_state");
  });

  it("omits notes and location from parser-driven edit to avoid silent clearing", () => {
    const body = eventMutationBodyFromPreview("edit", {
      title: "Встреча",
      notes: null,
      location: null,
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T10:00:00Z",
      end_at_utc: "2026-08-12T11:00:00Z"
    });
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("location");
    expect(body.start_date).toBeNull();
    expect(body.end_date_exclusive).toBeNull();
  });

  it("clears the opposite canonical shape during timed/all-day transitions", () => {
    expect(eventMutationBodyFromPreview("edit", {
      title: "Весь день",
      all_day: true,
      timezone: "Europe/Moscow",
      start_date: "2026-08-12",
      end_date_exclusive: "2026-08-13"
    })).toMatchObject({
      all_day: true,
      start_at_utc: null,
      end_at_utc: null,
      start_date: "2026-08-12",
      end_date_exclusive: "2026-08-13"
    });
    expect(eventMutationBodyFromPreview("edit", {
      title: "С временем",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T10:00:00Z",
      end_at_utc: "2026-08-12T11:00:00Z"
    })).toMatchObject({
      all_day: false,
      start_at_utc: "2026-08-12T10:00:00Z",
      end_at_utc: "2026-08-12T11:00:00Z",
      start_date: null,
      end_date_exclusive: null
    });
  });
});
