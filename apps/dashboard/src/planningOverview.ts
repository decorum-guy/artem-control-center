import type {
  PlanningCalendarEvent,
  PlanningReminder,
  PlanningSnapshot,
  PlanningSourceStatus,
  PlanningTask
} from "@artem/contracts";
import { planningOverviewModules } from "./planningModuleRegistry";

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

function parseTimestamp(value: string | null | undefined): Date | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function validDate(value: Date): Date | null {
  return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
}

/** Current data follows the live presentation clock; non-current data follows its canonical snapshot time. */
export function planningReferenceTime(snapshot: PlanningSnapshot, liveNow: Date): Date | null {
  if (snapshot.sourceStatus === "current") return validDate(liveNow);
  return parseTimestamp(snapshot.lastSyncedAt) ?? parseTimestamp(snapshot.generatedAt);
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
  return selectUpcomingReminders(snapshot)[0] ?? null;
}

/** Return the bounded active reminder projection in canonical due order. */
export function selectUpcomingReminders(snapshot: PlanningSnapshot): PlanningReminder[] {
  return uniqueById(snapshot.reminders.upcoming)
    .filter((reminder) => reminderActiveStatuses.has(reminder.status))
    .sort((left, right) => compareTimestampThenId(
      { id: left.id, timestamp: left.dueAtUtc },
      { id: right.id, timestamp: right.dueAtUtc }
    ));
}

function taskDueSortKey(task: PlanningTask): string {
  if (!task.dueDate) return "9999-12-31T99:99:99";
  return `${task.dueDate}T${task.dueTime ?? "99:99:99"}`;
}

/** Select the highest-priority open overdue task with deterministic due/ID ties. */
export function selectPrimaryOverdueTask(snapshot: PlanningSnapshot): PlanningTask | null {
  return sortOverdueTasks(selectOverdueTasks(snapshot))[0] ?? null;
}

export function selectOverdueTasks(snapshot: PlanningSnapshot): PlanningTask[] {
  return uniqueById(snapshot.tasks.overdue).filter((task) => task.status === "open");
}

function sortOverdueTasks(tasks: PlanningTask[]): PlanningTask[] {
  return tasks.sort((left, right) => {
    const priorityDifference = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
    if (priorityDifference !== 0) return priorityDifference;
    const dueDifference = compareStrings(taskDueSortKey(left), taskDueSortKey(right));
    if (dueDifference !== 0) return dueDifference;
    return compareStrings(left.id, right.id);
  });
}

/** Select open upcoming tasks only when the snapshot has no overdue task slot. */
export function selectUpcomingTasks(snapshot: PlanningSnapshot): PlanningTask[] {
  return uniqueById(snapshot.tasks.upcoming)
    .filter((task) => task.status === "open")
    .sort((left, right) => {
      const dueDifference = compareStrings(taskDueSortKey(left), taskDueSortKey(right));
      if (dueDifference !== 0) return dueDifference;
      const priorityDifference = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
      return priorityDifference || compareStrings(left.id, right.id);
    });
}

export function countOverdueTasks(snapshot: PlanningSnapshot): number {
  return selectOverdueTasks(snapshot).length;
}

/** The global task list is capped at 20, so 20 is intentionally displayed as 20+. */
export function formatOverdueTaskCount(count: number): string {
  if (count <= 0) return "0";
  return count >= 20 ? "20+" : String(count);
}

function validCalendarDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? value
    : null;
}

function localDateKey(value: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric"
    }).formatToParts(value);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return validCalendarDate(year && month && day ? `${year}-${month}-${day}` : null);
  } catch {
    return null;
  }
}

function allDayCoversDate(event: PlanningCalendarEvent, date: string | null): boolean {
  const startDate = validCalendarDate(event.startDate);
  const endDateExclusive = validCalendarDate(event.endDateExclusive);
  return Boolean(startDate && endDateExclusive && date && startDate < endDateExclusive && startDate <= date && date < endDateExclusive);
}

function allDayHasNotEnded(event: PlanningCalendarEvent, date: string | null): boolean {
  const startDate = validCalendarDate(event.startDate);
  const endDateExclusive = validCalendarDate(event.endDateExclusive);
  return Boolean(startDate && endDateExclusive && date && startDate < endDateExclusive && endDateExclusive > date);
}

