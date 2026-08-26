/**
 * The single maintained frontend profile used by the Windows production build.
 *
 * The source gates stay explicit so fixture/e2e jobs can still exercise both
 * sides of each rollout seam. Production is deterministic: the guarded
 * updater invokes build:production, which applies this complete profile and
 * does not depend on a Samsung-local VITE environment.
 */
export const productionBuildProfile = Object.freeze({
  VITE_V2_VISUAL_SHELL: "true",
  VITE_OVERVIEW_V2_ENABLED: "true",
  VITE_OVERVIEW_EDITOR_ENABLED: "true",
  VITE_PLANNING_OVERVIEW_ENABLED: "true",
  VITE_PLANNING_TASKS_ROUTE_ENABLED: "true",
  VITE_PLANNING_CALENDAR_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDERS_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDER_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_TASK_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_START_LOCKED: "true"
});

export const productionBuildProfileName = "accepted-v2";

export const delayedBuildCapabilityVariables = Object.freeze({
  planning_overview: "VITE_PLANNING_OVERVIEW_ENABLED",
  planning_tasks_route: "VITE_PLANNING_TASKS_ROUTE_ENABLED",
  planning_calendar_route: "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
  planning_reminders_route: "VITE_PLANNING_REMINDERS_ROUTE_ENABLED"
});

export function safeDelayedCapabilityOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)
    ? value.overrides
    : value;
  return Object.fromEntries(
    Object.keys(delayedBuildCapabilityVariables)
      .filter((key) => typeof raw[key] === "boolean")
      .map((key) => [key, raw[key]])
  );
}

export function productionBuildCapabilities(overrides = {}) {
  const safe = safeDelayedCapabilityOverrides(overrides);
  const baseline = Object.fromEntries(
    Object.entries(delayedBuildCapabilityVariables).map(([id, variable]) => [id, productionBuildProfile[variable] === "true"])
  );
  return {
    baseline,
    active: { ...baseline, ...safe }
  };
}

export function productionBuildEnvironment(baseEnvironment = process.env, overrides = {}) {
  const capabilities = productionBuildCapabilities(overrides);
  return {
    ...baseEnvironment,
    ...productionBuildProfile,
    ...Object.fromEntries(
      Object.entries(delayedBuildCapabilityVariables).map(([id, variable]) => [variable, String(capabilities.active[id])])
    )
  };
}
