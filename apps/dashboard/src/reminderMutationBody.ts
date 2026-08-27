import type { PlanningReminder } from "@artem/contracts";

export type ReminderMutationSheetMode = "create" | "edit" | "reschedule";

export type ReminderMutationBody = {
  title?: string;
  notes?: string | null;
  due_at_utc?: string;
  timezone?: string;
};

export interface ReminderLocalDateTime {
  date: string;
  time: string;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function zonedParts(instant: Date, timezone: string): ReminderLocalDateTime | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    if (!values.year || !values.month || !values.day || !values.hour || !values.minute) return null;
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
  } catch {
    return null;
  }
}

export function reminderLocalDateTime(reminder: PlanningReminder): ReminderLocalDateTime {
  return zonedParts(new Date(reminder.dueAtUtc), reminder.timezone) ?? {
    date: reminder.dueAtUtc.slice(0, 10),
    time: reminder.dueAtUtc.slice(11, 16)
  };
}

function timezoneOffsetAt(instantMs: number, timezone: string): number | null {
  const parts = zonedParts(new Date(instantMs), timezone);
  if (!parts) return null;
  const representedAsUtc = Date.parse(`${parts.date}T${parts.time}:00Z`);
  return representedAsUtc - instantMs;
}

/** Convert explicit wall-clock fields into one unambiguous UTC timestamp. */
export function reminderUtcFromLocal(
  date: string,
  time: string,
  timezone: string
): string | null {
  if (!datePattern.test(date) || !timePattern.test(time)) return null;
  const naiveMs = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naiveMs)) return null;

  const offsets = new Set<number>();
  for (const probe of [-86_400_000, 0, 86_400_000]) {
    const offset = timezoneOffsetAt(naiveMs + probe, timezone);
    if (offset !== null) offsets.add(offset);
  }
  const candidates = [...offsets]
    .map((offset) => naiveMs - offset)
    .filter((candidate) => {
      const local = zonedParts(new Date(candidate), timezone);
      return local !== null && local.date === date && local.time === time;
    });
  if (candidates.length !== 1) return null;
  return new Date(candidates[0]).toISOString().replace(".000Z", "Z");
}
