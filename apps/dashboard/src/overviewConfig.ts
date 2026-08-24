export function isOverviewV2Enabled(value: unknown): boolean {
  return value === "true";
}

export function isOverviewEditorEnabled(value: unknown): boolean {
  return value === "true";
}

/** Build seams retained for legacy/test bundles; accepted-v2 sets both true. */
export const overviewV2Enabled = isOverviewV2Enabled(import.meta.env.VITE_OVERVIEW_V2_ENABLED);
export const overviewEditorEnabled = isOverviewEditorEnabled(import.meta.env.VITE_OVERVIEW_EDITOR_ENABLED);
