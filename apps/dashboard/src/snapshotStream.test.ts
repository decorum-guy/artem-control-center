import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@artem/contracts";
import { markRuntimeShutdownPending } from "./runtimeLifecycle";
import { SnapshotCoordinator } from "./snapshotStream";

class FakeEventSource extends EventTarget {
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }

  emit(type: string, data?: string) {
    const event = data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data });
    this.dispatchEvent(event);
    if (type === "error") this.onerror?.(event);
  }
}

function snapshot(revision: number): DashboardSnapshot {
  return {
    revision,
    generatedAt: `2026-07-29T16:00:0${revision}Z`,
    mode: "fixtures",
    fixtureScenario: "ha-healthy",
    services: []
  };
}

function installBrowserGlobals() {
  const documentTarget = new EventTarget() as EventTarget & { hidden: boolean };
  Object.defineProperty(documentTarget, "hidden", {
    value: false,
    writable: true
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("document", documentTarget as unknown as Document);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    }
  } satisfies Storage);
  return documentTarget;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SnapshotCoordinator", () => {
  it("loads initially, reconciles newer SSE revisions and ignores duplicates", async () => {
    installBrowserGlobals();
    const sources: FakeEventSource[] = [];
    let nextRevision = 1;
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(snapshot(nextRevision)),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const received: number[] = [];
    const coordinator = new SnapshotCoordinator({
      scenario: "ha-healthy",
      onSnapshot: (value) => received.push(value.revision),
      onError: () => undefined,
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      }
    });

    coordinator.start();
    await coordinator.refresh();
    const initialFetches = fetchMock.mock.calls.length;
    expect(initialFetches).toBeGreaterThanOrEqual(1);
    expect(received.at(-1)).toBe(1);

    sources[0].emit("snapshot", JSON.stringify({ revision: 1 }));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(initialFetches);

    nextRevision = 2;
    sources[0].emit("snapshot", JSON.stringify({ revision: 2 }));
    await coordinator.refresh();
    await vi.waitFor(() => expect(received.at(-1)).toBe(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(initialFetches + 1);
    coordinator.stop();
    expect(sources[0].closed).toBe(true);
  });

  it("falls back to calm/fast polling, pauses aggression while hidden and coalesces", async () => {
    vi.useFakeTimers();
    const documentTarget = installBrowserGlobals();
    const source = new FakeEventSource();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(snapshot(1)),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = new SnapshotCoordinator({
      scenario: "ha-healthy",
      onSnapshot: () => undefined,
      onError: () => undefined,
      eventSourceFactory: () => source as unknown as EventSource
    });

    coordinator.start();
    await coordinator.refresh();
    source.emit("error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    documentTarget.hidden = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    const hiddenCount = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(hiddenCount);

    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(hiddenCount);
    coordinator.stop();
  });

  it("never overlaps snapshot requests and coalesces multiple events to one follow-up", async () => {
    installBrowserGlobals();
    const source = new FakeEventSource();
    const resolvers: Array<(response: Response) => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve) => {
        resolvers.push((response) => {
          active -= 1;
          resolve(response);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = new SnapshotCoordinator({
      scenario: "ha-healthy",
      onSnapshot: () => undefined,
      onError: () => undefined,
      eventSourceFactory: () => source as unknown as EventSource
    });

    coordinator.start();
    const first = coordinator.refresh();
    source.emit("snapshot", JSON.stringify({ revision: 2 }));
    source.emit("snapshot", JSON.stringify({ revision: 3 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](new Response(JSON.stringify(snapshot(1)), { status: 200 }));
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers[1](new Response(JSON.stringify(snapshot(3)), { status: 200 }));
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maxActive).toBe(1);
    coordinator.stop();
  });

  it("does not surface expected fetch loss during an intentional runtime shutdown", async () => {
    installBrowserGlobals();
    const source = new FakeEventSource();
    const errors: string[] = [];
    markRuntimeShutdownPending();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const coordinator = new SnapshotCoordinator({
      scenario: "ha-healthy",
      onSnapshot: () => undefined,
      onError: (message) => errors.push(message),
      eventSourceFactory: () => source as unknown as EventSource
    });

    coordinator.start();
    await coordinator.refresh();
    expect(errors).toEqual([]);
    coordinator.stop();
  });
});
