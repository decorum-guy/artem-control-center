/** Independent B3 rollout gates. All three stay off unless explicitly enabled. */
export const planningTasksRouteEnabled = import.meta.env.VITE_PLANNING_TASKS_ROUTE_ENABLED === "true";
export const planningCalendarRouteEnabled = import.meta.env.VITE_PLANNING_CALENDAR_ROUTE_ENABLED === "true";
export const planningRemindersRouteEnabled = import.meta.env.VITE_PLANNING_REMINDERS_ROUTE_ENABLED === "true";

export const planningRouteLimit = 20;