type CalendarCandidate = {
  event: PlanningCalendarEvent;
  orderRank: 0 | 1 | 2;
  sortKey: string;
  calendarDay: string | null;
};

function relevantCalendarCandidates(
  events: PlanningCalendarEvent[],
  referenceTime: Date | null,
  scope: "today" | "upcoming"
): CalendarCandidate[] {
  if (!referenceTime) return [];
  const referenceMs = referenceTime.getTime();
  const candidates: CalendarCandidate[] = [];

  for (const event of uniqueById(events)) {
    if (event.allDay) {
      const eventLocalDate = localDateKey(referenceTime, event.timezone);
      const relevant = scope === "today"
        ? allDayCoversDate(event, eventLocalDate)
        : allDayHasNotEnded(event, eventLocalDate);
      const startDate = validCalendarDate(event.startDate);
      if (relevant && startDate) {
        candidates.push({
          event,
          orderRank: 0,
          sortKey: startDate,
          calendarDay: scope === "upcoming" ? startDate : null
        });
      }
      continue;
    }

    const start = parseTimestamp(event.startAtUtc);
    const end = parseTimestamp(event.endAtUtc);
    if (!start || !end || end.getTime() <= start.getTime()) continue;
    if (start.getTime() <= referenceMs && end.getTime() > referenceMs) {
      const calendarDay = scope === "upcoming" ? localDateKey(start, event.timezone) : null;
      if (scope === "upcoming" && !calendarDay) continue;
      candidates.push({
        event,
        orderRank: 1,
        sortKey: event.startAtUtc ?? "",
        calendarDay
      });
    } else if (start.getTime() > referenceMs) {
      const calendarDay = scope === "upcoming" ? localDateKey(start, event.timezone) : null;
      if (scope === "upcoming" && !calendarDay) continue;
      candidates.push({
        event,
        orderRank: scope === "upcoming" ? 1 : 2,
        sortKey: event.startAtUtc ?? "",
        calendarDay
      });
    }
  }

  return candidates;
}

function compareCalendarCandidates(
  left: CalendarCandidate,
  right: CalendarCandidate,
  scope: "today" | "upcoming"
): number {
  if (scope === "upcoming") {
    const calendarDayDifference = compareStrings(left.calendarDay ?? "9999-12-31", right.calendarDay ?? "9999-12-31");
    if (calendarDayDifference !== 0) return calendarDayDifference;
  }
  if (left.orderRank !== right.orderRank) return left.orderRank - right.orderRank;
  const sortDifference = compareStrings(left.sortKey, right.sortKey);
  return sortDifference || compareStrings(left.event.id, right.event.id);
}

/** Prefer relevant today events and fall back to upcoming when today's events have ended. */
export function selectNextCalendarEvent(
  snapshot: PlanningSnapshot,
  liveNow: Date
): PlanningCalendarEvent | null {
  const referenceTime = planningReferenceTime(snapshot, liveNow);
  const todayCandidates = relevantCalendarCandidates(snapshot.calendar.today, referenceTime, "today")
    .sort((left, right) => compareCalendarCandidates(left, right, "today"));
  if (todayCandidates.length) return todayCandidates[0].event;

  return relevantCalendarCandidates(snapshot.calendar.upcoming, referenceTime, "upcoming")
    .sort((left, right) => compareCalendarCandidates(left, right, "upcoming"))[0]?.event ?? null;
}

/** Return all bounded current-day/upcoming calendar events in display order. */
export function selectUpcomingCalendarEvents(
  snapshot: PlanningSnapshot,
  liveNow: Date
): PlanningCalendarEvent[] {
  const referenceTime = planningReferenceTime(snapshot, liveNow);
  const today = relevantCalendarCandidates(snapshot.calendar.today, referenceTime, "today")
    .sort((left, right) => compareCalendarCandidates(left, right, "today"));
  const upcoming = relevantCalendarCandidates(snapshot.calendar.upcoming, referenceTime, "upcoming")
    .sort((left, right) => compareCalendarCandidates(left, right, "upcoming"));
  return uniqueById([...today, ...upcoming].map((candidate) => candidate.event));
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
      (snapshot.tasks.undated?.length ?? 0) ||
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

  switch (snapshot.sourceStatus) {
    case "current":
      return { state: "current", label: null, hasLastGoodData: hasPlanningItems(snapshot) };
    case "degraded":
      return { state: "degraded", label: "Есть проблемы", hasLastGoodData: hasPlanningItems(snapshot) };
    case "stale":
      return {
        state: "stale",
        label: "Данные могут быть устаревшими",
        hasLastGoodData: hasPlanningItems(snapshot)
      };
    case "offline":
      return {
        state: "offline",
        label: "Данные недоступны",
        hasLastGoodData: hasPlanningItems(snapshot)
      };
  }
}

