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

export function productionBuildEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    ...productionBuildProfile
  };
}
