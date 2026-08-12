import type {
  PlanningCalendarEvent,
  PlanningProject,
  PlanningReminder,
  PlanningTask
} from "@artem/contracts";
import { localDateForInstant } from "./calendarRange";

export const taskViewLabels: Record<"today" | "overdue" | "upcoming", string> = {
  today: "Сегодня",
  overdue: "Просрочено",
  upcoming: "Скоро"
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
  if (!task.dueDate) return "Срок не задан";
  const date = formatDateOnly(task.dueDate);
  if (!task.dueTime) return `Срок ${date}`;
  return `Срок ${date} · ${task.dueTime.slice(0, 5)} · ${task.timezone ?? "часовой пояс неизвестен"}`;
}

export function formatReminderExactDue(reminder: PlanningReminder): string {
  return `${formatDateTime(reminder.dueAtUtc, reminder.timezone)} · ${reminder.timezone}`;
}

export function formatEventRange(event: PlanningCalendarEvent): string {
  if (event.allDay) {
    return event.startDate && event.endDateExclusive
      ? `${formatDateOnly(event.startDate)} — ${formatDateOnly(event.endDateExclusive)}`
      : "Весь день";
  }
  if (!event.startAtUtc || !event.endAtUtc) return "Время не указано";
  return `${formatDateTime(event.startAtUtc, event.timezone)} — ${formatClock(event.endAtUtc, event.timezone)} · ${event.timezone}`;
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

