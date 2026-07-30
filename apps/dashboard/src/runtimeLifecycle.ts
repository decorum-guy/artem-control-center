const RUNTIME_SHUTDOWN_PENDING_KEY = "artem.runtime.shutdown-pending";

export function markRuntimeShutdownPending() {
  window.sessionStorage.setItem(RUNTIME_SHUTDOWN_PENDING_KEY, "1");
}

export function clearRuntimeShutdownPending() {
  window.sessionStorage.removeItem(RUNTIME_SHUTDOWN_PENDING_KEY);
}

export function isRuntimeShutdownPending() {
  return window.sessionStorage.getItem(RUNTIME_SHUTDOWN_PENDING_KEY) === "1";
}
