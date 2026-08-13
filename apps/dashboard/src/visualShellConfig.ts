export function isVisualShellEnabled(value: unknown): boolean {
  return value === "true";
}

/** Production-safe rollout gate. The V2 shell is opt-in until screenshot review. */
export const v2VisualShellEnabled = isVisualShellEnabled(import.meta.env.VITE_V2_VISUAL_SHELL);
