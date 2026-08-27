import type {
  CalendarDisplayColorOverride,
  PlanningCalendarEvent,
  PlanningProject,
  PlanningReminder,
  PlanningSourceStatus,
  PlanningTask
} from "@artem/contracts";
import type { CalendarRange } from "./calendarRange";
import { calendarDayRangeUtc, DEFAULT_PLANNING_TIME_ZONE, localDateForInstant } from "./calendarRange";
import type { PlanningCalendarSource } from "@artem/contracts";
import { calendarEventDisplayColor } from "./calendarDisplayColors";

export const taskViewLabels: Record<"today" | "overdue" | "upcoming" | "undated", string> = {
  today: "Сегодня",
  overdue: "Просрочено",
  upcoming: "Скоро",
  undated: "Без срока"
};

export const reminderViewLabels: Record<"upcoming" | "overdue" | "delivery", string> = {
  upcoming: "Скоро",
  overdue: "Пропущено",
  delivery: "Доставка"
};

export const priorityLabels: Record<PlanningTask["priority"], string> = {
  high: "Высокий",
  normal: "Обычный",
  low: "Низкий",
  none: "Без приоритета"
};

export const lifecycleLabels: Record<PlanningReminder["status"], string> = {
  pending: "Ожидает",
  due: "Срок наступил",
  completed: "Завершено",
  cancelled: "Отменено"
};

export const deliveryLabels: Record<PlanningReminder["deliveryState"], string> = {
  not_due: "Доставка ещё не началась",
  queued: "В очереди",
  retrying: "Повторная попытка",
  delivered: "Доставлено · ждёт завершения",
  failed: "Не доставлено"
};

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(new Date(`${value}T12:00:00Z`));
}

function formatClock(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

function formatDateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

export function formatTaskDueForRoute(task: PlanningTask): string {
  if (!task.dueDate) return "Без срока";
  const date = formatDateOnly(task.dueDate);
  if (!task.dueTime) return `Срок ${date}`;
  return `Срок ${date} · ${task.dueTime.slice(0, 5)} · ${task.timezone ?? "часовой пояс неизвестен"}`;
}

export function formatReminderExactDue(reminder: PlanningReminder): string {
  return `${formatDateTime(reminder.dueAtUtc, reminder.timezone)} · ${reminder.timezone}`;
}

export function formatEventRange(event: PlanningCalendarEvent, includeTimezone = false): string {
  if (event.allDay) {
    return event.startDate && event.endDateExclusive
      ? `${formatDateOnly(event.startDate)} — ${formatDateOnly(event.endDateExclusive)}`
      : "Весь день";
  }
  if (!event.startAtUtc || !event.endAtUtc) return "Время не указано";
  const range = `${formatDateTime(event.startAtUtc, event.timezone)} — ${formatClock(event.endAtUtc, event.timezone)}`;
  return includeTimezone ? `${range} · ${event.timezone}` : range;
}

export function projectNameForTask(task: PlanningTask, projects: PlanningProject[]): string {
  if (!task.projectId) return "";
  return projects.find((project) => project.id === task.projectId)?.name ?? "Проект недоступен";
}

export function eventOverlapIds(events: PlanningCalendarEvent[]): Set<string> {
  const timed = events.filter((event) => !event.allDay && event.startAtUtc && event.endAtUtc);
  const result = new Set<string>();
  for (let leftIndex = 0; leftIndex < timed.length; leftIndex += 1) {
    const left = timed[leftIndex];
    const leftStart = Date.parse(left.startAtUtc!);
    const leftEnd = Date.parse(left.endAtUtc!);
    for (let rightIndex = leftIndex + 1; rightIndex < timed.length; rightIndex += 1) {
      const right = timed[rightIndex];
      const rightStart = Date.parse(right.startAtUtc!);
      const rightEnd = Date.parse(right.endAtUtc!);
      // Half-open intervals: [start, end). Boundary-touching events are valid.
      if (leftStart < rightEnd && rightStart < leftEnd) {
        result.add(left.id);
        result.add(right.id);
      }
    }
  }
  return result;
}

export type EventTemporalState = "past" | "running" | "future" | "all-day";

export function eventTemporalState(event: PlanningCalendarEvent, now: Date): EventTemporalState {
  if (event.allDay) return "all-day";
  if (!event.startAtUtc || !event.endAtUtc) return "future";
  const nowMs = now.getTime();
  const start = Date.parse(event.startAtUtc);
  const end = Date.parse(event.endAtUtc);
  if (end <= nowMs) return "past";
  if (start <= nowMs) return "running";
  return "future";
}

function validRouteDate(value: string | null | undefined): Date | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Freeze last-good route presentation at its canonical sync time. */
export function planningRouteReferenceTime(
  sourceStatus: PlanningSourceStatus | "unavailable",
  generatedAt: string | null,
  lastSyncedAt: string | null,
  liveNow: Date,
  preview: boolean
): Date {
  if (!preview && sourceStatus === "current") return new Date(liveNow.getTime());
  return validRouteDate(lastSyncedAt)
    ?? validRouteDate(generatedAt)
    ?? new Date(liveNow.getTime());
}

export function calendarEventsInRange(
  events: PlanningCalendarEvent[],
  range: CalendarRange
): PlanningCalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    if (event.allDay) {
      return Boolean(
        event.startDate &&
        event.endDateExclusive &&
        event.startDate < range.toLocalDateExclusive &&
        event.endDateExclusive > range.fromLocalDate
      );
    }
    if (!event.startAtUtc || !event.endAtUtc) return false;
    return Date.parse(event.startAtUtc) < Date.parse(range.toUtc)
      && Date.parse(event.endAtUtc) > Date.parse(range.fromUtc);
  });
}

