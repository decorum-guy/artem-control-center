/**
 * The interaction guard remains a small build seam for legacy/test bundles.
 * The maintained accepted-v2 production profile enables it and starts the
 * kiosk locked; runtime actions still pass through the server policy.
 */
export const interactionLockEnabled = import.meta.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true";
export const interactionLockStartsLocked = interactionLockEnabled
  && import.meta.env.VITE_TOUCH_INPUT_LOCK_START_LOCKED !== "false";