export interface PlanningOverviewModuleSummary {
  readonly moduleId: string;
  readonly status: "available" | "unavailable";
}

export interface PlanningOverviewSummary {
  readonly health: PlanningHealthPresentation;
  readonly reminder: PlanningReminder | null;
  readonly overdueTask: PlanningTask | null;
  readonly overdueTaskCount: number;
  readonly event: PlanningCalendarEvent | null;
  readonly overviewItems: readonly PlanningOverviewItem[];
  readonly modules: readonly PlanningOverviewModuleSummary[];
}

export type PlanningOverviewItem =
  | { readonly kind: "reminder"; readonly item: PlanningReminder }
  | { readonly kind: "task"; readonly item: PlanningTask; readonly overdue: boolean }
  | { readonly kind: "calendar"; readonly item: PlanningCalendarEvent };

function overviewItemSortKey(entry: PlanningOverviewItem): string {
  if (entry.kind === "reminder") return entry.item.dueAtUtc ?? "9999-12-31T99:99:99";
  if (entry.kind === "task") return taskDueSortKey(entry.item);
  return entry.item.startAtUtc ?? "9999-12-31T99:99:99";
}

function overviewItemKindRank(kind: PlanningOverviewItem["kind"]): number {
  return kind === "reminder" ? 0 : kind === "task" ? 1 : 2;
}

export function planningOverviewRowLimit(sizeVariant: string): 2 | 3 {
  return sizeVariant === "compact" ? 2 : 3;
}

/** Fixed source-owned contribution layer for the compact `Дела` widget. */
export function planningOverviewSummary(
  snapshot: PlanningSnapshot | null | undefined,
  referenceTime: Date
): PlanningOverviewSummary {
  const safe = <T,>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const health = safe(() => planningHealthPresentation(snapshot), planningHealthPresentation(undefined));
  if (!snapshot) {
    return {
      health,
      reminder: null,
      overdueTask: null,
      overdueTaskCount: 0,
      event: null,
      overviewItems: [],
      modules: planningOverviewModules.map((module) => ({ moduleId: module.id, status: "unavailable" }))
    };
  }

  const reminder = safe(() => selectNextReminder(snapshot), null);
  const overdueTasks = safe(() => sortOverdueTasks(selectOverdueTasks(snapshot)), []);
  const overdueTask = overdueTasks[0] ?? null;
  const overdueTaskCount = overdueTasks.length;
  const event = safe(() => selectNextCalendarEvent(snapshot, referenceTime), null);
  const reminders = safe(() => selectUpcomingReminders(snapshot), []);
  const tasks = overdueTasks.length > 0
    ? overdueTasks.map((item) => ({ item, overdue: true as const }))
    : safe(() => selectUpcomingTasks(snapshot), []).map((item) => ({ item, overdue: false as const }));
  const events = safe(() => selectUpcomingCalendarEvents(snapshot, referenceTime), []);
  const overviewItems: PlanningOverviewItem[] = [
    ...reminders.map((item) => ({ kind: "reminder" as const, item })),
    ...tasks.map(({ item, overdue }) => ({ kind: "task" as const, item, overdue })),
    ...events.map((item) => ({ kind: "calendar" as const, item }))
  ].sort((left, right) => {
    const timestampDifference = compareStrings(overviewItemSortKey(left), overviewItemSortKey(right));
    if (timestampDifference !== 0) return timestampDifference;
    const kindDifference = overviewItemKindRank(left.kind) - overviewItemKindRank(right.kind);
    return kindDifference || compareStrings(left.item.id, right.item.id);
  });
  const modules = planningOverviewModules.map((module) => ({
    moduleId: module.id,
    status: "available" as const
  }));
  return { health, reminder, overdueTask, overdueTaskCount, event, overviewItems, modules };
}
