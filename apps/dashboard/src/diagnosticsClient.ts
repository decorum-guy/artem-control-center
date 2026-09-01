import { useEffect, useState } from "react";
import type { DashboardSnapshot, DiagnosticsProblem, DiagnosticsReport } from "@artem/contracts";
import { currentProblemsForSnapshot } from "./problemModel";

export type DiagnosticsStatus = "checking" | "ready" | "unavailable";
export type DiagnosticsState = { status: DiagnosticsStatus; report: DiagnosticsReport | null };

const readyByRevision = new Map<number, DiagnosticsReport>();
const inFlightByRevision = new Map<number, Promise<DiagnosticsReport>>();
const MAX_READY_REVISIONS = 2;
type StoredDiagnosticsState = DiagnosticsState & { revision: number };

function retainReady(revision: number, report: DiagnosticsReport): void {
  readyByRevision.delete(revision);
  readyByRevision.set(revision, report);
  while (readyByRevision.size > MAX_READY_REVISIONS) {
    const oldest = readyByRevision.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    readyByRevision.delete(oldest);
  }
}

async function requestForRevision(revision: number, retry = false): Promise<DiagnosticsReport> {
  const response = await fetch("/api/v1/diagnostics?scenario=ha-healthy", { cache: "no-store" });
  if (!response.ok) throw new Error("diagnostics_unavailable");
  const report = await response.json() as DiagnosticsReport;
  if (report.snapshotRevision === revision) return report;
  if (!retry) return requestForRevision(revision, true);
  throw new Error("diagnostics_revision_lag");
}

/** One in-flight request per snapshot revision, shared by every surface. */
export function fetchDiagnosticsReport(revision: number): Promise<DiagnosticsReport> {
  const ready = readyByRevision.get(revision);
  if (ready) return Promise.resolve(ready);
  const existing = inFlightByRevision.get(revision);
  if (existing) return existing;
  const request = requestForRevision(revision)
    .then((report) => {
      retainReady(revision, report);
      return report;
    })
    .finally(() => { inFlightByRevision.delete(revision); });
  inFlightByRevision.set(revision, request);
  return request;
}

export function resetDiagnosticsClientForTests(): void {
  readyByRevision.clear();
  inFlightByRevision.clear();
}

export function readyDiagnosticsCacheSizeForTests(): number {
  return readyByRevision.size;
}

export function diagnosticsProblems(
  state: DiagnosticsState,
  snapshot: Pick<DashboardSnapshot, "services" | "planning" | "generatedAt">
): DiagnosticsProblem[] | null {
  if (state.status === "ready") return state.report?.problems ?? null;
  if (state.status === "unavailable") return currentProblemsForSnapshot(snapshot);
  return null;
}

export function useDiagnosticsReport(revision: number): DiagnosticsState {
  const [state, setState] = useState<StoredDiagnosticsState>(() => {
    const report = readyByRevision.get(revision);
    return report ? { revision, status: "ready", report } : { revision, status: "checking", report: null };
  });
  useEffect(() => {
    let live = true;
    const cached = readyByRevision.get(revision);
    if (cached) {
      setState({ revision, status: "ready", report: cached });
      return () => { live = false; };
    }
    setState({ revision, status: "checking", report: null });
    void fetchDiagnosticsReport(revision).then(
      (report) => { if (live) setState({ revision, status: "ready", report }); },
      () => { if (live) setState({ revision, status: "unavailable", report: null }); }
    );
    return () => { live = false; };
  }, [revision]);
  return state.revision === revision ? state : { status: "checking", report: null };
}
