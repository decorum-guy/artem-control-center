// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsReport } from "@artem/contracts";
import { diagnosticsProblems, fetchDiagnosticsReport, readyDiagnosticsCacheSizeForTests, resetDiagnosticsClientForTests, useDiagnosticsReport, type DiagnosticsState } from "./diagnosticsClient";
import { emptyPlanningFixture } from "./planningFixtures";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function report(revision: number, problems: DiagnosticsReport["problems"]): DiagnosticsReport {
  return { snapshotRevision: revision, problems } as DiagnosticsReport;
}

const snapshot = { generatedAt: "2026-08-25T12:00:00Z", services: [], planning: emptyPlanningFixture };

afterEach(() => {
  resetDiagnosticsClientForTests();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("revision-aware diagnostics client", () => {
  it("never reuses revision 100 authority for revision 101 recovery", async () => {
    const calendar = { id: "planning:calendar", subsystem: "Календарь", state: "error" } as DiagnosticsReport["problems"][number];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => report(100, [calendar]) })
      .mockResolvedValueOnce({ ok: true, json: async () => report(101, []) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchDiagnosticsReport(100)).problems).toHaveLength(1);
    expect((await fetchDiagnosticsReport(101)).problems).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one same-revision in-flight request", async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = fetchDiagnosticsReport(101);
    const second = fetchDiagnosticsReport(101);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => report(101, []) });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("uses no fallback while checking, the report when ready, and fallback only when unavailable", () => {
    expect(diagnosticsProblems({ status: "checking", report: null }, snapshot)).toBeNull();
    expect(diagnosticsProblems({ status: "ready", report: report(101, []) }, snapshot)).toEqual([]);
    expect(diagnosticsProblems({ status: "unavailable", report: null }, snapshot)).toHaveLength(1);
  });

  it("retries one stale endpoint response then refuses an older report", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => report(100, []) })
      .mockResolvedValueOnce({ ok: true, json: async () => report(101, []) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDiagnosticsReport(101)).resolves.toMatchObject({ snapshotRevision: 101 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains only two ready reports after many revisions", async () => {
    vi.stubGlobal("fetch", vi.fn((_, init) => {
      void init;
      const revision = Number((vi.mocked(fetch).mock.calls.length));
      return Promise.resolve({ ok: true, json: async () => report(revision, []) });
    }));
    for (let revision = 1; revision <= 8; revision += 1) await fetchDiagnosticsReport(revision);
    expect(readyDiagnosticsCacheSizeForTests()).toBe(2);
  });

  it("synchronously hides revision 100 while revision 101 is checking without remount", async () => {
    const queue: Array<(value: unknown) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => queue.push(resolve))));
    let latest: DiagnosticsState | null = null;
    function Harness({ revision }: { revision: number }) {
      const state = useDiagnosticsReport(revision);
      useEffect(() => { latest = state; }, [state]);
      return null;
    }
    const host = document.createElement("div");
    const root: Root = createRoot(host);
    await act(async () => { root.render(createElement(Harness, { revision: 100 })); await settle(); });
    await act(async () => { queue.shift()?.({ ok: true, json: async () => report(100, [{ id: "planning:calendar" } as DiagnosticsReport["problems"][number]]) }); await settle(); });
    expect(latest).toMatchObject({ status: "ready", report: { problems: [{ id: "planning:calendar" }] } });
    await act(async () => { root.render(createElement(Harness, { revision: 101 })); await settle(); });
    expect(latest).toMatchObject({ status: "checking", report: null });
    await act(async () => { queue.shift()?.({ ok: true, json: async () => report(101, []) }); await settle(); });
    expect(latest).toMatchObject({ status: "ready", report: { problems: [] } });
    await act(async () => root.unmount());
  });
});
