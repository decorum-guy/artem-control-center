import { useEffect, useState } from "react";

/**
 * Owner-facing source warnings intentionally require a continuous observation.
 * The raw provider state remains available to diagnostics and data reads; this
 * hook only controls when that state becomes visible in the panel.
 */
export const PLANNING_WARNING_DWELL_MS = 3_500;
export const PLANNING_WARNING_RECOVERY_DWELL_MS = 1_800;

export function useOwnerWarningDwell<T extends string>(candidate: T | null): T | null {
  const [visibleCandidate, setVisibleCandidate] = useState<T | null>(null);

  useEffect(() => {
    if (candidate !== null) {
      if (visibleCandidate !== null) {
        if (visibleCandidate !== candidate) setVisibleCandidate(candidate);
        return;
      }

      const timer = window.setTimeout(() => setVisibleCandidate(candidate), PLANNING_WARNING_DWELL_MS);
      return () => window.clearTimeout(timer);
    }

    if (visibleCandidate === null) return;
    const timer = window.setTimeout(() => setVisibleCandidate(null), PLANNING_WARNING_RECOVERY_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [candidate, visibleCandidate]);

  return visibleCandidate;
}
