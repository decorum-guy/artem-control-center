import { useEffect, useRef, useState } from "react";
import type {
  PlanningCalendarEvent,
  PlanningCalendarIdentity,
  PlanningCalendarSource,
  PlanningProviderFreshnessStatus,
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
  sources?: PlanningCalendarSource[];
  items: T[];
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
}

export interface PlanningObjectEnvelope<T> {
  schemaVersion: "planning.panel.v1";
  kind: "object";
  domain: "reminder" | "task";
  object: T;
  sourceStatus: PlanningSourceStatus;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  sources?: PlanningCalendarSource[];
}

export interface PlanningEventObjectEnvelope {
  schemaVersion: "planning.panel.v1";
  kind: "object";
  domain: "calendar_event";
  object: PlanningCalendarEvent;
  sourceStatus: PlanningSourceStatus;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  sources?: PlanningCalendarSource[];
}

export interface PlanningParsePreview {
  schemaVersion: "planning.v1";
  kind: "parse_preview";
  candidate: {
    domain: "reminder" | "task" | "calendar_event";
    operation: "create" | "query";
    fields: Record<string, unknown>;
    normalized_paraphrase: string;
  } | null;
  confidence: "high" | "medium" | "low";
  ambiguities: Array<{ field: string; candidates: string[]; reason: string }>;
  requires_confirmation: boolean;
  normalized_text: string;
  error_code: string | null;
  correlation_id: string;
}

export type ReminderMonitorView = "upcoming" | "overdue" | "delivery";
export type TaskRouteView = "today" | "overdue" | "upcoming";
export type CalendarReadView = "today" | "agenda";

export interface PlanningCalendarSourcesRefresh {
  schemaVersion: "planning.calendar-sources.refresh.v1";
  kind: "calendar_sources_refresh";
  result: "success" | "failure";
  status: PlanningProviderFreshnessStatus;
  observedAt: string;
  lastSuccessfulSyncAt: string | null;
  calendarsSeen: number;
  eventsSeen: number;
  errorCode: string | null;
  correlation_id: string;
}

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

export class PlanningMutationError<T = PlanningReminder | PlanningTask> extends PlanningReadError {
  readonly mutationCode: "uncertain" | "conflict" | "disabled" | "http" | "network" | "contract";
  readonly reconciledObject: T | null;

  constructor(
    message: string,
    mutationCode: PlanningMutationError["mutationCode"],
    status: number | null = null,
    reconciledObject: T | null = null
  ) {
    super(message, mutationCode === "uncertain" ? "network" : mutationCode === "contract" ? "contract" : "http", status);
    this.name = "PlanningMutationError";
    this.mutationCode = mutationCode;
    this.reconciledObject = reconciledObject;
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
const providerFreshnessValues = new Set<PlanningProviderFreshnessStatus>([
  "current",
  "stale",
  "error",
  "not_configured",
  "disabled"
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

function nullableErrorCode(value: unknown, label: string): string | null {
  if (value === null) return null;
  const result = stringValue(value, label, 1, 128);
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(result)) {
    throw new PlanningReadError(`${label} is invalid`, "contract");
  }
  return result;
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

function canonicalIdentityValue(value: unknown, label: string, maxLength = 128): string {
  const result = stringValue(value, label, 1, maxLength);
  if (result.includes("://") || [...result].some((character) => character.charCodeAt(0) < 32)) {
    throw new PlanningReadError(`${label} is not a canonical identity`, "contract");
  }
  return result;
}

function parseCalendarIdentity(value: unknown): PlanningCalendarIdentity {
  const identity = record(value, "planning.calendar_event.calendarIdentity");
  exactKeys(identity, ["providerId", "providerLabel", "calendarId", "calendarLabel"], "planning.calendar_event.calendarIdentity");
  return {
    providerId: canonicalIdentityValue(identity.providerId, "planning.calendar_event.calendarIdentity.providerId"),
    providerLabel: stringValue(identity.providerLabel, "planning.calendar_event.calendarIdentity.providerLabel", 1, 128),
    calendarId: canonicalIdentityValue(identity.calendarId, "planning.calendar_event.calendarIdentity.calendarId"),
    calendarLabel: stringValue(identity.calendarLabel, "planning.calendar_event.calendarIdentity.calendarLabel", 1, 160)
  };
}

function parsePlanningSourceCalendar(value: unknown, index: number): PlanningCalendarSource["calendars"][number] {
  const calendar = record(value, `planning.sources[${index}].calendars[]`);
  exactKeys(
    calendar,
    ["id", "label", "color", "enabled", "status", "lastSyncedAt", "observedAt"],
    `planning.sources[${index}].calendar`
  );
  const color = calendar.color === null
    ? null
    : stringValue(calendar.color, `planning.sources[${index}].calendar.color`, 7, 9);
  if (color !== null && !/^#[0-9A-Fa-f]{6,8}$/.test(color)) {
    throw new PlanningReadError(`planning.sources[${index}].calendar.color is invalid`, "contract");
  }
  return {
    id: canonicalIdentityValue(calendar.id, `planning.sources[${index}].calendar.id`),
    label: stringValue(calendar.label, `planning.sources[${index}].calendar.label`, 1, 220),
    color,
    enabled: booleanValue(calendar.enabled, `planning.sources[${index}].calendar.enabled`),
    status: enumValue(calendar.status, providerFreshnessValues, `planning.sources[${index}].calendar.status`),
    lastSyncedAt: nullableTimestamp(calendar.lastSyncedAt, `planning.sources[${index}].calendar.lastSyncedAt`),
    observedAt: nullableTimestamp(calendar.observedAt, `planning.sources[${index}].calendar.observedAt`)
  };
}

function parsePlanningSource(value: unknown, index: number): PlanningCalendarSource {
  const source = record(value, `planning.sources[${index}]`);
  exactKeys(
    source,
    ["id", "kind", "provider", "label", "status", "configured", "lastSyncedAt", "observedAt", "calendars"],
    `planning.sources[${index}]`
  );
  if (!Array.isArray(source.calendars) || source.calendars.length > 32) {
    throw new PlanningReadError(`planning.sources[${index}].calendars is invalid`, "contract");
  }
  const kind = enumValue(source.kind, new Set<PlanningCalendarSource["kind"]>(["native", "external"]), `planning.sources[${index}].kind`);
  const provider = enumValue(source.provider, new Set<PlanningCalendarSource["provider"]>(["local", "icloud"]), `planning.sources[${index}].provider`);
  const parsed: PlanningCalendarSource = {
    id: canonicalIdentityValue(source.id, `planning.sources[${index}].id`),
    kind,
    provider,
    label: stringValue(source.label, `planning.sources[${index}].label`, 1, 128),
    status: enumValue(source.status, providerFreshnessValues, `planning.sources[${index}].status`),
    configured: booleanValue(source.configured, `planning.sources[${index}].configured`),
    lastSyncedAt: nullableTimestamp(source.lastSyncedAt, `planning.sources[${index}].lastSyncedAt`),
    observedAt: nullableTimestamp(source.observedAt, `planning.sources[${index}].observedAt`),
    calendars: source.calendars.map((calendar, calendarIndex) => parsePlanningSourceCalendar(calendar, calendarIndex))
  };
  if (parsed.kind === "native" && (parsed.id !== "native-planning" || parsed.provider !== "local" || parsed.calendars.length > 0)) {
    throw new PlanningReadError(`planning.sources[${index}] native shape is invalid`, "contract");
  }
  if (parsed.kind === "external" && parsed.provider !== "icloud") {
    throw new PlanningReadError(`planning.sources[${index}] external provider is invalid`, "contract");
  }
  return parsed;
}

export function parsePlanningSources(value: unknown): PlanningCalendarSource[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new PlanningReadError("planning.sources is invalid", "contract");
  }
  return value.map((source, index) => parsePlanningSource(source, index));
}

function optionalPlanningSources(value: Record<string, unknown>, label: string): PlanningCalendarSource[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "sources")) return undefined;
  try {
    return parsePlanningSources(value.sources);
  } catch (reason) {
    if (reason instanceof PlanningReadError) throw reason;
    throw new PlanningReadError(`${label}.sources is invalid`, "contract");
  }
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
    ["id", "version", "source", "sourceLabel", "title", "notes", "priority", "status", "dueDate", "dueTime", "timezone", "projectId", "sourceRef", "completedAt", "archivedAt", "deletedAt", "createdAt", "updatedAt"],
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
    notes: item.notes === null ? null : stringValue(item.notes, "planning.task.notes", 0, 4000),
    priority: enumValue(item.priority, priorityValues, "planning.task.priority"),
    status: enumValue(item.status, taskStatusValues, "planning.task.status"),
    dueDate,
    dueTime,
    timezone,
    projectId: nullableUuid(item.projectId, "planning.task.projectId"),
    sourceRef: item.sourceRef === null ? null : stringValue(item.sourceRef, "planning.task.sourceRef", 1, 256),
    completedAt: nullableTimestamp(item.completedAt, "planning.task.completedAt"),
    archivedAt: nullableTimestamp(item.archivedAt, "planning.task.archivedAt"),
    deletedAt: nullableTimestamp(item.deletedAt, "planning.task.deletedAt"),
    createdAt: timestampValue(item.createdAt, "planning.task.createdAt"),
    updatedAt: timestampValue(item.updatedAt, "planning.task.updatedAt")
  };
}

