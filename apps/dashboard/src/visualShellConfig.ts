export function isVisualShellEnabled(value: unknown): boolean {
  return value === "true";
}

/** Build seam retained for legacy/test bundles; accepted-v2 sets this true. */
export const v2VisualShellEnabled = isVisualShellEnabled(import.meta.env.VITE_V2_VISUAL_SHELL);
