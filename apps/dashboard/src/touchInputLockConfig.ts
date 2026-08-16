/**
 * The interaction guard is deliberately opt-in at build time.  Production
 * rollout is enabled later, after V2 stabilization; an enabled kiosk build
 * starts locked unless its explicit test/dev build opts out.
 */
export const interactionLockEnabled = import.meta.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true";
export const interactionLockStartsLocked = interactionLockEnabled
  && import.meta.env.VITE_TOUCH_INPUT_LOCK_START_LOCKED !== "false";
