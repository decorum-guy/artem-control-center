export const DEFAULT_PLANNING_TIME_ZONE = "Europe/Moscow";

export interface CalendarRange {
  fromLocalDate: string;
  toLocalDateExclusive: string;
  fromUtc: string;
  toUtc: string;
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const localPartFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = localPartFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    localPartFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function assertTimeZone(timeZone: string): void {
  if (!timeZone || typeof timeZone !== "string") throw new RangeError("IANA timezone is required");
  formatterFor(timeZone);
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Calendar date must be YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError("Calendar date is invalid");
  }
  return { year, month, day };
}

function formatCalendarDate(parts: { year: number; month: number; day: number }): string {
  return [parts.year, String(parts.month).padStart(2, "0"), String(parts.day).padStart(2, "0")].join("-");
}

export function addCalendarDays(value: string, days: number): string {
  const parts = parseCalendarDate(value);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatCalendarDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  });
}

function localPartsAt(instant: Date, timeZone: string): LocalParts {
  assertTimeZone(timeZone);
  const parts = formatterFor(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const text = parts.find((part) => part.type === type)?.value;
    if (!text) throw new RangeError(`Missing ${type} in timezone conversion`);
    return Number(text);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

/** Convert a local wall-clock value to UTC without consulting the browser timezone. */
export function localDateTimeToUtc(
  localDate: string,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  const date = parseCalendarDate(localDate);
  assertTimeZone(timeZone);
  const localAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  let candidate = localAsUtc;
  // Offset conversion converges across ordinary timezone and DST transitions.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = localPartsAt(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const next = localAsUtc - (actualAsUtc - candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

export function utcTimestamp(value: Date): string {
  return value.toISOString().replace(".000Z", "Z");
}

export function localDateForInstant(instant: Date, timeZone: string): string {
  const parts = localPartsAt(instant, timeZone);
  return formatCalendarDate(parts);
}

export function currentLocalDate(now: Date, timeZone = DEFAULT_PLANNING_TIME_ZONE): string {
  return localDateForInstant(now, timeZone);
}

export function calendarDayRangeUtc(localDate: string, timeZone = DEFAULT_PLANNING_TIME_ZONE): CalendarRange {
  const nextDate = addCalendarDays(localDate, 1);
  const from = localDateTimeToUtc(localDate, timeZone);
  const to = localDateTimeToUtc(nextDate, timeZone);
  return {
    fromLocalDate: localDate,
    toLocalDateExclusive: nextDate,
    fromUtc: utcTimestamp(from),
    toUtc: utcTimestamp(to)
  };
}

export function calendarAgendaRangeUtc(
  firstLocalDate: string,
  days = 7,
  timeZone = DEFAULT_PLANNING_TIME_ZONE
): CalendarRange {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError("Calendar range must be 1..366 days");
  const lastLocalDate = addCalendarDays(firstLocalDate, days);
  const from = localDateTimeToUtc(firstLocalDate, timeZone);
  const to = localDateTimeToUtc(lastLocalDate, timeZone);
  if (to.getTime() <= from.getTime()) throw new RangeError("Calendar range must move forward");
  return {
    fromLocalDate: firstLocalDate,
    toLocalDateExclusive: lastLocalDate,
    fromUtc: utcTimestamp(from),
    toUtc: utcTimestamp(to)
  };
}

export function shiftCalendarRange(range: CalendarRange, days: number, timeZone = DEFAULT_PLANNING_TIME_ZONE): CalendarRange {
  return calendarAgendaRangeUtc(range.fromLocalDate, days, timeZone);
}
