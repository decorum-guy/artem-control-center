export type UpdateOwnerStatus = "idle" | "checking" | "updating" | "success" | "failed";
export type UpdateOwnerPhase =
  | "started"
  | "preparing"
  | "installing"
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
  | "target_handoff_lease_rejected"
  | "updater_spawn_failed"
  | "updater_early_exit"
  | "updater_stale";

export type UpdateActivityCode = UpdateOwnerPhase | "completed";

export interface UpdateActivityEvent {
  code: UpdateActivityCode;
}

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
  progressPercent?: number;
  events?: UpdateActivityEvent[];
}

export const UPDATE_ACTIVITY_COPY: Record<UpdateActivityCode, string> = {
  started: "Проверяем обновление",
  preparing: "Готовим изолированную новую версию",
  installing: "Устанавливаем зависимости новой версии",
  stopping: "Останавливаем текущую панель",
  checkout: "Переключаем подготовленную версию",
  handoff: "Передаём управление новой версии обновлятора",
  "target-authoritative": "Новая версия обновлятора приняла управление",
  validating: "Проверяем проект",
  building: "Собираем панель",
  "artifact-ready": "Новая сборка готова к переключению",
  restarting: "Перезапускаем Control Center",
  verifying: "Проверяем запущенную версию",
  rollback: "Восстанавливаем предыдущую версию",
  completed: "Обновление завершено"
};

const UPDATE_PHASE_PROGRESS: Record<UpdateOwnerPhase, number> = {
  started: 5,
  preparing: 15,
  installing: 30,
  stopping: 80,
  checkout: 84,
  handoff: 86,
  "target-authoritative": 88,
  validating: 50,
  building: 66,
  "artifact-ready": 78,
  restarting: 91,
  verifying: 95,
  rollback: 60
};

export function updateProgressPercent(state: UpdateOwnerState | null): number {
  if (!state) return 0;
  const progressPercent = state.progressPercent;
  if (typeof progressPercent === "number" && Number.isInteger(progressPercent) && progressPercent >= 0 && progressPercent <= 100) {
    return progressPercent;
  }
  if (state.status === "success") return 95;
  return state.phase ? UPDATE_PHASE_PROGRESS[state.phase] : 0;
}

export function updateActivityCopy(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(UPDATE_ACTIVITY_COPY, code)
    ? UPDATE_ACTIVITY_COPY[code as UpdateActivityCode]
    : null;
}

export interface ProductionBuildIdentity {
  schemaVersion: "dashboard-build.v1";
  revision: string;
  profile: "accepted-v2";
  buildId: string;
}

export type UpdateObserverEvent =
  | { type: "active"; state: UpdateOwnerState }
  | { type: "idle"; state: UpdateOwnerState }
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
  // Idle is neutral during passive startup. An active observer can interpret
  // this event as a not-accepted apply, but ordinary startup must not report a
  // failed update when the owner never requested one.
  return { type: "idle", state };
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
      if (event.type === "success" || event.type === "failure" || event.type === "idle") return;
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