function parseCalendarEvent(value: unknown): PlanningCalendarEvent {
  const item = record(value, "planning.calendar_event");
  const expectedKeys = ["id", "version", "source", "sourceLabel", "title", "notes", "location", "allDay", "timezone", "syncState", "localOnlyMutable", "startAtUtc", "endAtUtc", "startDate", "endDateExclusive", "deletedAt", "createdAt", "updatedAt"];
  if ("calendarIdentity" in item) expectedKeys.push("calendarIdentity");
  exactKeys(
    item,
    expectedKeys,
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
    calendarIdentity: item.calendarIdentity === undefined || item.calendarIdentity === null
      ? item.calendarIdentity ?? undefined
      : parseCalendarIdentity(item.calendarIdentity),
    title: stringValue(item.title, "planning.calendar_event.title", 1, 500),
    notes: item.notes === null ? null : stringValue(item.notes, "planning.calendar_event.notes", 0, 4000),
    location: item.location === null ? null : stringValue(item.location, "planning.calendar_event.location", 0, 1000),
    allDay,
    timezone: timezoneValue(item.timezone, "planning.calendar_event.timezone"),
    syncState: enumValue(item.syncState, eventSyncValues, "planning.calendar_event.syncState"),
    localOnlyMutable: booleanValue(item.localOnlyMutable, "planning.calendar_event.localOnlyMutable"),
    startAtUtc,
    endAtUtc,
    startDate,
    endDateExclusive,
    deletedAt: nullableTimestamp(item.deletedAt, "planning.calendar_event.deletedAt"),
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
  const expectedKeys = ["schemaVersion", "kind", "domain", "generatedAt", "sourceStatus", "lastSyncedAt", "staleAfter", "items", "limit", "offset", "count", "hasMore"];
  if (Object.prototype.hasOwnProperty.call(envelope, "sources")) expectedKeys.push("sources");
  exactKeys(
    envelope,
    expectedKeys,
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
    sources: optionalPlanningSources(envelope, "planning read envelope"),
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
  path: "/api/v1/planning/reminders" | "/api/v1/planning/reminders/view" | "/api/v1/planning/tasks" | "/api/v1/planning/events" | "/api/v1/planning/projects",
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

export async function readPlanningTaskById(
  taskId: string,
  signal?: AbortSignal
): Promise<PlanningTask> {
  if (!uuid4Pattern.test(taskId)) throw new PlanningReadError("Task target is invalid", "contract", 422);
  let response: Response;
  try {
    response = await fetch(`/api/v1/planning/tasks/${taskId}`, {
      method: "GET",
      cache: "no-store",
      signal
    });
  } catch (reason) {
    if (signal?.aborted) throw new PlanningReadError("Planning read aborted", "aborted");
    throw new PlanningReadError(reason instanceof Error ? reason.message : "Planning read unavailable", "network");
  }
  if (!response.ok) throw new PlanningReadError("Planning task read is unavailable", "http", response.status);
  try {
    return parseTaskObjectEnvelope(await response.json()).object;
  } catch (reason) {
    if (reason instanceof PlanningReadError) throw reason;
    throw new PlanningReadError("Planning task response is invalid", "contract", response.status);
  }
}

export async function readPlanningEventById(
  eventId: string,
  signal?: AbortSignal
): Promise<PlanningCalendarEvent> {
  if (!uuid4Pattern.test(eventId)) throw new PlanningReadError("Calendar event target is invalid", "contract", 422);
  let response: Response;
  try {
    response = await fetch(`/api/v1/planning/events/${eventId}`, {
      method: "GET",
      cache: "no-store",
      signal
    });
  } catch (reason) {
    if (signal?.aborted) throw new PlanningReadError("Planning read aborted", "aborted");
    throw new PlanningReadError(reason instanceof Error ? reason.message : "Planning read unavailable", "network");
  }
  if (!response.ok) throw new PlanningReadError("Planning event read is unavailable", "http", response.status);
  try {
    return parseEventObjectEnvelope(await response.json()).object;
  } catch (reason) {
    if (reason instanceof PlanningReadError) throw reason;
    throw new PlanningReadError("Planning event response is invalid", "contract", response.status);
  }
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
  signal?: AbortSignal,
  view?: CalendarReadView
): Promise<PlanningReadEnvelope<PlanningCalendarEvent>> {
  const params = boundedPage(limit, offset);
  params.set("from", fromUtc);
  params.set("to", toUtc);
  if (view) params.set("view", view);
  return getRead("/api/v1/planning/events", params, "calendar_event", parseCalendarEvent, signal);
}

function parseCalendarSourcesRefresh(value: unknown): PlanningCalendarSourcesRefresh {
  const envelope = record(value, "planning calendar source refresh");
  exactKeys(
    envelope,
    [
      "schemaVersion",
      "kind",
      "result",
      "status",
      "observedAt",
      "lastSuccessfulSyncAt",
      "calendarsSeen",
      "eventsSeen",
      "errorCode",
      "correlation_id"
    ],
    "planning calendar source refresh"
  );
  if (envelope.schemaVersion !== "planning.calendar-sources.refresh.v1" || envelope.kind !== "calendar_sources_refresh") {
    throw new PlanningReadError("planning calendar source refresh schema is invalid", "contract");
  }
  return {
    schemaVersion: "planning.calendar-sources.refresh.v1",
    kind: "calendar_sources_refresh",
    result: enumValue(envelope.result, new Set(["success", "failure"] as const), "planning calendar source refresh.result"),
    status: enumValue(envelope.status, providerFreshnessValues, "planning calendar source refresh.status"),
    observedAt: timestampValue(envelope.observedAt, "planning calendar source refresh.observedAt"),
    lastSuccessfulSyncAt: nullableTimestamp(envelope.lastSuccessfulSyncAt, "planning calendar source refresh.lastSuccessfulSyncAt"),
    calendarsSeen: integerValue(envelope.calendarsSeen, "planning calendar source refresh.calendarsSeen", 0, 32),
    eventsSeen: integerValue(envelope.eventsSeen, "planning calendar source refresh.eventsSeen", 0, 100_000),
    errorCode: nullableErrorCode(envelope.errorCode, "planning calendar source refresh.errorCode"),
    correlation_id: uuidValue(envelope.correlation_id, "planning calendar source refresh.correlation_id")
  };
}

export async function refreshPlanningCalendarSources(
  signal?: AbortSignal,
  timeoutMs = 15_000
): Promise<PlanningCalendarSourcesRefresh> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new PlanningReadError("Calendar source refresh timeout is invalid", "contract");
  }
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch("/api/v1/planning/calendar-sources/refresh", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal
      });
    } catch (reason) {
      if (signal?.aborted) throw new PlanningReadError("Calendar source refresh aborted", "aborted");
      if (timedOut) throw new PlanningReadError("Calendar source refresh timed out", "network");
      throw new PlanningReadError(
        reason instanceof Error ? reason.message : "Calendar source refresh unavailable",
        "network"
      );
    }
    if (!response.ok) {
      throw new PlanningReadError("Calendar source refresh is unavailable", "http", response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PlanningReadError("Calendar source refresh response is malformed", "malformed", response.status);
    }
    return parseCalendarSourcesRefresh(payload);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export interface PlanningCalendarRangeEnvelope extends PlanningReadEnvelope<PlanningCalendarEvent> {
  /** Number of fixed-size GET pages used to cover the visible month grid. */
  pages: number;
}

/**
 * Read a complete visible calendar grid with a finite browser-side bound.
 * The Panel Agent already accepts 100-item pages, so a normal month is covered
 * without weakening the fixed read contract or creating an unbounded loop.
 */
export async function readPlanningEventsForRange(
  fromUtc: string,
  toUtc: string,
  signal?: AbortSignal,
  maxPages = 3
): Promise<PlanningCalendarRangeEnvelope> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) {
    throw new PlanningReadError("Calendar range page bound is invalid", "contract");
  }
  const items: PlanningCalendarEvent[] = [];
  let first: PlanningReadEnvelope<PlanningCalendarEvent> | null = null;
  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < maxPages) {
    const page = await readPlanningEvents(fromUtc, toUtc, 100, pages * 100, signal);
    first ??= page;
    items.push(...page.items);
    hasMore = page.hasMore;
    pages += 1;
  }
  if (hasMore || !first) {
    throw new PlanningReadError("Visible calendar range exceeds the bounded read limit", "contract");
  }
  return {
    ...first,
    items,
    limit: 100,
    offset: 0,
    count: items.length,
    hasMore: false,
    pages
  };
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

