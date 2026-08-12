/** Production-safe rollout gate. Fixture/e2e runs opt in with VITE_PLANNING_OVERVIEW_ENABLED=true. */
export const planningOverviewEnabled = import.meta.env.VITE_PLANNING_OVERVIEW_ENABLED === "true";
