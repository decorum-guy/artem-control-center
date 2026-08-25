import type {
  DashboardSnapshot,
  DiagnosticsProblem,
  DiagnosticsProblemState,
  ServiceSnapshot
} from "@artem/contracts";
import type { StatusTone } from "./ShellPrimitives";

export const diagnosticsFallbackCopyText = "Буфер обмена недоступен. Выделите отчёт и скопируйте его вручную.";

const serviceLabels: Record<string, string> = {
  "home-assistant": "Home Assistant",
  "coffee-machine": "Кофемашина",
  kettle: "Чайник",
  "alice-tg-bot": "AliceTG",
  "avalar-site-main": "AVALAR Main",
  "avalar-site-stage": "AVALAR Stage",
  rog_g703gi: "ROG",
  "panel-runtime": "Control Center runtime"
};

function stateForHealth(service: ServiceSnapshot): Extract<DiagnosticsProblemState, "offline" | "degraded" | "stale"> {
  return service.health === "offline" || service.health === "stale" ? service.health : "degraded";
}

function stateSummary(subsystem: string, state: DiagnosticsProblemState): string {
  switch (state) {
    case "offline": return `${subsystem} недоступен`;
    case "stale": return `${subsystem} показывает устаревшее состояние`;
    case "error": return `${subsystem} сообщил об ошибке`;
    case "recovered": return `${subsystem} восстановлен`;
    default: return `${subsystem} работает с ограничениями`;
  }
}

function problem(
  id: string,
  subsystem: string,
  state: Extract<DiagnosticsProblemState, "offline" | "degraded" | "stale" | "error">,
  observedAt: string,
  freshness: string | null = null
): DiagnosticsProblem {
  return {
    id,
    subsystem,
    severity: state === "offline" || state === "error" ? "error" : "warning",
    state,
    current: true,
    summary: stateSummary(subsystem, state),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    lastHealthyAt: null,
    freshness,
    correlationCode: `${id.split(":")[0]}_${state}`
  };
}

export function currentProblemsForSnapshot(
  snapshot: Pick<DashboardSnapshot, "services" | "planning" | "generatedAt">
): DiagnosticsProblem[] {
  const problems: DiagnosticsProblem[] = [];
  for (const service of snapshot.services) {
    if (!service.enabled || service.health === "healthy") continue;
    const subsystem = serviceLabels[service.id] ?? "Сервис";
    problems.push(problem(
      `service:${service.id}`,
      subsystem,
      stateForHealth(service),
      snapshot.generatedAt,
      service.presentation?.freshnessLabel ?? null
    ));
  }

  const planning = snapshot.planning;
  if (planning && planning.sourceStatus !== "current") {
    problems.push(problem(
      "planning:source",
      "Planning",
      planning.sourceStatus,
      snapshot.generatedAt,
      planning.lastSyncedAt
    ));
  }
  for (const provider of planning?.providerStatuses ?? []) {
    if (provider.status !== "error" && provider.status !== "stale") continue;
    const state = provider.status;
    const subsystem = provider.provider === "icloud" ? "iCloud Calendar" : "Local Planning";
    const id = /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(provider.id)
      ? provider.id
      : "redacted";
    problems.push(problem(
      `calendar-provider:${id}`,
      subsystem,
      state,
      snapshot.generatedAt,
      provider.lastSyncedAt
    ));
  }
  return problems;
}

export function problemStateLabel(state: DiagnosticsProblemState): string {
  switch (state) {
    case "offline": return "Недоступен";
    case "stale": return "Устарело";
    case "error": return "Ошибка";
    case "recovered": return "Восстановлено";
    default: return "Ограничено";
  }
}

export function problemTone(state: DiagnosticsProblemState): StatusTone {
  switch (state) {
    case "offline": return "offline";
    case "stale": return "stale";
    case "error": return "danger";
    case "recovered": return "success";
    default: return "warning";
  }
}

export function diagnosticsSupportText(report: import("@artem/contracts").DiagnosticsReport): string {
  const calendarScope = report.calendar.scopeType === "ACTUAL_REQUEST_RANGE"
    ? `${report.calendar.fromDate}..${report.calendar.toDate} | request=${report.calendar.requestFromUtc ?? "unknown"}..${report.calendar.requestToUtc ?? "unknown"}`
    : `projection=${report.calendar.projectionScope ?? "unknown"}`;
  const lines = [
    "Artem Control Center diagnostics.v1",
    `generatedAt: ${report.generatedAt}`,
    `buildRevision: ${report.buildRevision}`,
    `mode: ${report.mode}`,
    `snapshotRevision: ${report.snapshotRevision}`,
    `currentProblems: ${report.problems.length}`,
    ...report.problems.map((item) => `problem: ${item.subsystem} | ${item.state} | ${item.summary}`),
    `planning: ${report.planning.sourceStatus ?? "unavailable"} | schema=${report.planning.schemaVersion ?? "unavailable"} | reminders=${report.planning.remindersCount} | tasks=${report.planning.tasksCount} | calendar=${report.planning.calendarCount}`,
    `calendarQuery: ${calendarScope} | scope=${report.calendar.scopeType} | view=${report.calendar.view ?? "unknown"} | timezone=${report.calendar.timezone} | observedAt=${report.calendar.observedAt} | lastSyncedAt=${report.calendar.lastSyncedAt ?? "unknown"} | ${report.calendar.resultStatus} | items=${report.calendar.itemCount} | sources=${report.calendar.sourceCount} | calendars=${report.calendar.calendarCount} | sourceStatus=${report.calendar.sourceStatus ?? "unknown"} | cache=${report.calendar.cacheUsed} | fallback=${report.calendar.fallbackUsed}`,
    ...report.calendarReads.map((item) => `calendarRead: ${item.scopeType} | ${item.fromDate}..${item.toDate} | ${item.view ?? "unknown"} | ${item.resultStatus} | items=${item.itemCount} | observedAt=${item.observedAt}`),
    `mutationGates: writes=${report.mutationGates.writesEnabled} | coffee=${report.mutationGates.coffeeActionsEnabled} | planningReminders=${report.mutationGates.planningReminderMutationsEnabled} | planningTasks=${report.mutationGates.planningTaskMutationsEnabled} | planningCalendar=${report.mutationGates.planningCalendarMutationsEnabled}`,
    `recentTransitions: ${report.recentTransitions.length}`,
    ...report.recentTransitions.map((item) => `transition: ${item.subsystem} | ${item.fromState ?? "none"}->${item.toState} | current=${item.current}`),
    ...report.collectorStatus.map((item) => `collector: ${item.collector} | ${item.status}${item.code ? ` | ${item.code}` : ""}`)
  ];
  return lines.join("\n");
}

export async function copyDiagnosticsText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | null | undefined
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
