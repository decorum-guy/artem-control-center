export function isOverviewV2Enabled(value: unknown): boolean {
  return value === "true";
}

/** Production-safe rollout gate. PR3 is opt-in until the grid foundation is reviewed. */
export const overviewV2Enabled = isOverviewV2Enabled(import.meta.env.VITE_OVERVIEW_V2_ENABLED);
