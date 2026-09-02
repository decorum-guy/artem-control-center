import { useEffect, useMemo, useState } from "react";
import type { DashboardSnapshot, DiagnosticsProblem, DiagnosticsReport } from "@artem/contracts";
import { currentProblemsForSnapshot } from "./problemModel";

export type DiagnosticsStatus = "checking" | "ready" | "unavailable";
export type DiagnosticsState = { status: DiagnosticsStatus; report: DiagnosticsReport | null };
export type DiagnosticsIdentity = { revision: number; fixtureScenario: string | null };

const readyByIdentity = new Map<string, DiagnosticsReport>();
const inFlightByIdentity = new Map<string, Promise<DiagnosticsReport>>();
const MAX_READY_IDENTITIES = 2;
type StoredDiagnosticsState = DiagnosticsState & { identityKey: string };

function identityKey(identity: DiagnosticsIdentity): string {
  return JSON.stringify([identity.revision, identity.fixtureScenario]);
}

function diagnosticsUrl(identity: DiagnosticsIdentity): string {
  return identity.fixtureScenario === null
    ? "/api/v1/diagnostics"
    : `/api/v1/diagnostics?scenario=${encodeURIComponent(identity.fixtureScenario)}`;
}

function retainReady(identity: DiagnosticsIdentity, report: DiagnosticsReport): void {
  const key = identityKey(identity);
  readyByIdentity.delete(key);
  readyByIdentity.set(key, report);
  while (readyByIdentity.size > MAX_READY_IDENTITIES) {
    const oldest = readyByIdentity.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    readyByIdentity.delete(oldest);
  }
}

async function requestForIdentity(identity: DiagnosticsIdentity, retry = false): Promise<DiagnosticsReport> {
  const response = await fetch(diagnosticsUrl(identity), { cache: "no-store" });
  if (!response.ok) throw new Error("diagnostics_unavailable");
  const report = await response.json() as DiagnosticsReport;
  if (report.snapshotRevision === identity.revision) return report;
  if (!retry) return requestForIdentity(identity, true);
  throw new Error("diagnostics_revision_lag");
}

/** One in-flight request per complete snapshot identity, shared by every surface. */
export function fetchDiagnosticsReport(identity: DiagnosticsIdentity): Promise<DiagnosticsReport> {
  const key = identityKey(identity);
  const ready = readyByIdentity.get(key);
  if (ready) return Promise.resolve(ready);
  const existing = inFlightByIdentity.get(key);
  if (existing) return existing;
  const request = requestForIdentity(identity)
    .then((report) => {
      retainReady(identity, report);
      return report;
    })
    .finally(() => { inFlightByIdentity.delete(key); });
  inFlightByIdentity.set(key, request);
  return request;
}

export function resetDiagnosticsClientForTests(): void {
  readyByIdentity.clear();
  inFlightByIdentity.clear();
}

export function readyDiagnosticsCacheSizeForTests(): number {
  return readyByIdentity.size;
}

export function diagnosticsProblems(
  state: DiagnosticsState,
  snapshot: Pick<DashboardSnapshot, "services" | "planning" | "generatedAt">
): DiagnosticsProblem[] | null {
  if (state.status === "ready") return state.report?.problems ?? null;
  if (state.status === "unavailable") return currentProblemsForSnapshot(snapshot);
  return null;
}

export function useDiagnosticsReport(identity: DiagnosticsIdentity): DiagnosticsState {
  const key = identityKey(identity);
  const stableIdentity = useMemo(
    () => ({ revision: identity.revision, fixtureScenario: identity.fixtureScenario }),
    [identity.revision, identity.fixtureScenario]
  );
  const [state, setState] = useState<StoredDiagnosticsState>(() => {
    const report = readyByIdentity.get(key);
    return report ? { identityKey: key, status: "ready", report } : { identityKey: key, status: "checking", report: null };
  });
  useEffect(() => {
    let live = true;
    const cached = readyByIdentity.get(key);
    if (cached) {
      setState({ identityKey: key, status: "ready", report: cached });
      return () => { live = false; };
    }
    setState({ identityKey: key, status: "checking", report: null });
    void fetchDiagnosticsReport(stableIdentity).then(
      (report) => { if (live) setState({ identityKey: key, status: "ready", report }); },
      () => { if (live) setState({ identityKey: key, status: "unavailable", report: null }); }
    );
    return () => { live = false; };
  }, [key, stableIdentity]);
  return state.identityKey === key ? state : { status: "checking", report: null };
}
