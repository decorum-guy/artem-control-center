export type UpdateOwnerStatus = "idle" | "checking" | "updating" | "success" | "failed";
export type UpdateOwnerPhase =
  | "started"
  | "stopping"
  | "checkout"
  | "handoff"
  | "target-authoritative"
  | "validating"
  | "building"
  | "artifact-ready"
  | "restarting"
  | "verifying"
  | "rollback";
export type UpdateOwnerResult =
  | "up_to_date"
  | "updated"
  | "rollback_restored"
  | "rollback_failed"
  | "pre_update_failed"
  | "invalid_update_command"
  | "updater_unavailable"
  | "capability_apply_active"
  | "update_lock_mismatch"
  | "build_failed"
  | "artifact_assertion_failed"
  | "served_artifact_mismatch"
  | "restart_failed"
  | "repair_required"
  | "updater_stale";

export interface UpdateOwnerState {
  schemaVersion: 1;
  status: UpdateOwnerStatus;
  result?: UpdateOwnerResult;
  requestId?: string;
  currentHead?: string;
  targetHead?: string;
  phase?: UpdateOwnerPhase;
  startedAt?: string;
  updatedAt?: string;
  servedRevision?: string;
}

export interface ProductionBuildIdentity {
  schemaVersion: "dashboard-build.v1";
  revision: string;
  profile: "accepted-v2";
  buildId: string;
}

export type UpdateObserverEvent =
  | { type: "active"; state: UpdateOwnerState }
  | { type: "waiting"; state: UpdateOwnerState }
  | { type: "reconnecting" }
  | { type: "success"; state: UpdateOwnerState }
  | {
      type: "failure";
      state: UpdateOwnerState;
      reason: "authoritative" | "served_mismatch" | "served_unverified";
    };

export function isActiveUpdateState(state: UpdateOwnerState): boolean {
  return state.status === "checking" || state.status === "updating";
}

export async function resolvePanelUpdateState(
  state: UpdateOwnerState,
  fetchBuild: () => Promise<ProductionBuildIdentity>
): Promise<UpdateObserverEvent> {
  if (isActiveUpdateState(state)) return { type: "active", state };
  if (state.status === "failed") {
    return { type: "failure", state, reason: "authoritative" };
  }
  if (state.status === "success") {
    // An update terminal result is only owner-visible success after the
    // intended target is confirmed by the served build identity. The
    // up-to-date check is the one normal terminal flow with no target: it did
    // not change the installation, so there is no update target to verify.
    if (state.result === "updated" && !state.targetHead) {
      return { type: "failure", state, reason: "served_unverified" };
    }
    if (state.targetHead) {
      if (state.servedRevision && state.servedRevision !== state.targetHead) {
        return { type: "failure", state, reason: "served_mismatch" };
      }
      const served = await fetchBuild();
      if (served.revision !== state.targetHead) {
        return { type: "failure", state, reason: "served_mismatch" };
      }
    }
    return { type: "success", state };
  }
  return { type: "waiting", state };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PanelUpdateObserverOptions {
  fetchStatus: () => Promise<UpdateOwnerState>;
  fetchBuild: () => Promise<ProductionBuildIdentity>;
  onEvent: (event: UpdateObserverEvent) => void;
  pollMs?: number;
  initialDelayMs?: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn?: (timer: TimerHandle) => void;
}

/**
 * Observe the server-owned update transaction until it reaches a terminal
 * result. There is intentionally no browser elapsed-time deadline: an active
 * lease remains active even when the updater takes several minutes.
 */
export function observePanelUpdate({
  fetchStatus,
  fetchBuild,
  onEvent,
  pollMs = 750,
  initialDelayMs = 250,
  setTimeoutFn = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutFn = (timer) => clearTimeout(timer)
}: PanelUpdateObserverOptions): () => void {
  let disposed = false;
  let timer: TimerHandle | null = null;

  const schedule = (delayMs: number) => {
    if (!disposed) timer = setTimeoutFn(() => void poll(), delayMs);
  };

  const poll = async () => {
    if (disposed) return;
    try {
      const state = await fetchStatus();
      if (disposed) return;
      const event = await resolvePanelUpdateState(state, fetchBuild);
      if (disposed) return;
      onEvent(event);
      if (event.type === "success" || event.type === "failure") return;
      schedule(pollMs);
    } catch {
      if (disposed) return;
      onEvent({ type: "reconnecting" });
      schedule(pollMs);
    }
  };

  schedule(initialDelayMs);
  return () => {
    disposed = true;
    if (timer !== null) clearTimeoutFn(timer);
  };
}
