import type { DiagnosticsProblem, DiagnosticsReport } from "../../packages/contracts/src/index";
import type { Page } from "@playwright/test";

export function diagnosticsProblem(
  id: string,
  subsystem: string,
  state: Extract<DiagnosticsProblem["state"], "degraded" | "offline" | "stale" | "error">,
  summary: string
): DiagnosticsProblem {
  return {
    id,
    subsystem,
    severity: state === "offline" || state === "error" ? "error" : "warning",
    state,
    current: true,
    summary,
    firstObservedAt: "2026-08-14T12:00:00Z",
    lastObservedAt: "2026-08-14T12:00:00Z",
    lastHealthyAt: null,
    freshness: "проверено только что",
    correlationCode: id.replaceAll(":", "_")
  };
}

function report(snapshotRevision: number, problems: readonly DiagnosticsProblem[]): DiagnosticsReport {
  return {
    schemaVersion: "diagnostics.v1",
    generatedAt: "2026-08-14T12:00:00Z",
    buildRevision: "e2e-fixture",
    mode: "fixtures",
    snapshotRevision,
    problems: [...problems],
    recentTransitions: [],
    collectorStatus: [],
    planning: {
      schemaVersion: null,
      sourceStatus: null,
      lastSyncedAt: null,
      staleAfter: null,
      remindersCount: 0,
      tasksCount: 0,
      calendarCount: 0,
      cacheUsed: false,
      providers: []
    },
    calendar: {
      scopeType: "PROJECTION_SCOPE",
      fromDate: "2026-08-14",
      toDate: "2026-08-14",
      requestFromUtc: null,
      requestToUtc: null,
      view: null,
      timezone: "Europe/Moscow",
      observedAt: "2026-08-14T12:00:00Z",
      lastSyncedAt: null,
      resultStatus: "success_empty",
      itemCount: 0,
      sourceCount: 0,
      calendarCount: 0,
      sourceStatus: null,
      cacheUsed: false,
      fallbackUsed: false,
      projectionStatus: "empty",
      projectionScope: "fixture",
      providers: []
    },
    calendarReads: [],
    mutationGates: {
      writesEnabled: false,
      coffeeActionsEnabled: false,
      coffeeTimingWritesEnabled: false,
      coffeeNotificationWritesEnabled: false,
      planningReminderMutationsEnabled: false,
      planningTaskMutationsEnabled: false,
      planningCalendarMutationsEnabled: false
    }
  };
}

/** Mirrors a browser-mutated snapshot with an explicit server-owned diagnostics report. */
export async function installDiagnosticsFixture(
  page: Page,
  snapshotRevision: () => number,
  problems: readonly DiagnosticsProblem[]
): Promise<{ revision: () => number | null }> {
  let revision: number | null = null;
  await page.route(/\/api\/v1\/diagnostics(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    revision = snapshotRevision();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report(revision, problems)) });
  });
  return { revision: () => revision };
}
