import { describe, expect, it } from "vitest";
import {
  calendarAgendaRangeUtc,
  calendarDayRangeUtc
} from "./calendarRange";

describe("calendar IANA range helpers", () => {
  it("converts a Moscow local day to explicit UTC boundaries", () => {
    expect(calendarDayRangeUtc("2026-08-12", "Europe/Moscow")).toMatchObject({
      fromUtc: "2026-08-11T21:00:00Z",
      toUtc: "2026-08-12T21:00:00Z"
    });
  });

  it("keeps a 23-hour Berlin DST day instead of assuming 24 hours", () => {
    const range = calendarDayRangeUtc("2026-03-29", "Europe/Berlin");
    expect(range.fromUtc).toBe("2026-03-28T23:00:00Z");
    expect(range.toUtc).toBe("2026-03-29T22:00:00Z");
    expect(Date.parse(range.toUtc) - Date.parse(range.fromUtc)).toBe(23 * 60 * 60 * 1000);
  });

  it("keeps a 25-hour Berlin DST day instead of assuming 24 hours", () => {
    const range = calendarDayRangeUtc("2026-10-25", "Europe/Berlin");
    expect(range.fromUtc).toBe("2026-10-24T22:00:00Z");
    expect(range.toUtc).toBe("2026-10-25T23:00:00Z");
    expect(Date.parse(range.toUtc) - Date.parse(range.fromUtc)).toBe(25 * 60 * 60 * 1000);
  });

  it("builds a seven-day agenda range from local midnights", () => {
    const range = calendarAgendaRangeUtc("2026-10-22", 7, "Europe/Berlin");
    expect(range.fromLocalDate).toBe("2026-10-22");
    expect(range.toLocalDateExclusive).toBe("2026-10-29");
    expect(Date.parse(range.toUtc) - Date.parse(range.fromUtc)).toBe(169 * 60 * 60 * 1000);
  });
});
