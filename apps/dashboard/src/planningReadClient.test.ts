import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mutatePlanningEvent,
  mutatePlanningReminder,
  mutatePlanningTask,
  PlanningMutationError,
  PlanningReadError,
  planningReadParsers,
  previewPlanningReminder,
  refreshPlanningCalendarSources,
  readPlanningEvents,
  readPlanningEventsForRange,
  readPlanningTaskById,
  readPlanningTasks
} from "./planningReadClient";

const task = {
  id: "00000000-0000-4000-8000-000000000501",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Задача из route API",
  notes: null,
  priority: "high",
  status: "open",
  dueDate: "2026-08-12",
  dueTime: null,
  timezone: null,
  projectId: null,
  sourceRef: null,
  completedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const calendarEvent = {
  id: "00000000-0000-4000-8000-000000000601",
  version: 2,
  source: "panel-agent",
  sourceLabel: "Panel Agent",
  calendarIdentity: {
    providerId: "local-planning",
    providerLabel: "Local Planning",
    calendarId: "local",
    calendarLabel: "Локальный"
  },
  title: "Встреча",
  notes: "Контекст",
  location: "Переговорная",
  allDay: false,
  timezone: "Europe/Moscow",
  syncState: "local_only",
  localOnlyMutable: true,
  startAtUtc: "2026-08-12T10:00:00Z",
  endAtUtc: "2026-08-12T11:00:00Z",
  startDate: null,
  endDateExclusive: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:01:00Z"
};

function eventObjectEnvelope(object: Record<string, unknown> = calendarEvent) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "calendar_event",
    object,
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:01:00Z",
    staleAfter: "2026-08-12T09:06:00Z"
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain: "task",
    generatedAt: "2026-08-12T09:00:00Z",
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z",
    items: [task],
    limit: 20,
    offset: 0,
    count: 1,
    hasMore: false,
    ...overrides
  };
}

const phaseBSource = {
  id: "external-icloud-0123456789abcdef01234567",
  kind: "external",
  provider: "icloud",
  label: "iCloud",
  status: "current",
  configured: true,
  lastSyncedAt: "2026-08-12T09:00:00Z",
  observedAt: "2026-08-12T09:01:00Z",
  calendars: [
    {
      id: "calendar-0123456789abcdef01234567",
      label: "Работа",
      color: "#4477AA",
      enabled: true,
      status: "current",
      lastSyncedAt: "2026-08-12T09:00:00Z",
      observedAt: "2026-08-12T09:01:00Z"
    }
  ]
} as const;

const nativePhaseBSource = {
  id: "native-planning",
  kind: "native",
  provider: "local",
  label: "Local Planning",
  status: "current",
  configured: true,
  lastSyncedAt: "2026-08-12T09:00:00Z",
  observedAt: "2026-08-12T09:01:00Z",
  calendars: []
} as const;

afterEach(() => vi.restoreAllMocks());

