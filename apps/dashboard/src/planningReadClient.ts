import { useEffect, useRef, useState } from "react";
import type {
  PlanningCalendarEvent,
  PlanningProject,
  PlanningReminder,
  PlanningSource,
  PlanningSourceStatus,
  PlanningTask
} from "@artem/contracts";
import { planningRouteLimit } from "./planningRouteConfig";

export interface PlanningReadEnvelope<T> {
  schemaVersion: "planning.panel.v1";
  kind: "list";
  domain: "reminder" | "task" | "calendar_event" | "project";
  generatedAt: string;
  sourceStatus: PlanningSourceStatus;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  items: T[];
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
}

export type ReminderMonitorView = "upcoming" | "overdue" | "delivery";
export type TaskRouteView = "today" | "overdue" | "upcoming";

export class PlanningReadError extends Error {
  readonly status: number | null;
  readonly code: "aborted" | "network" | "http" | "malformed" | "contract";

  constructor(
    message: string,
    code: PlanningReadError["code"],
    status: number | null = null
  ) {
    super(message);
    this.name = "PlanningReadError";
    this.code = code;
    this.status = status;
  }
}

const sourceValues = new Set<PlanningSource>([
  "alice",
  "telegram",
  "panel-agent",
  "operator",
  "ticktick",
  "calendar-provider",
  "system"
]);
const sourceStatusValues = new Set<PlanningSourceStatus>(["current", "stale", "offline", "degraded"]);
const reminderStatusValues = new Set<PlanningReminder["status"]>(["pending", "due", "completed", "cancelled"]);
const deliveryStateValues = new Set<PlanningReminder["deliveryState"]>([
  "not_due",
  "queued",
  "retrying",
  "delivered",
  "failed"
]);
const priorityValues = new Set<PlanningTask["priority"]>(["none", "low", "normal", "high"]);
const taskStatusValues = new Set<PlanningTask["status"]>(["open", "completed", "archived"]);
const eventSyncValues = new Set<PlanningCalendarEvent["syncState"]>([
  "local_only",
  "pending",
  "synced",
  "stale",
  "conflict",
  "error"
]);

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const uuid4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanningReadError(`${label} is not an object`, "contract");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PlanningReadError(`${label} contains unexpected fields`, "contract");
  }
}

function stringValue(value: unknown, label: string, minLength = 1, maxLength = 1000): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return value;
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PlanningReadError(`${label} is invalid`, "contract");
  return value;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return value as T;
}

function timestampValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 20, 32);
  if (!timestampPattern.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestampValue(value, label);
}

function dateValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 10, 10);
  if (!datePattern.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`))) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return result;
}

function nullableDate(value: unknown, label: string): string | null {
  return value === null ? null : dateValue(value, label);
}

function timeValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 5, 8);
  if (!timePattern.test(result)) throw new PlanningReadError(`${label} is invalid`, "contract");
  return result;
}

function nullableTime(value: unknown, label: string): string | null {
  return value === null ? null : timeValue(value, label);
}

function timezoneValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 1, 64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result }).format();
  } catch {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return result;
}

function nullableTimezone(value: unknown, label: string): string | null {
  return value === null ? null : timezoneValue(value, label);
}

function uuidValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 36, 36);
  if (!uuid4Pattern.test(result)) throw new PlanningReadError(`${label} is invalid`, "contract");
  return result;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuidValue(value, label);
}

function parseReminder(value: unknown): PlanningReminder {
  const item = record(value, "planning.reminder");
  exactKeys(
    item,
    ["id", "version", "source", "sourceLabel", "title", "dueAtUtc", "timezone", "status", "deliveryState", "createdAt", "updatedAt"],
    "planning.reminder"
  );
  return {
    id: uuidValue(item.id, "planning.reminder.id"),
    version: integerValue(item.version, "planning.reminder.version", 1, Number.MAX_SAFE_INTEGER),
    source: enumValue(item.source, sourceValues, "planning.reminder.source"),
    sourceLabel: stringValue(item.sourceLabel, "planning.reminder.sourceLabel", 1, 64),
    title: stringValue(item.title, "planning.reminder.title", 1, 500),
    dueAtUtc: timestampValue(item.dueAtUtc, "planning.reminder.dueAtUtc"),
    timezone: timezoneValue(item.timezone, "planning.reminder.timezone"),
    status: enumValue(item.status, reminderStatusValues, "planning.reminder.status"),
    deliveryState: enumValue(item.deliveryState, deliveryStateValues, "planning.reminder.deliveryState"),
    createdAt: timestampValue(item.createdAt, "planning.reminder.createdAt"),
    updatedAt: timestampValue(item.updatedAt, "planning.reminder.updatedAt")
  };
}

function parseTask(value: unknown): PlanningTask {
  const item = record(value, "planning.task");
  exactKeys(
    item,
    ["id", "version", "source", "sourceLabel", "title", "priority", "status", "dueDate", "dueTime", "timezone", "projectId", "createdAt", "updatedAt"],
    "planning.task"
  );
  const dueDate = nullableDate(item.dueDate, "planning.task.dueDate");
  const dueTime = nullableTime(item.dueTime, "planning.task.dueTime");
  const timezone = nullableTimezone(item.timezone, "planning.task.timezone");
  if (!dueDate && (dueTime || timezone)) throw new PlanningReadError("date-only task shape is invalid", "contract");
  if (dueDate && dueTime && !timezone) throw new PlanningReadError("timed task timezone is missing", "contract");
  if (dueDate && !dueTime && timezone) throw new PlanningReadError("date-only task has timezone", "contract");
  return {
    id: uuidValue(item.id, "planning.task.id"),
    version: integerValue(item.version, "planning.task.version", 1, Number.MAX_SAFE_INTEGER),
    source: enumValue(item.source, sourceValues, "planning.task.source"),
    sourceLabel: stringValue(item.sourceLabel, "planning.task.sourceLabel", 1, 64),
    title: stringValue(item.title, "planning.task.title", 1, 500),
    priority: enumValue(item.priority, priorityValues, "planning.task.priority"),
    status: enumValue(item.status, taskStatusValues, "planning.task.status"),
    dueDate,
    dueTime,
    timezone,
    projectId: nullableUuid(item.projectId, "planning.task.projectId"),
    createdAt: timestampValue(item.createdAt, "planning.task.createdAt"),
    updatedAt: timestampValue(item.updatedAt, "planning.task.updatedAt")
  };
}

function parseCalendarEvent(value: unknown): PlanningCalendarEvent {
  const item = record(value, "planning.calendar_event");
  exactKeys(
    item,
    ["id", "version", "source", "sourceLabel", "title", "allDay", "timezone", "syncState", "startAtUtc", "endAtUtc", "startDate", "endDateExclusive", "createdAt", "updatedAt"],
    "planning.calendar_event"
  );
  const allDay = booleanValue(item.allDay, "planning.calendar_event.allDay");
  const startAtUtc = nullableTimestamp(item.startAtUtc, "planning.calendar_event.startAtUtc");
  const endAtUtc = nullableTimestamp(item.endAtUtc, "planning.calendar_event.endAtUtc");
  const startDate = nullableDate(item.startDate, "planning.calendar_event.startDate");
  const endDateExclusive = nullableDate(item.endDateExclusive, "planning.calendar_event.endDateExclusive");
  if (allDay && (!startDate || !endDateExclusive || startAtUtc || endAtUtc)) {
    throw new PlanningReadError("all-day event shape is invalid", "contract");
  }
  if (!allDay && (!startAtUtc || !endAtUtc || startDate || endDateExclusive)) {
    throw new PlanningReadError("timed event shape is invalid", "contract");
  }
  return {
    id: uuidValue(item.id, "planning.calendar_event.id"),
    version: integerValue(item.version, "planning.calendar_event.version", 1, Number.MAX_SAFE_INTEGER),
    source: enumValue(item.source, sourceValues, "planning.calendar_event.source"),
    sourceLabel: stringValue(item.sourceLabel, "planning.calendar_event.sourceLabel", 1, 64),
    title: stringValue(item.title, "planning.calendar_event.title", 1, 500),
    allDay,
    timezone: timezoneValue(item.timezone, "planning.calendar_event.timezone"),
    syncState: enumValue(item.syncState, eventSyncValues, "planning.calendar_event.syncState"),
    startAtUtc,
    endAtUtc,
    startDate,
    endDateExclusive,
    createdAt: timestampValue(item.createdAt, "planning.calendar_event.createdAt"),
    updatedAt: timestampValue(item.updatedAt, "planning.calendar_event.updatedAt")
  };
}

function parseProject(value: unknown): PlanningProject {
  const item = record(value, "planning.project");
  exactKeys(item, ["id", "version", "source", "sourceLabel", "name", "createdAt", "updatedAt"], "planning.project");
  return {
    id: uuidValue(item.id, "planning.project.id"),
    version: integerValue(item.version, "planning.project.version", 1, Number.MAX_SAFE_INTEGER),
    source: enumValue(item.source, sourceValues, "planning.project.source"),
    sourceLabel: stringValue(item.sourceLabel, "planning.project.sourceLabel", 1, 64),
    name: stringValue(item.name, "planning.project.name", 1, 500),
    createdAt: timestampValue(item.createdAt, "planning.project.createdAt"),
    updatedAt: timestampValue(item.updatedAt, "planning.project.updatedAt")
  };
}

function parseEnvelope<T>(
  value: unknown,
  domain: PlanningReadEnvelope<T>["domain"],
  parseItem: (value: unknown) => T
): PlanningReadEnvelope<T> {
  const envelope = record(value, "planning read envelope");
  exactKeys(
    envelope,
    ["schemaVersion", "kind", "domain", "generatedAt", "sourceStatus", "lastSyncedAt", "staleAfter", "items", "limit", "offset", "count", "hasMore"],
    "planning read envelope"
  );
  if (envelope.schemaVersion !== "planning.panel.v1" || envelope.kind !== "list" || envelope.domain !== domain) {
    throw new PlanningReadError("planning read envelope schema is invalid", "contract");
  }
  const items = envelope.items;
  if (!Array.isArray(items) || items.length > 100) throw new PlanningReadError("planning read items are invalid", "contract");
  const parsedItems = items.map(parseItem);
  const result = {
    schemaVersion: "planning.panel.v1" as const,
    kind: "list" as const,
    domain,
    generatedAt: timestampValue(envelope.generatedAt, "planning.generatedAt"),
    sourceStatus: enumValue(envelope.sourceStatus, sourceStatusValues, "planning.sourceStatus"),
    lastSyncedAt: nullableTimestamp(envelope.lastSyncedAt, "planning.lastSyncedAt"),
    staleAfter: nullableTimestamp(envelope.staleAfter, "planning.staleAfter"),
    items: parsedItems,
    limit: integerValue(envelope.limit, "planning.limit", 1, 100),
    offset: integerValue(envelope.offset, "planning.offset", 0, 10_000),
    count: integerValue(envelope.count, "planning.count", 0, 100),
    hasMore: booleanValue(envelope.hasMore, "planning.hasMore")
  };
  if (result.count !== result.items.length) throw new PlanningReadError("planning count does not match items", "contract");
  return result;
}

async function getRead<T>(
  path: "/api/v1/planning/reminders/view" | "/api/v1/planning/tasks" | "/api/v1/planning/events" | "/api/v1/planning/projects",
  params: URLSearchParams,
  domain: PlanningReadEnvelope<T>["domain"],
  parseItem: (value: unknown) => T,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${path}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      signal
    });
  } catch (reason) {
    if (signal?.aborted) throw new PlanningReadError("Planning read aborted", "aborted");
    throw new PlanningReadError(reason instanceof Error ? reason.message : "Planning read unavailable", "network");
  }
  if (!response.ok) {
    throw new PlanningReadError("Planning route is unavailable", "http", response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PlanningReadError("Planning response is malformed", "malformed", response.status);
  }
  try {
    return parseEnvelope(payload, domain, parseItem);
  } catch (reason) {
    if (reason instanceof PlanningReadError) throw reason;
    throw new PlanningReadError("Planning response contract is invalid", "contract", response.status);
  }
}

function boundedPage(limit = planningRouteLimit, offset = 0): URLSearchParams {
  const safeLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : planningRouteLimit;
  const safeOffset = Number.isInteger(offset) ? Math.min(10_000, Math.max(0, offset)) : 0;
  return new URLSearchParams({ limit: String(safeLimit), offset: String(safeOffset) });
}

export function readPlanningTasks(
  view: TaskRouteView,
  projectId: string | null,
  limit = planningRouteLimit,
  offset = 0,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<PlanningTask>> {
  const params = boundedPage(limit, offset);
  params.set("view", view);
  if (projectId) params.set("projectId", projectId);
  return getRead("/api/v1/planning/tasks", params, "task", parseTask, signal);
}

export function readPlanningProjects(
  limit = planningRouteLimit,
  offset = 0,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<PlanningProject>> {
  return getRead("/api/v1/planning/projects", boundedPage(limit, offset), "project", parseProject, signal);
}

export function readPlanningEvents(
  fromUtc: string,
  toUtc: string,
  limit = planningRouteLimit,
  offset = 0,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<PlanningCalendarEvent>> {
  const params = boundedPage(limit, offset);
  params.set("from", fromUtc);
  params.set("to", toUtc);
  return getRead("/api/v1/planning/events", params, "calendar_event", parseCalendarEvent, signal);
}

export function readPlanningReminders(
  view: ReminderMonitorView,
  limit = planningRouteLimit,
  offset = 0,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<PlanningReminder>> {
  const params = boundedPage(limit, offset);
  params.set("view", view);
  return getRead("/api/v1/planning/reminders/view", params, "reminder", parseReminder, signal);
}

export interface PlanningReadState<T> {
  loading: boolean;
  data: PlanningReadEnvelope<T> | null;
  error: PlanningReadError | null;
}

export function usePlanningRead<T>(
  requestKey: string,
  reader: ((signal: AbortSignal) => Promise<PlanningReadEnvelope<T>>) | null,
  enabled = true
): PlanningReadState<T> {
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const [state, setState] = useState<PlanningReadState<T>>({ loading: enabled, data: null, error: null });

  useEffect(() => {
    if (!enabled || !readerRef.current) {
      setState({ loading: false, data: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState({ loading: true, data: null, error: null });
    void readerRef.current(controller.signal)
      .then((data) => {
        if (active) setState({ loading: false, data, error: null });
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof PlanningReadError && reason.code === "aborted")) return;
        setState({
          loading: false,
          data: null,
          error: reason instanceof PlanningReadError
            ? reason
            : new PlanningReadError("Planning route is unavailable", "network")
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, requestKey]);

  return state;
}

export const planningReadParsers = {
  parseReminder,
  parseTask,
  parseCalendarEvent,
  parseProject,
  parseEnvelope
};
