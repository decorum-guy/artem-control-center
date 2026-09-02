// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsReport } from "@artem/contracts";
import { diagnosticsProblems, fetchDiagnosticsReport, readyDiagnosticsCacheSizeForTests, resetDiagnosticsClientForTests, useDiagnosticsReport, type DiagnosticsIdentity, type DiagnosticsState } from "./diagnosticsClient";
import { emptyPlanningFixture } from "./planningFixtures";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function report(revision: number, problems: DiagnosticsReport["problems"]): DiagnosticsReport {
  return { snapshotRevision: revision, problems } as DiagnosticsReport;
}

const snapshot = { generatedAt: "2026-08-25T12:00:00Z", services: [], planning: emptyPlanningFixture };
const production = (revision: number): DiagnosticsIdentity => ({ revision, fixtureScenario: null });
const fixture = (revision: number, fixtureScenario: string): DiagnosticsIdentity => ({ revision, fixtureScenario });

afterEach(() => {
  resetDiagnosticsClientForTests();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("snapshot-identity-aware diagnostics client", () => {
  it("never reuses revision 100 authority for revision 101 recovery", async () => {
    const calendar = { id: "planning:calendar", subsystem: "Календарь", state: "error" } as DiagnosticsReport["problems"][number];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => report(100, [calendar]) })
      .mockResolvedValueOnce({ ok: true, json: async () => report(101, []) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchDiagnosticsReport(production(100))).problems).toHaveLength(1);
    expect((await fetchDiagnosticsReport(production(101))).problems).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/diagnostics", { cache: "no-store" });
  });

  it("shares one same-identity in-flight request", async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = fetchDiagnosticsReport(fixture(101, "coffee-off"));
    const second = fetchDiagnosticsReport(fixture(101, "coffee-off"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => report(101, []) });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/diagnostics?scenario=coffee-off", { cache: "no-store" });
  });

  it("isolates same-revision fixture scenarios without reusing a ready report", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => report(1, [{ id: "coffee-off" } as DiagnosticsReport["problems"][number]]) })
      .mockResolvedValueOnce({ ok: true, json: async () => report(1, [{ id: "home-ha-stale" } as DiagnosticsReport["problems"][number]]) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDiagnosticsReport(fixture(1, "coffee-off"))).resolves.toMatchObject({ problems: [{ id: "coffee-off" }] });
    await expect(fetchDiagnosticsReport(fixture(1, "home-ha-stale"))).resolves.toMatchObject({ problems: [{ id: "home-ha-stale" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/diagnostics?scenario=coffee-off", { cache: "no-store" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/diagnostics?scenario=home-ha-stale", { cache: "no-store" });
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
    await expect(fetchDiagnosticsReport(production(101))).resolves.toMatchObject({ snapshotRevision: 101 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains only two ready reports after many identities", async () => {
    vi.stubGlobal("fetch", vi.fn((_, init) => {
      void init;
      const revision = Number((vi.mocked(fetch).mock.calls.length));
      return Promise.resolve({ ok: true, json: async () => report(revision, []) });
    }));
    for (let revision = 1; revision <= 8; revision += 1) await fetchDiagnosticsReport(fixture(revision, `scenario-${revision}`));
    expect(readyDiagnosticsCacheSizeForTests()).toBe(2);
  });

  it("synchronously hides a ready report while the same revision switches fixture scenario", async () => {
    const queue: Array<(value: unknown) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => queue.push(resolve))));
    let latest: DiagnosticsState | null = null;
    function Harness({ identity }: { identity: DiagnosticsIdentity }) {
      const state = useDiagnosticsReport(identity);
      useEffect(() => { latest = state; }, [state]);
      return null;
    }
    const host = document.createElement("div");
    const root: Root = createRoot(host);
    await act(async () => { root.render(createElement(Harness, { identity: fixture(100, "coffee-off") })); await settle(); });
    await act(async () => { queue.shift()?.({ ok: true, json: async () => report(100, [{ id: "planning:calendar" } as DiagnosticsReport["problems"][number]]) }); await settle(); });
    expect(latest).toMatchObject({ status: "ready", report: { problems: [{ id: "planning:calendar" }] } });
    await act(async () => { root.render(createElement(Harness, { identity: fixture(100, "home-ha-stale") })); await settle(); });
    expect(latest).toMatchObject({ status: "checking", report: null });
    await act(async () => { queue.shift()?.({ ok: true, json: async () => report(100, []) }); await settle(); });
    expect(latest).toMatchObject({ status: "ready", report: { problems: [] } });
    await act(async () => root.unmount());
  });
});
