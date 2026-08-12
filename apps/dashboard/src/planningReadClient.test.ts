import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanningReadError, readPlanningTasks } from "./planningReadClient";

const task = {
  id: "00000000-0000-4000-8000-000000000501",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Задача из route API",
  priority: "high",
  status: "open",
  dueDate: "2026-08-12",
  dueTime: null,
  timezone: null,
  projectId: null,
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