describe("fixed Planning read client", () => {
  it("forwards the real Calendar view alongside the bounded UTC range", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ...envelope({ domain: "calendar_event", items: [calendarEvent] }),
      sources: [nativePhaseBSource]
    }), { status: 200 }));

    await readPlanningEvents(
      "2026-08-24T21:00:00Z",
      "2026-08-25T21:00:00Z",
      20,
      0,
      undefined,
      "today"
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/v1/planning/events?limit=20&offset=0&from=2026-08-24T21%3A00%3A00Z&to=2026-08-25T21%3A00%3A00Z&view=today"
    );
  });

  it("covers a visible month with bounded 100-item GET pages and merges canonical metadata", async () => {
    const second = { ...calendarEvent, id: "00000000-0000-4000-8000-000000000602", title: "Вторая встреча" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const offset = new URL(String(input), "http://localhost").searchParams.get("offset");
      const items = offset === "0" ? [calendarEvent] : [second];
      return new Response(JSON.stringify({
        ...envelope({ domain: "calendar_event", items, limit: 100, offset: Number(offset), count: items.length, hasMore: offset === "0", sources: [nativePhaseBSource] })
      }), { status: 200 });
    });

    const result = await readPlanningEventsForRange("2026-07-26T21:00:00Z", "2026-09-06T21:00:00Z");
    expect(result.items.map((item) => item.id)).toEqual([calendarEvent.id, second.id]);
    expect(result).toMatchObject({ pages: 2, count: 2, hasMore: false, sources: [nativePhaseBSource] });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("fails closed when a visible range exceeds the three-page safety bound", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      ...envelope({ domain: "calendar_event", items: [calendarEvent], limit: 100, count: 1, hasMore: true })
    }), { status: 200 }));
    await expect(readPlanningEventsForRange("2026-07-26T21:00:00Z", "2026-09-06T21:00:00Z"))
      .rejects.toMatchObject({ code: "contract" });
  });

  it("keeps old Alice envelopes without sources compatible and accepts strict new sources", () => {
    expect(planningReadParsers.parseEnvelope(envelope(), "task", (value) => value).sources).toBeUndefined();
    const parsed = planningReadParsers.parseEnvelope(
      envelope({
        domain: "calendar_event",
        items: [calendarEvent],
        sources: [nativePhaseBSource, phaseBSource]
      }),
      "calendar_event",
      (value) => value
    );
    expect(parsed.sources).toEqual([nativePhaseBSource, phaseBSource]);
  });

  it("rejects an explicit null sources value instead of weakening the contract", () => {
    expect(() => planningReadParsers.parseEnvelope(
      envelope({ sources: null }),
      "task",
      (value) => value
    )).toThrowError(PlanningReadError);
  });

  it("parses source metadata on object responses without exposing upstream identity fields", () => {
    const sources = [nativePhaseBSource, phaseBSource];
    const parsed = planningReadParsers.parseObjectEnvelope({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "reminder",
      object: {
        id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        source: "alice",
        sourceLabel: "AliceTG Bot",
        title: "Напоминание",
        dueAtUtc: "2026-08-13T12:00:00Z",
        timezone: "Europe/Moscow",
        status: "pending",
        deliveryState: "not_due",
        createdAt: "2026-08-12T09:00:00Z",
        updatedAt: "2026-08-12T09:00:00Z"
      },
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:00:00Z",
      staleAfter: "2026-08-12T09:05:00Z",
      sources
    });
    expect(parsed.sources?.[1]).toEqual(phaseBSource);

    const taskReadback = planningReadParsers.parseTaskObjectEnvelope({
      ...eventObjectEnvelope(task),
      domain: "task",
      object: task,
      sources
    });
    expect(taskReadback.sources?.[1].provider).toBe("icloud");

    const eventReadback = planningReadParsers.parseEventObjectEnvelope({
      ...eventObjectEnvelope(),
      sources
    });
    expect(eventReadback.sources?.[1].calendars[0].label).toBe("Работа");

    expect(JSON.stringify(parsed)).not.toContain("accountId");
    expect(JSON.stringify(parsed)).not.toContain("resource_ref");
    expect(JSON.stringify(parsed)).not.toContain("href");
  });

  it("fails closed on malformed source metadata and bounds its lists", () => {
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, kind: "provider" }])).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, status: "offline" }])).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, observedAt: "2026-08-12T09:00:00+03:00" }])).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, accountId: "private" }])).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, calendars: [{ ...phaseBSource.calendars[0], href: "/private" }] }])).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources(Array.from({ length: 5 }, () => nativePhaseBSource))).toThrowError(PlanningReadError);
    expect(() => planningReadParsers.parsePlanningSources([{ ...phaseBSource, calendars: Array.from({ length: 33 }, () => phaseBSource.calendars[0]) }])).toThrowError(PlanningReadError);
  });

  it("accepts stale, error, disabled and not-configured source states", () => {
    for (const status of ["stale", "error", "disabled", "not_configured"] as const) {
      const parsed = planningReadParsers.parsePlanningSources([{
        ...phaseBSource,
        status,
        calendars: [{ ...phaseBSource.calendars[0], status }]
      }]);
      expect(parsed[0].status).toBe(status);
    }
  });

  it("accepts only bounded frontend-safe calendar identity fields", () => {
    const event = planningReadParsers.parseCalendarEvent({
      id: "00000000-0000-4000-8000-000000000601",
      version: 1,
      source: "calendar-provider",
      sourceLabel: "Calendar provider",
      calendarIdentity: {
        providerId: "calendar-provider",
        providerLabel: "Calendar provider",
        calendarId: "work",
        calendarLabel: "Рабочий"
      },
      title: "Совещание",
      notes: null,
      location: null,
      allDay: false,
      timezone: "Europe/Moscow",
      syncState: "synced",
      localOnlyMutable: false,
      startAtUtc: "2026-08-12T10:00:00Z",
      endAtUtc: "2026-08-12T11:00:00Z",
      startDate: null,
      endDateExclusive: null,
      deletedAt: null,
      createdAt: "2026-08-12T09:00:00Z",
      updatedAt: "2026-08-12T09:00:00Z"
    });
    expect(event.calendarIdentity).toEqual(expect.objectContaining({ calendarId: "work", calendarLabel: "Рабочий" }));
    expect(() => planningReadParsers.parseCalendarEvent({
      ...event,
      calendarIdentity: { ...event.calendarIdentity, calendarId: "https://secret.example" }
    })).toThrowError(PlanningReadError);
  });

  it("parses canonical reminder object readback and parser ambiguities", () => {
    const object = planningReadParsers.parseObjectEnvelope({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "reminder",
      object: {
        id: "00000000-0000-4000-8000-000000000001",
        version: 2,
        source: "panel-agent",
        sourceLabel: "Panel Agent",
        title: "Обновлённое напоминание",
        dueAtUtc: "2026-08-13T12:00:00Z",
        timezone: "Europe/Moscow",
        status: "due",
        deliveryState: "delivered",
        createdAt: "2026-08-12T09:00:00Z",
        updatedAt: "2026-08-12T09:01:00Z"
      },
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:01:00Z",
      staleAfter: "2026-08-12T09:06:00Z"
    });
    expect(object.object.status).toBe("due");
    expect(object.object.deliveryState).toBe("delivered");
    const preview = planningReadParsers.parseParsePreview({
      schemaVersion: "planning.v1",
      kind: "parse_preview",
      candidate: null,
      confidence: "medium",
      ambiguities: [{ field: "time", candidates: ["точное время"], reason: "Вечером нельзя угадать." }],
      requires_confirmation: true,
      normalized_text: "завтра вечером напомни проверить",
      error_code: null,
      correlation_id: "00000000-0000-4000-8000-000000000099"
    });
    expect(preview.requires_confirmation).toBe(true);
    expect(preview.ambiguities[0].field).toBe("time");
  });

  it("uses a fixed mutation path, idempotency key and If-Match", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "reminder",
      object: {
        id: "00000000-0000-4000-8000-000000000001",
        version: 2,
        source: "panel-agent",
        sourceLabel: "Panel Agent",
        title: "Обновлённое напоминание",
        dueAtUtc: "2026-08-13T12:00:00Z",
        timezone: "Europe/Moscow",
        status: "due",
        deliveryState: "delivered",
        createdAt: "2026-08-12T09:00:00Z",
        updatedAt: "2026-08-12T09:01:00Z"
      },
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:01:00Z",
      staleAfter: "2026-08-12T09:06:00Z"
    }), { status: 200 }));
    const result = await mutatePlanningReminder({
      action: "edit",
      idempotencyKey: "b4-edit-001",
      reminderId: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
      body: { title: "Обновлённое напоминание", due_at_utc: "2026-08-13T12:00:00Z", timezone: "Europe/Moscow" },
      timeoutMs: 1000
    });
    expect(result.object.title).toBe("Обновлённое напоминание");
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe("/api/v1/planning/reminders/00000000-0000-4000-8000-000000000001");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "b4-edit-001", "If-Match": "1" });
  });

  it("uses fixed task create/edit routes and preserves date-only versus timed fields", async () => {
    const dateOnlyObject = {
      ...task,
      source: "panel-agent",
      notes: "Купить без времени",
      sourceRef: "panel:test",
      completedAt: null,
      archivedAt: null,
      deletedAt: null
    };
    const timedObject = { ...dateOnlyObject, dueDate: "2026-08-14", dueTime: "18:30", timezone: "Europe/Moscow", version: 2 };
    const response = (object: object) => new Response(JSON.stringify({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "task",
      object,
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:00:00Z",
      staleAfter: "2026-08-12T09:05:00Z"
    }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(dateOnlyObject))
      .mockResolvedValueOnce(response(timedObject));

    const created = await mutatePlanningTask({
      action: "create",
      idempotencyKey: "task-create-001",
      body: { title: "Купить без времени", priority: "normal", due_date: "2026-08-14", due_time: null, timezone: null }
    });
    const edited = await mutatePlanningTask({
      action: "edit",
      idempotencyKey: "task-edit-001",
      taskId: task.id,
      expectedVersion: 1,
      body: { due_date: "2026-08-14", due_time: "18:30", timezone: "Europe/Moscow" }
    });
    expect(created.object.dueTime).toBeNull();
    expect(created.object.timezone).toBeNull();
    expect(edited.object.dueTime).toBe("18:30");
    expect(edited.object.timezone).toBe("Europe/Moscow");
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/planning/tasks");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ title: "Купить без времени", priority: "normal", due_date: "2026-08-14", due_time: null, timezone: null }) });
    expect(String(fetchMock.mock.calls[1][0])).toBe(`/api/v1/planning/tasks/${task.id}`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ "Idempotency-Key": "task-edit-001", "If-Match": "1" });
  });

  it("reconciles complete and archive uncertainty by canonical task ID, including terminal states", async () => {
    const completed = { ...task, status: "completed", version: 2, completedAt: "2026-08-12T09:01:00Z" };
    const archived = { ...task, status: "archived", version: 2, archivedAt: "2026-08-12T09:01:00Z", deletedAt: "2026-08-12T09:01:00Z" };
    const objectResponse = (object: object) => new Response(JSON.stringify({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "task",
      object,
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:01:00Z",
      staleAfter: "2026-08-12T09:06:00Z"
    }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("complete response lost"))
      .mockResolvedValueOnce(objectResponse(completed))
      .mockRejectedValueOnce(new Error("archive response lost"))
      .mockResolvedValueOnce(objectResponse(archived));
    for (const [action, expected] of [["complete", completed], ["archive", archived]] as const) {
      try {
        await mutatePlanningTask({
          action,
          idempotencyKey: `task-${action}-uncertain`,
          taskId: task.id,
          expectedVersion: 1,
          body: {}
        });
        throw new Error("expected uncertain reconciliation");
      } catch (error) {
        expect(error).toBeInstanceOf(PlanningMutationError);
        expect((error as PlanningMutationError).mutationCode).toBe("uncertain");
        expect((error as PlanningMutationError).reconciledObject?.status).toBe(expected.status);
      }
    }
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/v1/planning/tasks/${task.id}/complete`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(String(fetchMock.mock.calls[2][0])).toBe(`/api/v1/planning/tasks/${task.id}`);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });

  it("replays uncertain task create with the exact body and key", async () => {
    const body = { title: "Купить продукты", priority: "normal" as const, due_date: "2026-08-14", due_time: null, timezone: null };
    const canonical = {
      ...task,
      title: body.title,
      dueDate: body.due_date,
      dueTime: null,
      timezone: null
    };
    const response = new Response(JSON.stringify({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "task",
      object: canonical,
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:00:00Z",
      staleAfter: "2026-08-12T09:05:00Z"
    }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce(response);
    try {
      await mutatePlanningTask({ action: "create", idempotencyKey: "task-create-replay", body });
      throw new Error("expected uncertain replay result");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningMutationError);
      expect((error as PlanningMutationError).mutationCode).toBe("uncertain");
      expect((error as PlanningMutationError).reconciledObject?.title).toBe(body.title);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/planning/tasks");
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/v1/planning/tasks");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("task-create-replay");
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("task-create-replay");
  });

  it("reads task by fixed ID without mutation headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "task",
      object: task,
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:00:00Z",
      staleAfter: "2026-08-12T09:05:00Z"
    }), { status: 200 }));
    await expect(readPlanningTaskById(task.id)).resolves.toMatchObject({ id: task.id, dueTime: null, timezone: null });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/v1/planning/tasks/${task.id}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("reconciles a transport timeout against canonical readback without success notice semantics", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return new Response(JSON.stringify({
        schemaVersion: "planning.panel.v1",
        kind: "list",
        domain: "reminder",
        generatedAt: "2026-08-12T09:01:00Z",
        sourceStatus: "current",
        lastSyncedAt: "2026-08-12T09:01:00Z",
        staleAfter: "2026-08-12T09:06:00Z",
        items: [{
          id: "00000000-0000-4000-8000-000000000001",
          version: 2,
          source: "panel-agent",
          sourceLabel: "Panel Agent",
          title: "Канонический readback",
          dueAtUtc: "2026-08-13T12:00:00Z",
          timezone: "Europe/Moscow",
          status: "completed",
          deliveryState: "delivered",
          createdAt: "2026-08-12T09:00:00Z",
          updatedAt: "2026-08-12T09:01:00Z"
        }],
        limit: 100,
        offset: 0,
        count: 1,
        hasMore: false
      }), { status: 200 });
    });
    try {
      await mutatePlanningReminder({
        action: "complete",
        idempotencyKey: "b4-complete-uncertain",
        reminderId: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
        body: {},
        timeoutMs: 1000
      });
      throw new Error("expected an uncertain mutation result");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningMutationError);
      expect((error as PlanningMutationError).mutationCode).toBe("uncertain");
      expect((error as PlanningMutationError).reconciledObject?.title).toBe("Канонический readback");
    }
  });

  it("replays an uncertain create with the exact same key and body, without green success semantics", async () => {
    const body = {
      title: "Позвонить врачу",
      due_at_utc: "2026-08-13T12:00:00Z",
      timezone: "Europe/Moscow"
    };
    const canonical = {
      schemaVersion: "planning.panel.v1",
      kind: "object",
      domain: "reminder",
      object: {
        id: "00000000-0000-4000-8000-000000000099",
        version: 1,
        source: "alice",
        sourceLabel: "AliceTG Bot",
        title: body.title,
        dueAtUtc: body.due_at_utc,
        timezone: body.timezone,
        status: "pending",
        deliveryState: "not_due",
        createdAt: "2026-08-12T09:01:00Z",
        updatedAt: "2026-08-12T09:01:00Z"
      },
      sourceStatus: "current",
      lastSyncedAt: "2026-08-12T09:01:00Z",
      staleAfter: "2026-08-12T09:06:00Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost after canonical commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));

    try {
      await mutatePlanningReminder({
        action: "create",
        idempotencyKey: "b4-create-replay-001",
        body,
        timeoutMs: 1000
      });
      throw new Error("expected an uncertain reconciled result");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningMutationError);
      expect((error as PlanningMutationError).mutationCode).toBe("uncertain");
      expect((error as PlanningMutationError).reconciledObject?.id).toBe("00000000-0000-4000-8000-000000000099");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0];
    const replay = fetchMock.mock.calls[1];
    expect(String(first[0])).toBe("/api/v1/planning/reminders");
    expect(String(replay[0])).toBe(String(first[0]));
    expect(first[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(replay[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(first[1]?.signal).not.toBe(replay[1]?.signal);
    expect((first[1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("b4-create-replay-001");
    expect((replay[1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("b4-create-replay-001");
  });

  it("keeps a create uncertain when canonical idempotency replay remains in progress", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "planning_idempotency_in_progress" }), { status: 409 }))
      .mockRejectedValueOnce(new Error("replay still unavailable"));

    await expect(mutatePlanningReminder({
      action: "create",
      idempotencyKey: "b4-create-in-progress-001",
      body: { title: "Проверить статус", due_at_utc: "2026-08-13T12:00:00Z", timezone: "Europe/Moscow" },
      timeoutMs: 1000
    })).rejects.toMatchObject({ mutationCode: "uncertain", reconciledObject: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["b4-create-in-progress-001", "b4-create-in-progress-001", "b4-create-in-progress-001"]);
  });

  it("relays parser preview without exposing a browser secret", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "planning.v1",
      kind: "parse_preview",
      candidate: null,
      confidence: "medium",
      ambiguities: [{ field: "time", candidates: ["точное время"], reason: "Вечером нельзя угадать." }],
      requires_confirmation: true,
      normalized_text: "завтра вечером напомни проверить",
      error_code: null,
      correlation_id: "00000000-0000-4000-8000-000000000099"
    }), { status: 200 }));
    const result = await previewPlanningReminder("завтра вечером напомни проверить", "2026-08-12T09:00:00Z", "Europe/Moscow");
    expect(result.requires_confirmation).toBe(true);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers.Authorization");
  });

  it("uses a fixed same-origin GET path with safely encoded bounded query values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(envelope()), { status: 200 }));
    const result = await readPlanningTasks("today", "00000000-0000-4000-8000-000000000601", 20, 20);
    expect(result.items[0].title).toBe("Задача из route API");
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe("/api/v1/planning/tasks?limit=20&offset=20&view=today&projectId=00000000-0000-4000-8000-000000000601");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(init).not.toHaveProperty("headers");
  });

  it("uses fixed Calendar create/edit/delete routes and preserves canonical shapes", async () => {
    const created = { ...calendarEvent, version: 1 };
    const edited = { ...calendarEvent, title: "Новая встреча", version: 2 };
    const deleted = { ...edited, deletedAt: "2026-08-12T09:02:00Z", version: 3 };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(eventObjectEnvelope(created)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(eventObjectEnvelope(edited)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(eventObjectEnvelope(deleted)), { status: 200 }));

    await mutatePlanningEvent({
      action: "create",
      idempotencyKey: "calendar-create-001",
      body: {
        title: "Встреча",
        all_day: false,
        timezone: "Europe/Moscow",
        start_at_utc: "2026-08-12T10:00:00Z",
        end_at_utc: "2026-08-12T11:00:00Z",
        start_date: null,
        end_date_exclusive: null
      }
    });
    await mutatePlanningEvent({
      action: "edit",
      idempotencyKey: "calendar-edit-001",
      eventId: calendarEvent.id,
      expectedVersion: 1,
      body: { title: "Новая встреча", all_day: false, timezone: "Europe/Moscow", start_at_utc: calendarEvent.startAtUtc, end_at_utc: calendarEvent.endAtUtc, start_date: null, end_date_exclusive: null }
    });
    await mutatePlanningEvent({
      action: "delete",
      idempotencyKey: "calendar-delete-001",
      eventId: calendarEvent.id,
      expectedVersion: 2,
      body: {}
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/planning/events",
      `/api/v1/planning/events/${calendarEvent.id}`,
      `/api/v1/planning/events/${calendarEvent.id}`
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE", body: "{}" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ "Idempotency-Key": "calendar-edit-001", "If-Match": "1" });
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ "Idempotency-Key": "calendar-delete-001", "If-Match": "2" });
  });

  it("replays an uncertain Calendar create with the exact same body and key", async () => {
    const body = {
      title: "Новая встреча",
      all_day: false,
      timezone: "Europe/Moscow",
      start_at_utc: "2026-08-12T12:00:00Z",
      end_at_utc: "2026-08-12T13:00:00Z",
      start_date: null,
      end_date_exclusive: null
    };
    const canonical = eventObjectEnvelope({ ...calendarEvent, title: body.title, version: 3 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("create response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));

    await expect(mutatePlanningEvent({
      action: "create",
      idempotencyKey: "calendar-create-replay",
      body
    })).rejects.toMatchObject({
      mutationCode: "uncertain",
      reconciledObject: expect.objectContaining({ title: body.title })
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/planning/events");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/planning/events");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("calendar-create-replay");
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("calendar-create-replay");
    expect(fetchMock.mock.calls[0][1]?.signal).not.toBe(fetchMock.mock.calls[1][1]?.signal);
  });

  it("reconciles Calendar edit and delete timeouts through read-by-ID", async () => {
    const edited = { ...calendarEvent, title: "Moved outside range", version: 3, startAtUtc: "2026-08-20T10:00:00Z", endAtUtc: "2026-08-20T11:00:00Z" };
    const tombstoned = { ...edited, deletedAt: "2026-08-12T09:03:00Z", version: 4 };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("edit response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify(eventObjectEnvelope(edited)), { status: 200 }))
      .mockRejectedValueOnce(new Error("delete response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify(eventObjectEnvelope(tombstoned)), { status: 200 }));

    await expect(mutatePlanningEvent({
      action: "edit",
      idempotencyKey: "calendar-edit-timeout",
      eventId: calendarEvent.id,
      expectedVersion: 2,
      body: { title: "Moved outside range", all_day: false, timezone: "Europe/Moscow", start_at_utc: edited.startAtUtc, end_at_utc: edited.endAtUtc, start_date: null, end_date_exclusive: null }
    })).rejects.toMatchObject({ mutationCode: "uncertain", reconciledObject: expect.objectContaining({ title: "Moved outside range" }) });

    await expect(mutatePlanningEvent({
      action: "delete",
      idempotencyKey: "calendar-delete-timeout",
      eventId: calendarEvent.id,
      expectedVersion: 3,
      body: {}
    })).rejects.toMatchObject({ mutationCode: "uncertain", reconciledObject: expect.objectContaining({ deletedAt: "2026-08-12T09:03:00Z" }) });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/v1/planning/events/${calendarEvent.id}`);
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/v1/planning/events/${calendarEvent.id}`);
  });

  it("keeps event_not_local_only deterministic and does not accept provider fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "event_not_local_only" }), { status: 409 }));
    await expect(mutatePlanningEvent({
      action: "edit",
      idempotencyKey: "calendar-external-edit",
      eventId: calendarEvent.id,
      expectedVersion: 2,
      body: { title: "Forbidden" }
    })).rejects.toMatchObject({ mutationCode: "conflict", status: 409 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("provider_id");
    expect(body).not.toHaveProperty("sync_state");
  });

  it("rejects wrong schema and unknown fields instead of rendering them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(envelope({ schemaVersion: "planning.v2" })), { status: 200 }));
    await expect(readPlanningTasks("today", null)).rejects.toMatchObject({ code: "contract" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(envelope({ unsafe: true })), { status: 200 }));
    await expect(readPlanningTasks("today", null)).rejects.toMatchObject({ code: "contract" });
  });

  it("keeps 503 route-unavailable distinct from an empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    await expect(readPlanningTasks("today", null)).rejects.toEqual(expect.objectContaining({
      status: 503,
      code: "http"
    } satisfies Partial<PlanningReadError>));

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(envelope({ items: [], count: 0 })), { status: 200 }));
    await expect(readPlanningTasks("today", null)).resolves.toMatchObject({ items: [], count: 0 });
  });

  it("forwards AbortController signals and never creates a write method", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      expect(init?.method).toBe("GET");
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(readPlanningTasks("today", null, 20, 0, controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the fixed source-discovery action and accepts only its bounded result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "planning.calendar-sources.refresh.v1",
      kind: "calendar_sources_refresh",
      result: "success",
      status: "current",
      observedAt: "2026-08-27T09:00:00Z",
      lastSuccessfulSyncAt: "2026-08-27T09:00:00Z",
      calendarsSeen: 2,
      eventsSeen: 12,
      errorCode: null,
      correlation_id: "00000000-0000-4000-8000-000000000097"
    }), { status: 200 }));

    await expect(refreshPlanningCalendarSources()).resolves.toMatchObject({
      result: "success",
      status: "current",
      calendarsSeen: 2
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/planning/calendar-sources/refresh",
      expect.objectContaining({ method: "POST", body: "{}", cache: "no-store" })
    );
    expect(fetchMock.mock.calls[0][1]?.method).not.toBe("GET");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "planning.calendar-sources.refresh.v1",
      kind: "calendar_sources_refresh",
      result: "success",
      status: "current",
      observedAt: "2026-08-27T09:00:00Z",
      lastSuccessfulSyncAt: "2026-08-27T09:00:00Z",
      lastSuccessfulSyncAtExtra: "private",
      calendarsSeen: 0,
      eventsSeen: 0,
      errorCode: null,
      correlation_id: "00000000-0000-4000-8000-000000000097"
    }), { status: 200 }));
    await expect(refreshPlanningCalendarSources()).rejects.toMatchObject({ code: "contract" });
  });
});
