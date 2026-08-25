import {
  addCalendarDays,
  calendarAgendaRangeUtc,
  DEFAULT_PLANNING_TIME_ZONE,
  type CalendarRange
} from "./calendarRange";

export interface CalendarMonthGrid {
  year: number;
  month: number;
  monthKey: string;
  firstLocalDate: string;
  lastLocalDateExclusive: string;
  gridStartLocalDate: string;
  gridEndLocalDateExclusive: string;
  rows: number;
  range: CalendarRange;
}

function dateValue(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function assertMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("Calendar month is invalid");
  }
}

export function calendarMonthKey(year: number, month: number): string {
  assertMonth(year, month);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function calendarMonthKeyForDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(localDate);
  if (!match) throw new RangeError("Calendar date must be YYYY-MM-DD");
  return calendarMonthKey(Number(match[1]), Number(match[2]));
}

export function calendarMonthGrid(
  year: number,
  month: number,
  timeZone = DEFAULT_PLANNING_TIME_ZONE
): CalendarMonthGrid {
  assertMonth(year, month);
  const firstLocalDate = dateValue(year, month, 1);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(`${firstLocalDate}T12:00:00Z`).getUTCDay();
  // Monday-first geometry: Monday=0, ..., Sunday=6.
  const leadingDays = firstWeekday === 0 ? 6 : firstWeekday - 1;
  // Keep the compact calendar legible: the product uses five or six visible
  // weeks, never a four-row February that changes the route height abruptly.
  const rows = Math.max(5, Math.ceil((leadingDays + daysInMonth) / 7));
  const gridStartLocalDate = addCalendarDays(firstLocalDate, -leadingDays);
  const gridDays = rows * 7;
  const gridEndLocalDateExclusive = addCalendarDays(gridStartLocalDate, gridDays);
  const lastLocalDateExclusive = addCalendarDays(firstLocalDate, daysInMonth);
  return {
    year,
    month,
    monthKey: calendarMonthKey(year, month),
    firstLocalDate,
    lastLocalDateExclusive,
    gridStartLocalDate,
    gridEndLocalDateExclusive,
    rows,
    range: calendarAgendaRangeUtc(gridStartLocalDate, gridDays, timeZone)
  };
}

export function calendarMonthGridFromKey(
  monthKey: string,
  timeZone = DEFAULT_PLANNING_TIME_ZONE
): CalendarMonthGrid {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new RangeError("Calendar month must be YYYY-MM");
  return calendarMonthGrid(Number(match[1]), Number(match[2]), timeZone);
}

export function shiftCalendarMonth(monthKey: string, delta: number): string {
  if (!Number.isInteger(delta)) throw new RangeError("Calendar month shift must be an integer");
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new RangeError("Calendar month must be YYYY-MM");
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return calendarMonthKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1);
}