export type PlanningReminderMutationAction = "create" | "edit" | "complete" | "cancel";

export function newPlanningIdempotencyKey(prefix = "panel-reminder"): string {
  const randomUuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${randomUuid}`;
}

export interface PlanningReminderMutationRequest {
  action: PlanningReminderMutationAction;
  idempotencyKey: string;
  reminderId?: string;
  expectedVersion?: number;
  body: {
    title?: string;
    notes?: string | null;
    due_at_utc?: string;
    timezone?: string;
  };
  signal?: AbortSignal;
  timeoutMs?: number;
}

function parseObjectEnvelope(value: unknown): PlanningObjectEnvelope<PlanningReminder> {
  const envelope = record(value, "planning object envelope");
  const expectedKeys = ["schemaVersion", "kind", "domain", "object", "sourceStatus", "lastSyncedAt", "staleAfter"];
  if (Object.prototype.hasOwnProperty.call(envelope, "sources")) expectedKeys.push("sources");
  exactKeys(
    envelope,
    expectedKeys,
    "planning object envelope"
  );
  if (envelope.schemaVersion !== "planning.panel.v1" || envelope.kind !== "object" || envelope.domain !== "reminder") {
    throw new PlanningReadError("planning object envelope schema is invalid", "contract");
  }
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "reminder",
    object: parseReminder(envelope.object),
    sourceStatus: enumValue(envelope.sourceStatus, sourceStatusValues, "planning.object.sourceStatus"),
    lastSyncedAt: nullableTimestamp(envelope.lastSyncedAt, "planning.object.lastSyncedAt"),
    staleAfter: nullableTimestamp(envelope.staleAfter, "planning.object.staleAfter"),
    sources: optionalPlanningSources(envelope, "planning object envelope")
  };
}

function parseTaskObjectEnvelope(value: unknown): PlanningObjectEnvelope<PlanningTask> {
  const envelope = record(value, "planning task object envelope");
  const expectedKeys = ["schemaVersion", "kind", "domain", "object", "sourceStatus", "lastSyncedAt", "staleAfter"];
  if (Object.prototype.hasOwnProperty.call(envelope, "sources")) expectedKeys.push("sources");
  exactKeys(
    envelope,
    expectedKeys,
    "planning task object envelope"
  );
  if (envelope.schemaVersion !== "planning.panel.v1" || envelope.kind !== "object" || envelope.domain !== "task") {
    throw new PlanningReadError("planning task object envelope schema is invalid", "contract");
  }
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "task",
    object: parseTask(envelope.object),
    sourceStatus: enumValue(envelope.sourceStatus, sourceStatusValues, "planning.task.sourceStatus"),
    lastSyncedAt: nullableTimestamp(envelope.lastSyncedAt, "planning.task.lastSyncedAt"),
    staleAfter: nullableTimestamp(envelope.staleAfter, "planning.task.staleAfter"),
    sources: optionalPlanningSources(envelope, "planning task object envelope")
  };
}

function parseEventObjectEnvelope(value: unknown): PlanningEventObjectEnvelope {
  const envelope = record(value, "planning event object envelope");
  const expectedKeys = ["schemaVersion", "kind", "domain", "object", "sourceStatus", "lastSyncedAt", "staleAfter"];
  if (Object.prototype.hasOwnProperty.call(envelope, "sources")) expectedKeys.push("sources");
  exactKeys(
    envelope,
    expectedKeys,
    "planning event object envelope"
  );
  if (envelope.schemaVersion !== "planning.panel.v1" || envelope.kind !== "object" || envelope.domain !== "calendar_event") {
    throw new PlanningReadError("planning event object envelope schema is invalid", "contract");
  }
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "calendar_event",
    object: parseCalendarEvent(envelope.object),
    sourceStatus: enumValue(envelope.sourceStatus, sourceStatusValues, "planning.event.sourceStatus"),
    lastSyncedAt: nullableTimestamp(envelope.lastSyncedAt, "planning.event.lastSyncedAt"),
    staleAfter: nullableTimestamp(envelope.staleAfter, "planning.event.staleAfter"),
    sources: optionalPlanningSources(envelope, "planning event object envelope")
  };
}

function parseParsePreview(value: unknown): PlanningParsePreview {
  const preview = record(value, "planning parse preview");
  exactKeys(
    preview,
    ["schemaVersion", "kind", "candidate", "confidence", "ambiguities", "requires_confirmation", "normalized_text", "error_code", "correlation_id"],
    "planning parse preview"
  );
  if (preview.schemaVersion !== "planning.v1" || preview.kind !== "parse_preview") {
    throw new PlanningReadError("planning parse preview schema is invalid", "contract");
  }
  const rawAmbiguities = preview.ambiguities;
  if (!Array.isArray(rawAmbiguities) || rawAmbiguities.length > 16) throw new PlanningReadError("planning ambiguities are invalid", "contract");
  const ambiguities = rawAmbiguities.map((value) => {
    const ambiguity = record(value, "planning ambiguity");
    exactKeys(ambiguity, ["field", "candidates", "reason"], "planning ambiguity");
    if (!Array.isArray(ambiguity.candidates) || ambiguity.candidates.some((candidate) => typeof candidate !== "string")) {
      throw new PlanningReadError("planning ambiguity candidates are invalid", "contract");
    }
    return {
      field: stringValue(ambiguity.field, "planning ambiguity.field", 1, 64),
      candidates: ambiguity.candidates.map((candidate) => stringValue(candidate, "planning ambiguity.candidate", 1, 256)),
      reason: stringValue(ambiguity.reason, "planning ambiguity.reason", 1, 500)
    };
  });
  let candidate: PlanningParsePreview["candidate"] = null;
  if (preview.candidate !== null) {
    const rawCandidate = record(preview.candidate, "planning candidate");
    exactKeys(rawCandidate, ["domain", "operation", "fields", "normalized_paraphrase"], "planning candidate");
    const fields = record(rawCandidate.fields, "planning candidate.fields");
    if (!new Set(["reminder", "task", "calendar_event"]).has(String(rawCandidate.domain)) || !new Set(["create", "query"]).has(String(rawCandidate.operation))) {
      throw new PlanningReadError("planning candidate enum is invalid", "contract");
    }
    candidate = {
      domain: rawCandidate.domain as "reminder" | "task" | "calendar_event",
      operation: rawCandidate.operation as "create" | "query",
      fields,
      normalized_paraphrase: stringValue(rawCandidate.normalized_paraphrase, "planning candidate.normalized_paraphrase", 1, 2000)
    };
  }
  return {
    schemaVersion: "planning.v1",
    kind: "parse_preview",
    candidate,
    confidence: enumValue(preview.confidence, new Set(["high", "medium", "low"]), "planning confidence") as "high" | "medium" | "low",
    ambiguities,
    requires_confirmation: booleanValue(preview.requires_confirmation, "planning requires_confirmation"),
    normalized_text: stringValue(preview.normalized_text, "planning normalized_text", 0, 2000),
    error_code: preview.error_code === null ? null : stringValue(preview.error_code, "planning error_code", 1, 128),
    correlation_id: uuidValue(preview.correlation_id, "planning correlation_id")
  };
}

export async function readPlanningRemindersByState(
  state: PlanningReminder["status"],
  limit = 100,
  offset = 0,
  signal?: AbortSignal
): Promise<PlanningReadEnvelope<PlanningReminder>> {
  const params = boundedPage(limit, offset);
  params.set("state", state);
  return getRead("/api/v1/planning/reminders", params, "reminder", parseReminder, signal);
}

export async function readPlanningReminderById(
  reminderId: string,
  signal?: AbortSignal,
  attempts = 3
): Promise<PlanningReminder | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const state of ["pending", "due", "completed", "cancelled"] as const) {
      const envelope = await readPlanningRemindersByState(state, 100, 0, signal);
      const object = envelope.items.find((item) => item.id === reminderId);
      if (object) return object;
    }
    if (attempt + 1 < attempts) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

export async function previewPlanningReminder(
  text: string,
  referenceTimeUtc: string,
  timezone: string,
  signal?: AbortSignal
): Promise<PlanningParsePreview> {
  let response: Response;
  try {
    response = await fetch("/api/v1/planning/parse", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_time_utc: referenceTimeUtc, timezone, locale: "ru-RU" }),
      signal
    });
  } catch (reason) {
    if (signal?.aborted) throw new PlanningReadError("Planning parse aborted", "aborted");
    throw new PlanningReadError(reason instanceof Error ? reason.message : "Planning parse unavailable", "network");
  }
  if (!response.ok) throw new PlanningReadError("Planning parse is unavailable", "http", response.status);
  try {
    return parseParsePreview(await response.json());
  } catch (reason) {
    if (reason instanceof PlanningReadError) throw reason;
    throw new PlanningReadError("Planning parse response is invalid", "contract", response.status);
  }
}

/** Shared canonical parser preview for task create/edit; the endpoint remains one fixed read surface. */
export const previewPlanningTask = previewPlanningReminder;
/** Shared canonical parser preview for Calendar event create/edit. */
export const previewPlanningEvent = previewPlanningReminder;

function mutationPath(request: PlanningReminderMutationRequest): string {
  if (request.action === "create") return "/api/v1/planning/reminders";
  if (!request.reminderId || !uuid4Pattern.test(request.reminderId)) throw new PlanningMutationError("Reminder target is invalid", "contract", 422);
  if (request.action === "edit") return `/api/v1/planning/reminders/${request.reminderId}`;
  return `/api/v1/planning/reminders/${request.reminderId}/${request.action}`;
}

function reconciliationMatches(request: PlanningReminderMutationRequest, object: PlanningReminder): boolean {
  if (request.action === "complete") return object.status === "completed";
  if (request.action === "cancel") return object.status === "cancelled";
  if (request.action !== "edit") return false;
  if (object.version <= (request.expectedVersion ?? 0)) return false;
  return (request.body.title === undefined || request.body.title === object.title)
    && (request.body.due_at_utc === undefined || request.body.due_at_utc === object.dueAtUtc)
    && (request.body.timezone === undefined || request.body.timezone === object.timezone);
}

async function mutationFetchAttempt(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers,
      body,
      signal: controller.signal
    });
    if (signal?.aborted) throw new DOMException("Planning mutation was cancelled", "AbortError");
    return response;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function mutationResponseDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown };
    return typeof payload.detail === "string" ? payload.detail : "Planning task mutation failed";
  } catch {
    return "Planning task mutation failed";
  }
}

function mutationCodeForResponse(detail: string, status: number): PlanningMutationError["mutationCode"] {
  if (detail === "planning_mutation_uncertain") return "uncertain";
  if (status === 409 || detail === "planning_idempotency_conflict") return "conflict";
  if (status === 404) return "disabled";
  return "http";
}

async function replayCreate(
  request: PlanningReminderMutationRequest,
  path: string,
  headers: Record<string, string>,
  body: string,
  uncertain: PlanningMutationError
): Promise<never> {
  const method = "POST" as const;
  const lastUncertain = uncertain;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (request.signal?.aborted) {
      throw new PlanningMutationError("Planning mutation was cancelled", "network");
    }
    let response: Response;
    try {
      response = await mutationFetchAttempt(path, method, headers, body, request.signal, Math.min(request.timeoutMs ?? 10_000, 3_000));
    } catch {
      if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
      if (attempt + 1 < 2) continue;
      throw lastUncertain;
    }

    if (response.ok) {
      try {
        const canonical = parseObjectEnvelope(await response.json());
        throw new PlanningMutationError(
          "Create outcome confirmed by canonical replay",
          "uncertain",
          uncertain.status,
          canonical.object
        );
      } catch (reason) {
        if (reason instanceof PlanningMutationError) throw reason;
        throw new PlanningMutationError("Planning mutation response is invalid", "contract", response.status);
      }
    }

    const detail = await mutationResponseDetail(response);
    if (detail === "planning_idempotency_conflict") {
      throw new PlanningMutationError(detail, "conflict", response.status);
    }
    if (detail === "planning_idempotency_in_progress" || detail === "planning_mutation_uncertain") {
      if (attempt + 1 < 2) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
        continue;
      }
      throw lastUncertain;
    }
    throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
  }
  throw lastUncertain;
}

export async function mutatePlanningReminder(request: PlanningReminderMutationRequest): Promise<PlanningObjectEnvelope<PlanningReminder>> {
  const path = mutationPath(request);
  if (!request.idempotencyKey || request.idempotencyKey.length > 256 || [...request.idempotencyKey].some((character) => character.charCodeAt(0) < 32)) {
    throw new PlanningMutationError("Idempotency key is invalid", "contract", 422);
  }
  if (request.action !== "create" && (!Number.isInteger(request.expectedVersion) || (request.expectedVersion ?? 0) < 1)) {
    throw new PlanningMutationError("Expected reminder version is invalid", "contract", 422);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": request.idempotencyKey
  };
  if (request.action !== "create") headers["If-Match"] = String(request.expectedVersion);
  const body = JSON.stringify(request.action === "create" || request.action === "edit" ? request.body : {});
  const reconcileUncertain = async (uncertain: PlanningMutationError): Promise<never> => {
    if (request.action === "create") return replayCreate(request, path, headers, body, uncertain);
    if (request.reminderId) {
      try {
        const reconciled = await readPlanningReminderById(request.reminderId, request.signal);
        if (reconciled && reconciliationMatches(request, reconciled)) {
          throw new PlanningMutationError(
            "Mutation outcome confirmed by canonical readback",
            "uncertain",
            uncertain.status,
            reconciled
          );
        }
      } catch (reconcileReason) {
        if (reconcileReason instanceof PlanningMutationError) throw reconcileReason;
      }
    }
    throw uncertain;
  };
  try {
    const response = await mutationFetchAttempt(
      path,
      request.action === "edit" ? "PATCH" : "POST",
      headers,
      body,
      request.signal,
      request.timeoutMs ?? 10_000
    );
    if (!response.ok) {
      const detail = await mutationResponseDetail(response);
      throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
    }
    try {
      return parseObjectEnvelope(await response.json());
    } catch (reason) {
      if (reason instanceof PlanningReadError) throw new PlanningMutationError(reason.message, "contract", response.status);
      throw new PlanningMutationError("Planning mutation response is invalid", "contract", response.status);
    }
  } catch (reason) {
    if (reason instanceof PlanningMutationError) {
      if (reason.mutationCode === "uncertain") return reconcileUncertain(reason);
      throw reason;
    }
    if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
    return reconcileUncertain(new PlanningMutationError("Planning mutation outcome is uncertain", "uncertain"));
  }
}

export type PlanningTaskMutationAction = "create" | "edit" | "complete" | "archive";

export interface PlanningTaskMutationRequest {
  action: PlanningTaskMutationAction;
  idempotencyKey: string;
  taskId?: string;
  expectedVersion?: number;
  body: {
    title?: string;
    notes?: string | null;
    due_date?: string | null;
    due_time?: string | null;
    timezone?: string | null;
    priority?: PlanningTask["priority"];
    project_id?: string | null;
  };
  signal?: AbortSignal;
  timeoutMs?: number;
}

function taskMutationPath(request: PlanningTaskMutationRequest): string {
  if (request.action === "create") return "/api/v1/planning/tasks";
  if (!request.taskId || !uuid4Pattern.test(request.taskId)) {
    throw new PlanningMutationError("Task target is invalid", "contract", 422);
  }
  return `/api/v1/planning/tasks/${request.taskId}${request.action === "complete" ? "/complete" : ""}`;
}

function taskReconciliationMatches(request: PlanningTaskMutationRequest, object: PlanningTask): boolean {
  if (request.action === "complete") return object.status === "completed";
  if (request.action === "archive") return object.status === "archived";
  if (request.action !== "edit") return false;
  if (object.version <= (request.expectedVersion ?? 0)) return false;
  return (request.body.title === undefined || request.body.title === object.title)
    && (request.body.notes === undefined || request.body.notes === object.notes)
    && (request.body.due_date === undefined || request.body.due_date === object.dueDate)
    && (request.body.due_time === undefined || request.body.due_time === object.dueTime)
    && (request.body.timezone === undefined || request.body.timezone === object.timezone)
    && (request.body.priority === undefined || request.body.priority === object.priority)
    && (request.body.project_id === undefined || request.body.project_id === object.projectId);
}

async function replayTaskCreate(
  request: PlanningTaskMutationRequest,
  path: string,
  headers: Record<string, string>,
  body: string,
  uncertain: PlanningMutationError
): Promise<never> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
    let response: Response;
    try {
      response = await mutationFetchAttempt(
        path,
        "POST",
        headers,
        body,
        request.signal,
        Math.min(request.timeoutMs ?? 10_000, 3_000)
      );
    } catch {
      if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
      if (attempt + 1 < 2) continue;
      throw uncertain;
    }
    if (response.ok) {
      try {
        const canonical = parseTaskObjectEnvelope(await response.json());
        throw new PlanningMutationError(
          "Create outcome confirmed by canonical replay",
          "uncertain",
          uncertain.status,
          canonical.object
        );
      } catch (reason) {
        if (reason instanceof PlanningMutationError) throw reason;
        throw new PlanningMutationError("Planning mutation response is invalid", "contract", response.status);
      }
    }
    const detail = await mutationResponseDetail(response);
    if (detail === "planning_idempotency_conflict") {
      throw new PlanningMutationError(detail, "conflict", response.status);
    }
    if (detail === "planning_idempotency_in_progress" || detail === "planning_mutation_uncertain") {
      if (attempt + 1 < 2) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
        continue;
      }
      throw uncertain;
    }
    throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
  }
  throw uncertain;
}

export async function mutatePlanningTask(request: PlanningTaskMutationRequest): Promise<PlanningObjectEnvelope<PlanningTask>> {
  const path = taskMutationPath(request);
  if (!request.idempotencyKey || request.idempotencyKey.length > 256 || [...request.idempotencyKey].some((character) => character.charCodeAt(0) < 32)) {
    throw new PlanningMutationError("Idempotency key is invalid", "contract", 422);
  }
  if (request.action !== "create" && (!Number.isInteger(request.expectedVersion) || (request.expectedVersion ?? 0) < 1)) {
    throw new PlanningMutationError("Expected task version is invalid", "contract", 422);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": request.idempotencyKey
  };
  if (request.action !== "create") headers["If-Match"] = String(request.expectedVersion);
  const body = JSON.stringify(request.action === "create" || request.action === "edit" ? request.body : {});
  const method: "POST" | "PATCH" | "DELETE" = request.action === "edit"
    ? "PATCH"
    : request.action === "archive"
      ? "DELETE"
      : "POST";
  const reconcileUncertain = async (uncertain: PlanningMutationError): Promise<never> => {
    if (request.action === "create") return replayTaskCreate(request, path, headers, body, uncertain);
    if (request.taskId) {
      try {
        const reconciled = await readPlanningTaskById(request.taskId, request.signal);
        if (taskReconciliationMatches(request, reconciled)) {
          throw new PlanningMutationError(
            "Mutation outcome confirmed by canonical readback",
            "uncertain",
            uncertain.status,
            reconciled
          );
        }
      } catch (reconcileReason) {
        if (reconcileReason instanceof PlanningMutationError) throw reconcileReason;
      }
    }
    throw uncertain;
  };
  try {
    const response = await mutationFetchAttempt(path, method, headers, body, request.signal, request.timeoutMs ?? 10_000);
    if (!response.ok) {
      const detail = await mutationResponseDetail(response);
      throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
    }
    try {
      return parseTaskObjectEnvelope(await response.json());
    } catch (reason) {
      if (reason instanceof PlanningReadError) throw new PlanningMutationError(reason.message, "contract", response.status);
      throw new PlanningMutationError("Planning task mutation response is invalid", "contract", response.status);
    }
  } catch (reason) {
    if (reason instanceof PlanningMutationError) {
      if (reason.mutationCode === "uncertain") return reconcileUncertain(reason);
      throw reason;
    }
    if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
    return reconcileUncertain(new PlanningMutationError("Planning mutation outcome is uncertain", "uncertain"));
  }
}

export type PlanningEventMutationAction = "create" | "edit" | "delete";

export interface PlanningEventMutationRequest {
  action: PlanningEventMutationAction;
  idempotencyKey: string;
  eventId?: string;
  expectedVersion?: number;
  body: {
    title?: string;
    notes?: string | null;
    location?: string | null;
    all_day?: boolean;
    timezone?: string;
    start_at_utc?: string | null;
    end_at_utc?: string | null;
    start_date?: string | null;
    end_date_exclusive?: string | null;
  };
  signal?: AbortSignal;
  timeoutMs?: number;
}

function eventMutationPath(request: PlanningEventMutationRequest): string {
  if (request.action === "create") return "/api/v1/planning/events";
  if (!request.eventId || !uuid4Pattern.test(request.eventId)) {
    throw new PlanningMutationError("Calendar event target is invalid", "contract", 422);
  }
  return `/api/v1/planning/events/${request.eventId}`;
}

function eventReconciliationMatches(request: PlanningEventMutationRequest, object: PlanningCalendarEvent): boolean {
  if (request.action === "delete") return Boolean(object.deletedAt) && object.version > (request.expectedVersion ?? 0);
  if (request.action !== "edit" || object.version <= (request.expectedVersion ?? 0)) return false;
  return (request.body.title === undefined || request.body.title === object.title)
    && (request.body.all_day === undefined || request.body.all_day === object.allDay)
    && (request.body.timezone === undefined || request.body.timezone === object.timezone)
    && (request.body.start_at_utc === undefined || request.body.start_at_utc === object.startAtUtc)
    && (request.body.end_at_utc === undefined || request.body.end_at_utc === object.endAtUtc)
    && (request.body.start_date === undefined || request.body.start_date === object.startDate)
    && (request.body.end_date_exclusive === undefined || request.body.end_date_exclusive === object.endDateExclusive)
    && (request.body.notes === undefined || request.body.notes === object.notes)
    && (request.body.location === undefined || request.body.location === object.location);
}

async function replayEventCreate(
  request: PlanningEventMutationRequest,
  path: string,
  headers: Record<string, string>,
  body: string,
  uncertain: PlanningMutationError
): Promise<never> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
    let response: Response;
    try {
      response = await mutationFetchAttempt(path, "POST", headers, body, request.signal, Math.min(request.timeoutMs ?? 10_000, 3_000));
    } catch {
      if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
      if (attempt + 1 < 2) continue;
      throw uncertain;
    }
    if (response.ok) {
      try {
        const canonical = parseEventObjectEnvelope(await response.json());
        throw new PlanningMutationError<PlanningCalendarEvent>("Create outcome confirmed by canonical replay", "uncertain", uncertain.status, canonical.object);
      } catch (reason) {
        if (reason instanceof PlanningMutationError) throw reason;
        throw new PlanningMutationError("Planning mutation response is invalid", "contract", response.status);
      }
    }
    const detail = await mutationResponseDetail(response);
    if (detail === "planning_idempotency_conflict") throw new PlanningMutationError(detail, "conflict", response.status);
    if (detail === "planning_idempotency_in_progress" || detail === "planning_mutation_uncertain") {
      if (attempt + 1 < 2) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
        continue;
      }
      throw uncertain;
    }
    throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
  }
  throw uncertain;
}

export async function mutatePlanningEvent(request: PlanningEventMutationRequest): Promise<PlanningEventObjectEnvelope> {
  const path = eventMutationPath(request);
  if (!request.idempotencyKey || request.idempotencyKey.length > 256 || [...request.idempotencyKey].some((character) => character.charCodeAt(0) < 32)) {
    throw new PlanningMutationError("Idempotency key is invalid", "contract", 422);
  }
  if (request.action !== "create" && (!Number.isInteger(request.expectedVersion) || (request.expectedVersion ?? 0) < 1)) {
    throw new PlanningMutationError("Expected calendar event version is invalid", "contract", 422);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": request.idempotencyKey
  };
  if (request.action !== "create") headers["If-Match"] = String(request.expectedVersion);
  const body = JSON.stringify(request.action === "delete" ? {} : request.body);
  const method: "POST" | "PATCH" | "DELETE" = request.action === "create"
    ? "POST"
    : request.action === "edit" ? "PATCH" : "DELETE";
  const reconcileUncertain = async (uncertain: PlanningMutationError): Promise<never> => {
    if (request.action === "create") return replayEventCreate(request, path, headers, body, uncertain);
    if (request.eventId) {
      try {
        const reconciled = await readPlanningEventById(request.eventId, request.signal);
        if (eventReconciliationMatches(request, reconciled)) {
          throw new PlanningMutationError<PlanningCalendarEvent>("Mutation outcome confirmed by canonical readback", "uncertain", uncertain.status, reconciled);
        }
      } catch (reconcileReason) {
        if (reconcileReason instanceof PlanningMutationError) throw reconcileReason;
      }
    }
    throw uncertain;
  };
  try {
    const response = await mutationFetchAttempt(path, method, headers, body, request.signal, request.timeoutMs ?? 10_000);
    if (!response.ok) {
      const detail = await mutationResponseDetail(response);
      throw new PlanningMutationError(detail, mutationCodeForResponse(detail, response.status), response.status);
    }
    try {
      return parseEventObjectEnvelope(await response.json());
    } catch (reason) {
      if (reason instanceof PlanningReadError) throw new PlanningMutationError(reason.message, "contract", response.status);
      throw new PlanningMutationError("Planning event mutation response is invalid", "contract", response.status);
    }
  } catch (reason) {
    if (reason instanceof PlanningMutationError) {
      if (reason.mutationCode === "uncertain") return reconcileUncertain(reason);
      throw reason;
    }
    if (request.signal?.aborted) throw new PlanningMutationError("Planning mutation was cancelled", "network");
    return reconcileUncertain(new PlanningMutationError("Planning mutation outcome is uncertain", "uncertain"));
  }
}

export interface PlanningReadState<T> {
  loading: boolean;
  refreshing: boolean;
  data: PlanningReadEnvelope<T> | null;
  error: PlanningReadError | null;
}

interface PlanningReadInternalState<T> extends PlanningReadState<T> {
  queryKey: string;
  refreshKey: string;
}

export interface UsePlanningReadOptions<T> {
  /** Logical data identity. Changing this must never expose the previous query's rows. */
  queryKey: string;
  /** Re-read trigger for the same logical query (snapshot revision, retry, mutation readback). */
  refreshKey: string;
  reader: ((signal: AbortSignal) => Promise<PlanningReadEnvelope<T>>) | null;
  enabled?: boolean;
}

export function usePlanningRead<T>(
  { queryKey, refreshKey, reader, enabled = true }: UsePlanningReadOptions<T>
): PlanningReadState<T> {
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const generationRef = useRef(0);
  const [state, setState] = useState<PlanningReadInternalState<T>>({
    queryKey,
    refreshKey,
    loading: enabled,
    refreshing: false,
    data: null,
    error: null
  });

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!enabled || !readerRef.current) {
      setState({ queryKey, refreshKey, loading: false, refreshing: false, data: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    const activeReader = readerRef.current;
    setState((previous) => {
      const sameQuery = previous.queryKey === queryKey;
      const hasData = sameQuery && previous.data !== null;
      return {
        queryKey,
        refreshKey,
        loading: !hasData,
        refreshing: hasData,
        data: sameQuery ? previous.data : null,
        error: null
      };
    });
    void activeReader(controller.signal)
      .then((data) => {
        setState((previous) => {
          if (generationRef.current !== generation || previous.queryKey !== queryKey) return previous;
          return { queryKey, refreshKey, loading: false, refreshing: false, data, error: null };
        });
      })
      .catch((reason: unknown) => {
        if (generationRef.current !== generation || controller.signal.aborted || (reason instanceof PlanningReadError && reason.code === "aborted")) return;
        setState((previous) => {
          if (previous.queryKey !== queryKey) return previous;
          const error = reason instanceof PlanningReadError
            ? reason
            : new PlanningReadError("Planning route is unavailable", "network");
          return {
            queryKey,
            refreshKey,
            loading: false,
            refreshing: false,
            data: previous.data,
            error
          };
        });
      });
    return () => {
      controller.abort();
    };
  }, [enabled, queryKey, refreshKey]);

  if (!enabled || state.queryKey !== queryKey) {
    return { loading: enabled, refreshing: false, data: null, error: null };
  }
  if (state.refreshKey !== refreshKey) {
    const hasData = state.data !== null;
    return { loading: !hasData, refreshing: hasData, data: hasData ? state.data : null, error: null };
  }
  return {
    loading: state.loading,
    refreshing: state.refreshing,
    data: state.data,
    error: state.error
  };
}

export const planningReadParsers = {
  parseReminder,
  parseTask,
  parseCalendarEvent,
  parseProject,
  parsePlanningSources,
  parseEnvelope,
  parseObjectEnvelope,
  parseTaskObjectEnvelope,
  parseEventObjectEnvelope,
  parseParsePreview
};
