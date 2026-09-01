import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsReport } from "@artem/contracts";
import { diagnosticsProblems, fetchDiagnosticsReport, resetDiagnosticsClientForTests } from "./diagnosticsClient";
import { emptyPlanningFixture } from "./planningFixtures";

function report(revision: number, problems: DiagnosticsReport["problems"]): DiagnosticsReport {
  return { snapshotRevision: revision, problems } as DiagnosticsReport;
}

const snapshot = { generatedAt: "2026-08-25T12:00:00Z", services: [], planning: emptyPlanningFixture };

afterEach(() => {
  resetDiagnosticsClientForTests();
  vi.unstubAllGlobals();
});

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
});
