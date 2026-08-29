import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, DiagnosticsReport } from "@artem/contracts";
import { emptyPlanningFixture, planningFixtures } from "./planningFixtures";
import {
  copyDiagnosticsText,
  currentProblemsForSnapshot,
  diagnosticsFallbackCopyText,
  diagnosticsSupportText
} from "./problemModel";

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    revision: 1,
    generatedAt: "2026-08-25T12:00:00Z",
    mode: "fixtures",
    fixtureScenario: "test",
    services: [],
    planning: planningFixtures.healthy,
    ...overrides
  };
}

function report(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    schemaVersion: "diagnostics.v1",
    generatedAt: "2026-08-25T12:00:00Z",
    buildRevision: "test-revision",
    mode: "fixtures",
    snapshotRevision: 1,
    problems: [],
    recentTransitions: [],
    collectorStatus: [{ collector: "snapshot", status: "ok", code: null }],
    planning: {
      schemaVersion: "planning.panel.v1",
      sourceStatus: "current",
      lastSyncedAt: "2026-08-25T11:59:00Z",
      staleAfter: null,
      remindersCount: 0,
      tasksCount: 0,
      calendarCount: 0,
      cacheUsed: false,
      providers: []
    },
    calendar: {
      scopeType: "PROJECTION_SCOPE",
      fromDate: "unknown",
      toDate: "unknown",
      requestFromUtc: null,
      requestToUtc: null,
      view: null,
      timezone: "Europe/Moscow",
      observedAt: "2026-08-25T12:00:00Z",
      lastSyncedAt: "2026-08-25T11:59:00Z",
      resultStatus: "success_empty",
      itemCount: 0,
      sourceCount: 0,
      calendarCount: 0,
      sourceStatus: "current",
      cacheUsed: false,
      fallbackUsed: false,
      projectionStatus: "empty",
      projectionScope: "planning_snapshot_calendar_today_upcoming",
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
    },
    ...overrides
  };
}

describe("owner diagnostics problem model", () => {
  it("keeps a healthy snapshot at zero current problems", () => {
    expect(currentProblemsForSnapshot(snapshot())).toEqual([]);
  });

  it("maps an unhealthy service to a concrete problem and counts it once", () => {
    const service = {
      id: "home-assistant",
      title: "Home Assistant",
      enabled: true,
      dataContract: "service.health.v1",
      health: "offline" as const,
      source: "unavailable" as const,
      summary: "ignored raw summary",
      actions: [],
      data: {}
    };
    const problems = currentProblemsForSnapshot(snapshot({ services: [service] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ id: "service:home-assistant", subsystem: "Home Assistant", state: "offline" });
  });

  it("represents stale Planning and provider errors without requiring currentness", () => {
    const stale = { ...planningFixtures.healthy, sourceStatus: "stale" as const };
    expect(currentProblemsForSnapshot(snapshot({ planning: stale }))).toContainEqual(expect.objectContaining({ id: "planning:source", state: "stale" }));

    const providerError = {
      ...planningFixtures.healthy,
      providerStatuses: planningFixtures.healthy.providerStatuses.map((provider) => ({ ...provider, status: "error" as const }))
    };
    expect(currentProblemsForSnapshot(snapshot({ planning: providerError }))).toContainEqual(expect.objectContaining({ state: "error" }));
  });

  it("uses the server-provided domain identity instead of generic Planning attribution", () => {
    const planning = {
      ...planningFixtures.healthy,
      sourceStatus: "degraded" as const,
      health: {
        lastAttemptedAt: "2026-08-25T12:00:00Z",
        lastSuccessfulAt: "2026-08-25T11:59:00Z",
        consecutiveFailures: 2,
        issues: [{
          source: "tasks" as const,
          status: "degraded" as const,
          consecutiveFailures: 2,
          lastAttemptedAt: "2026-08-25T12:00:00Z",
          lastSuccessfulAt: "2026-08-25T11:59:00Z"
        }],
        domains: []
      }
    };
    const problems = currentProblemsForSnapshot(snapshot({ planning }));
    expect(problems).toContainEqual(expect.objectContaining({ id: "planning:tasks", subsystem: "Задачи", state: "degraded" }));
    expect(problems).not.toContainEqual(expect.objectContaining({ id: "planning:source" }));
  });

  it("keeps support text deterministic and excludes private fields from the formatter", () => {
    const first = diagnosticsSupportText(report({
      problems: [{
        id: "service:home-assistant",
        subsystem: "Home Assistant",
        severity: "error",
        state: "offline",
        current: true,
        summary: "Home Assistant недоступен",
        firstObservedAt: "2026-08-25T12:00:00Z",
        lastObservedAt: "2026-08-25T12:00:00Z",
        lastHealthyAt: null,
        freshness: null,
        correlationCode: "service_health_offline"
      }]
    }));
    expect(first).toBe(diagnosticsSupportText(report({
      problems: [{
        id: "service:home-assistant",
        subsystem: "Home Assistant",
        severity: "error",
        state: "offline",
        current: true,
        summary: "Home Assistant недоступен",
        firstObservedAt: "2026-08-25T12:00:00Z",
        lastObservedAt: "2026-08-25T12:00:00Z",
        lastHealthyAt: null,
        freshness: null,
        correlationCode: "service_health_offline"
      }]
    })));
    expect(first).not.toContain("PRIVATE_EVENT_TITLE_CANARY");
    expect(first).not.toContain("super-secret-ha-token-canary");
  });

  it("supports clipboard success and a deterministic denied-clipboard fallback", async () => {
    const clipboard = { writeText: async () => undefined };
    expect(await copyDiagnosticsText("safe-report", clipboard)).toBe(true);
    expect(await copyDiagnosticsText("safe-report", { writeText: async () => { throw new Error("denied"); } })).toBe(false);
    expect(await copyDiagnosticsText("safe-report", null)).toBe(false);
  });

  it("describes the fallback action without promising a download", () => {
    expect(diagnosticsFallbackCopyText).toContain("Выделите отчёт");
    expect(diagnosticsFallbackCopyText).toContain("скопируйте его вручную");
    expect(diagnosticsFallbackCopyText).not.toContain("скачать");
  });

  it("does not treat an empty Planning projection as an error", () => {
    const current = { ...emptyPlanningFixture, sourceStatus: "current" as const, calendar: { ...emptyPlanningFixture.calendar, today: [], upcoming: [] } };
    expect(currentProblemsForSnapshot(snapshot({ planning: current }))).toEqual([]);
  });
});
