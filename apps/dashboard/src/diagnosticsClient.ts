import { useEffect, useState } from "react";
import type { DiagnosticsReport } from "@artem/contracts";

let cached: DiagnosticsReport | null = null;
let inFlight: Promise<DiagnosticsReport> | null = null;

export function fetchDiagnosticsReport(): Promise<DiagnosticsReport> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = fetch("/api/v1/diagnostics?scenario=ha-healthy", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("diagnostics_unavailable");
        const report = await response.json() as DiagnosticsReport;
        cached = report;
        return report;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Shared in-flight request avoids shell/System fetch storms. */
export function useDiagnosticsReport(revision: number): { report: DiagnosticsReport | null; unavailable: boolean } {
  const [report, setReport] = useState<DiagnosticsReport | null>(cached);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchDiagnosticsReport().then((next) => {
      if (live) setReport(next);
    }).catch(() => { if (live) setUnavailable(true); });
    return () => { live = false; };
  }, [revision]);
  return { report, unavailable };
}
