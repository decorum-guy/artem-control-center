import type {
  PlanningCalendarEvent,
  PlanningReminder,
  PlanningSnapshot,
  PlanningSourceStatus,
  PlanningTask
} from "@artem/contracts";

const reminderActiveStatuses = new Set<PlanningReminder["status"]>(["pending", "due"]);
const taskPriorityRank: Record<PlanningTask["priority"], number> = {
  high: 0,
  normal: 1,
  low: 2,
  none: 3
};

export type PlanningHealthDisplayState = PlanningSourceStatus | "unavailable";

export interface PlanningHealthPresentation {
  state: PlanningHealthDisplayState;
  label: string | null;
  hasLastGoodData: boolean;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function timestampValue(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareTimestampThenId(
  left: { id: string; timestamp: string | null | undefined },
  right: { id: string; timestamp: string | null | undefined }
): number {
  const timestampDifference = timestampValue(left.timestamp) - timestampValue(right.timestamp);
  if (Number.isFinite(timestampDifference) && timestampDifference !== 0) return timestampDifference;
  return compareStrings(left.id, right.id);
}

/** Select only the canonical active items from the bounded upcoming list. */
export function selectNextReminder(snapshot: PlanningSnapshot): PlanningReminder | null {
  return uniqueById(snapshot.reminders.upcoming)
    .filter((reminder) => reminderActiveStatuses.has(reminder.status))
    .sort((left, right) => compareTimestampThenId(
      { id: left.id, timestamp: left.dueAtUtc },
      { id: right.id, timestamp: right.dueAtUtc }
    ))[0] ?? null;
}

function taskDueSortKey(task: PlanningTask): string {
  if (!task.dueDate) return "9999-12-31T99:99:99";
  return `${task.dueDate}T${task.dueTime ?? "99:99:99"}`;
}

/** Select the highest-priority open overdue task with deterministic due/ID ties. */
export function selectPrimaryOverdueTask(snapshot: PlanningSnapshot): PlanningTask | null {
  return selectOverdueTasks(snapshot)
    .sort((left, right) => {
      const priorityDifference = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
      if (priorityDifference !== 0) return priorityDifference;
      const dueDifference = compareStrings(taskDueSortKey(left), taskDueSortKey(right));
      if (dueDifference !== 0) return dueDifference;
      return compareStrings(left.id, right.id);
    })[0] ?? null;
}

export function selectOverdueTasks(snapshot: PlanningSnapshot): PlanningTask[] {
  return uniqueById(snapshot.tasks.overdue).filter((task) => task.status === "open");
}

export function countOverdueTasks(snapshot: PlanningSnapshot): number {
  return selectOverdueTasks(snapshot).length;
}

/** The global task list is capped at 20, so 20 is intentionally displayed as 20+. */
export function formatOverdueTaskCount(count: number): string {
  if (count <= 0) return "0";
  return count >= 20 ? "20+" : String(count);
}

function calendarEventSortKey(event: PlanningCalendarEvent): string {
  if (event.allDay) return `${event.startDate ?? "9999-12-31"}T00:00:00Z`;
  return event.startAtUtc ?? "9999-12-31T23:59:59Z";
}

/** Prefer the bounded today window and only fall back to the upcoming window when it is empty. */
export function selectNextCalendarEvent(snapshot: PlanningSnapshot): PlanningCalendarEvent | null {
  const candidates = snapshot.calendar.today.length
    ? snapshot.calendar.today
    : snapshot.calendar.upcoming;
  return uniqueById(candidates)
    .sort((left, right) => {
      const startDifference = compareStrings(calendarEventSortKey(left), calendarEventSortKey(right));
      if (startDifference !== 0) return startDifference;
      return compareStrings(left.id, right.id);
    })[0] ?? null;
}

function formatClock(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

function formatDate(value: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    timeZone
  }).format(new Date(`${value}T12:00:00Z`));
}

function formatTimestampDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    timeZone
  }).format(new Date(value));
}

