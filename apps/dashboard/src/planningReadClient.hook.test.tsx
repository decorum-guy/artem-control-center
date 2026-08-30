// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlanningReadError,
  type PlanningReadEnvelope,
  type PlanningReadState,
  usePlanningRead
} from "./planningReadClient";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = { title: string };

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function envelope(title: string): PlanningReadEnvelope<Item> {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain: "task",
    generatedAt: "2026-08-12T09:00:00Z",
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z",
    items: [{ title }],
    limit: 20,
    offset: 0,
    count: 1,
    hasMore: false
  };
}

type HarnessProps = {
  queryKey: string;
  refreshKey: string;
  reader: (signal: AbortSignal) => Promise<PlanningReadEnvelope<Item>>;
  enabled?: boolean;
  onState: (state: PlanningReadState<Item>) => void;
};

function Harness({ onState, ...options }: HarnessProps) {
  const state = usePlanningRead(options);
  useEffect(() => onState(state), [onState, state]);
  return null;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("usePlanningRead query cache lifecycle", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function mount(initial: Omit<HarnessProps, "onState">): Promise<{
    latest: () => PlanningReadState<Item>;
    rerender: (next: Omit<HarnessProps, "onState">) => Promise<void>;
  }> {
    let state: PlanningReadState<Item> | null = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const render = async (properties: Omit<HarnessProps, "onState">) => {
      await act(async () => {
        root?.render(<Harness {...properties} onState={(next) => { state = next; }} />);
        await settle();
      });
    };
    await render(initial);
    return {
      latest: () => {
        if (!state) throw new Error("Hook did not render");
        return state;
      },
      rerender: render
    };
  }

  it("keeps an unseen initial query loading and exposes its successful envelope", async () => {
    const queryA = deferred<PlanningReadEnvelope<Item>>();
    const harness = await mount({ queryKey: "A", refreshKey: "1", reader: () => queryA.promise });
    expect(harness.latest()).toMatchObject({ loading: true, refreshing: false, data: null, error: null });

    await act(async () => { queryA.resolve(envelope("QUERY_A")); await settle(); });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: false, error: null });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A");
  });

  it("does not leak A into unseen B, then restores exact cached A while it revalidates", async () => {
    const firstA = deferred<PlanningReadEnvelope<Item>>();
    const harness = await mount({ queryKey: "A", refreshKey: "1", reader: () => firstA.promise });
    await act(async () => { firstA.resolve(envelope("QUERY_A")); await settle(); });

    const queryB = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "B", refreshKey: "1", reader: () => queryB.promise });
    expect(harness.latest()).toMatchObject({ loading: true, refreshing: false, data: null, error: null });
    await act(async () => { queryB.resolve(envelope("QUERY_B")); await settle(); });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_B");

    const refreshedA = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "A", refreshKey: "2", reader: () => refreshedA.promise });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: true, error: null });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A");
    await act(async () => { refreshedA.resolve(envelope("QUERY_A_REFRESHED")); await settle(); });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: false, error: null });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A_REFRESHED");
  });

  it("keeps cached target data on its failed revalidation and exposes no fallback for unseen failure", async () => {
    const firstA = deferred<PlanningReadEnvelope<Item>>();
    const harness = await mount({ queryKey: "A", refreshKey: "1", reader: () => firstA.promise });
    await act(async () => { firstA.resolve(envelope("QUERY_A")); await settle(); });

    const refreshA = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "A", refreshKey: "2", reader: () => refreshA.promise });
    await act(async () => { refreshA.reject(new PlanningReadError("A unavailable", "http", 503)); await settle(); });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: false, error: expect.objectContaining({ status: 503 }) });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A");

    const queryC = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "C", refreshKey: "1", reader: () => queryC.promise });
    expect(harness.latest()).toMatchObject({ loading: true, refreshing: false, data: null, error: null });
    await act(async () => { queryC.reject(new PlanningReadError("C unavailable", "http", 503)); await settle(); });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: false, data: null, error: expect.objectContaining({ status: 503 }) });
  });

  it("aborts an abandoned request and never lets its late response overwrite B", async () => {
    const abandonedA = deferred<PlanningReadEnvelope<Item>>();
    const abandoned = { signal: null as AbortSignal | null };
    const harness = await mount({
      queryKey: "A",
      refreshKey: "1",
      reader: (signal) => {
        abandoned.signal = signal;
        return abandonedA.promise;
      }
    });
    const queryB = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "B", refreshKey: "1", reader: () => queryB.promise });
    expect(abandoned.signal?.aborted).toBe(true);
    await act(async () => { queryB.resolve(envelope("QUERY_B")); await settle(); });
    await act(async () => { abandonedA.resolve(envelope("QUERY_A_LATE")); await settle(); });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_B");
  });

  it("hides cached data while disabled, reuses it when re-enabled, and retains same-query SWR", async () => {
    const firstA = deferred<PlanningReadEnvelope<Item>>();
    const harness = await mount({ queryKey: "A", refreshKey: "1", reader: () => firstA.promise });
    await act(async () => { firstA.resolve(envelope("QUERY_A")); await settle(); });

    await harness.rerender({ queryKey: "A", refreshKey: "1", reader: () => Promise.resolve(envelope("DISABLED_UNUSED")), enabled: false });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: false, data: null, error: null });

    const enabledA = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "A", refreshKey: "2", reader: () => enabledA.promise, enabled: true });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: true, error: null });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A");
    await act(async () => { enabledA.resolve(envelope("QUERY_A_REENABLED")); await settle(); });

    const sameQueryRefresh = deferred<PlanningReadEnvelope<Item>>();
    await harness.rerender({ queryKey: "A", refreshKey: "3", reader: () => sameQueryRefresh.promise });
    expect(harness.latest()).toMatchObject({ loading: false, refreshing: true, error: null });
    expect(harness.latest().data?.items[0].title).toBe("QUERY_A_REENABLED");
  });
});
