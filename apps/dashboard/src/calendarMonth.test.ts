import { describe, expect, it } from "vitest";
import { calendarMonthGrid, calendarMonthGridFromKey, shiftCalendarMonth } from "./calendarMonth";

describe("calendar month geometry", () => {
  it("builds a Monday-first six-week August grid and exact Moscow boundaries", () => {
    const grid = calendarMonthGrid(2026, 8, "Europe/Moscow");
    expect(grid).toMatchObject({
      monthKey: "2026-08",
      gridStartLocalDate: "2026-07-27",
      gridEndLocalDateExclusive: "2026-09-07",
      rows: 6,
      range: {
        fromLocalDate: "2026-07-27",
        toLocalDateExclusive: "2026-09-07",
        fromUtc: "2026-07-26T21:00:00Z",
        toUtc: "2026-09-06T21:00:00Z"
      }
    });
  });

  it("keeps five-row months at five rows when the first day fits", () => {
    const grid = calendarMonthGridFromKey("2026-02", "Europe/Moscow");
    expect(grid.rows).toBe(5);
    expect(grid.gridStartLocalDate).toBe("2026-01-26");
    expect(grid.gridEndLocalDateExclusive).toBe("2026-03-02");
  });

  it("keeps a Monday-starting 28-day February at five visible weeks", () => {
    const grid = calendarMonthGrid(2021, 2, "Europe/Moscow");
    expect(grid.rows).toBe(5);
    expect(grid.gridStartLocalDate).toBe("2021-02-01");
    expect(grid.gridEndLocalDateExclusive).toBe("2021-03-08");
  });

  it("shifts months without carrying old date identity", () => {
    expect(shiftCalendarMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftCalendarMonth("2026-12", 1)).toBe("2027-01");
  });
});
