import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mutatePlanningReminder,
  mutatePlanningTask,
  PlanningMutationError,
  PlanningReadError,
  planningReadParsers,
  previewPlanningReminder,
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

afterEach(() => vi.restoreAllMocks());

describe("fixed Planning read client", () => {
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
      allDay: false,
      timezone: "Europe/Moscow",
      syncState: "synced",
      startAtUtc: "2026-08-12T10:00:00Z",
      endAtUtc: "2026-08-12T11:00:00Z",
      startDate: null,
      endDateExclusive: null,
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
});