export function calendarEventsForLocalDay(
  events: PlanningCalendarEvent[],
  localDate: string,
  timeZone = DEFAULT_PLANNING_TIME_ZONE
): PlanningCalendarEvent[] {
  const dayRange = calendarDayRangeUtc(localDate, timeZone);
  return calendarEventsInRange(events, dayRange).sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    return (left.startAtUtc ?? left.startDate ?? "").localeCompare(right.startAtUtc ?? right.startDate ?? "")
      || left.id.localeCompare(right.id);
  });
}

export function calendarEventColor(
  event: PlanningCalendarEvent,
  sources: PlanningCalendarSource[],
  overrides: readonly CalendarDisplayColorOverride[] = []
): string {
  return calendarEventDisplayColor(event, sources, overrides);
}

function addLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return [result.getUTCFullYear(), String(result.getUTCMonth() + 1).padStart(2, "0"), String(result.getUTCDate()).padStart(2, "0")].join("-");
}

export interface CalendarDayGroup {
  localDate: string;
  allDay: PlanningCalendarEvent[];
  timed: PlanningCalendarEvent[];
}

export function groupCalendarEvents(
  events: PlanningCalendarEvent[],
  fromLocalDate: string,
  toLocalDateExclusive: string
): CalendarDayGroup[] {
  const groups: CalendarDayGroup[] = [];
  for (let date = fromLocalDate; date < toLocalDateExclusive; date = addLocalDate(date, 1)) {
    const allDay = events
      .filter((event) => {
        if (!event.allDay || !event.startDate || !event.endDateExclusive) return false;
        return event.startDate <= date && date < event.endDateExclusive;
      })
      .sort((left, right) => (left.startDate ?? "").localeCompare(right.startDate ?? "") || left.id.localeCompare(right.id));
    const timed = events
      .filter((event) => {
        if (event.allDay || !event.startAtUtc) return false;
        return localDateForInstant(new Date(event.startAtUtc), event.timezone) === date;
      })
      .sort((left, right) => (left.startAtUtc ?? "").localeCompare(right.startAtUtc ?? "") || left.id.localeCompare(right.id));
    if (allDay.length || timed.length) groups.push({ localDate: date, allDay, timed });
  }
  return groups;
}

export function reminderMatchesView(
  reminder: PlanningReminder,
  view: "upcoming" | "overdue" | "delivery",
  referenceTime: Date
): boolean {
  if (view === "delivery") return reminder.status === "due" && ["queued", "retrying", "failed"].includes(reminder.deliveryState);
  if (!(["pending", "due"] as string[]).includes(reminder.status)) return false;
  const due = Date.parse(reminder.dueAtUtc);
  return view === "upcoming" ? due >= referenceTime.getTime() : due < referenceTime.getTime();
}

export function deliveryAttentionRank(state: PlanningReminder["deliveryState"]): number {
  return state === "failed" ? 0 : state === "retrying" ? 1 : state === "queued" ? 2 : 3;
}