function relativeDueLabel(dueAtUtc: string, now: Date): string {
  const differenceMs = Date.parse(dueAtUtc) - now.getTime();
  if (!Number.isFinite(differenceMs) || differenceMs <= 30_000) return "сейчас";
  const minutes = Math.max(1, Math.ceil(differenceMs / 60_000));
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return remainderMinutes ? `через ${hours} ч ${remainderMinutes} мин` : `через ${hours} ч`;
  const days = Math.floor(hours / 24);
  return `через ${days} дн`;
}

/** Current data may use a local countdown; non-current data always uses a frozen semantic label. */
export function formatReminderDueLabel(
  reminder: PlanningReminder,
  sourceStatus: PlanningSourceStatus,
  now: Date
): string {
  const exactTime = formatClock(reminder.dueAtUtc, reminder.timezone);
  if (sourceStatus === "current") return relativeDueLabel(reminder.dueAtUtc, now);
  return timestampValue(reminder.dueAtUtc) <= now.getTime()
    ? `было на ${exactTime}`
    : `срок ${exactTime}`;
}

export function formatReminderExactTime(reminder: PlanningReminder): string {
  return formatClock(reminder.dueAtUtc, reminder.timezone);
}

export function formatTaskDueLabel(task: PlanningTask): string {
  if (!task.dueDate) return "срок не задан";
  const dateLabel = formatDate(task.dueDate);
  return task.dueTime ? `срок ${dateLabel} · ${task.dueTime.slice(0, 5)}` : `срок ${dateLabel}`;
}

export function formatCalendarEventTime(event: PlanningCalendarEvent): string {
  if (event.allDay) return "Весь день";
  return event.startAtUtc ? formatClock(event.startAtUtc, event.timezone) : "Время не указано";
}

export function formatCalendarEventDate(event: PlanningCalendarEvent): string | null {
  if (event.allDay) return event.startDate ? formatDate(event.startDate) : null;
  return event.startAtUtc ? formatTimestampDate(event.startAtUtc, event.timezone) : null;
}

export function formatPlanningSyncedAt(value: string | null): string | null {
  return value ? formatClock(value) : null;
}

function hasPlanningItems(snapshot: PlanningSnapshot): boolean {
  return Boolean(
    snapshot.reminders.upcoming.length ||
      snapshot.reminders.overdue.length ||
      snapshot.reminders.deliveryFailures.length ||
      snapshot.tasks.today.length ||
      snapshot.tasks.overdue.length ||
      snapshot.tasks.upcoming.length ||
      snapshot.tasks.projects.length ||
      snapshot.calendar.today.length ||
      snapshot.calendar.upcoming.length ||
      snapshot.calendar.conflicts.length
  );
}

export function planningHealthPresentation(
  snapshot: PlanningSnapshot | null | undefined
): PlanningHealthPresentation {
  if (!snapshot) {
    return { state: "unavailable", label: "Планирование недоступно", hasLastGoodData: false };
  }

  const syncedAt = formatPlanningSyncedAt(snapshot.lastSyncedAt);
  switch (snapshot.sourceStatus) {
    case "current":
      return { state: "current", label: null, hasLastGoodData: hasPlanningItems(snapshot) };
    case "degraded":
      return { state: "degraded", label: "Есть проблемы", hasLastGoodData: hasPlanningItems(snapshot) };
    case "stale":
      return {
        state: "stale",
        label: syncedAt ? `Данные от ${syncedAt}` : "Данные устарели",
        hasLastGoodData: hasPlanningItems(snapshot)
      };
    case "offline":
      return {
        state: "offline",
        label: syncedAt ? `Актуальные данные недоступны · от ${syncedAt}` : "Актуальные данные недоступны",
        hasLastGoodData: hasPlanningItems(snapshot)
      };
  }
}
