import { planningOverviewEnabled } from "./planningOverviewConfig";
import { planningModuleForRoute, type PlanningModuleDefinition, type PlanningRoutePath, type PlanningRolloutGate } from "./planningModuleRegistry";

/** Independent route seams retained for legacy/test bundles; accepted-v2 sets all true. */
export const planningTasksRouteEnabled = import.meta.env.VITE_PLANNING_TASKS_ROUTE_ENABLED === "true";
export const planningCalendarRouteEnabled = import.meta.env.VITE_PLANNING_CALENDAR_ROUTE_ENABLED === "true";
export const planningRemindersRouteEnabled = import.meta.env.VITE_PLANNING_REMINDERS_ROUTE_ENABLED === "true";
/** B4 writer seam retained for legacy/test bundles; accepted-v2 sets this true. */
export const planningReminderMutationsEnabled = import.meta.env.VITE_PLANNING_REMINDER_MUTATIONS_ENABLED === "true";
/** B4.2 writer seam retained for legacy/test bundles; accepted-v2 sets this true. */
export const planningTaskMutationsEnabled = import.meta.env.VITE_PLANNING_TASK_MUTATIONS_ENABLED === "true";
/** B4.3 writer seam retained for legacy/test bundles; accepted-v2 sets this true. */
export const planningCalendarMutationsEnabled = import.meta.env.VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED === "true";

export const planningRouteLimit = 20;

const rolloutFlags: Record<PlanningRolloutGate, boolean> = {
  tasks: planningTasksRouteEnabled,
  calendar: planningCalendarRouteEnabled,
  reminders: planningRemindersRouteEnabled,
  overview: planningOverviewEnabled
};

export function planningModuleEnabled(module: PlanningModuleDefinition): boolean {
  return rolloutFlags[module.rollout];
}

export function planningRouteEnabled(route: PlanningRoutePath): boolean {
  const module = planningModuleForRoute(route);
  return module ? planningModuleEnabled(module) : false;
}
