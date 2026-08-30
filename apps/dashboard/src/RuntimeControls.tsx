import { useCallback, useEffect, useState } from "react";
import { AccessSettingsPanel, useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import {
  UPDATE_ACTIVITY_COPY,
  isActiveUpdateState,
  observePanelUpdate,
  resolvePanelUpdateState,
  updateProgressPercent,
  type ProductionBuildIdentity,
  type UpdateActivityEvent,
  type UpdateOwnerState,
  type UpdateObserverEvent
} from "./runtimeUpdateObserver";
import {
  clearRuntimeShutdownPending,
  markRuntimeShutdownPending
} from "./runtimeLifecycle";
import "./RuntimeControls.css";

type RuntimeAction = "hide" | "shutdown";
export type RuntimeAvailability = "loading" | "available" | "unavailable";

type UpdateDialogState = "closed" | "checking" | "ready" | "applying" | "reconnecting" | "error";

interface PanelUpdateCheck {
  schemaVersion: "panel-update.v1";
  currentHead: string | null;
  targetHead: string | null;
  updateAvailable: boolean;
  updateAllowed: boolean;
  status: "update_available" | "up_to_date" | "blocked";
  reason: string | null;
}

export interface RuntimeStatus {
  enabled: boolean;
  platform: string;
  revision?: string;
}

const updateReasonCopy: Record<string, string> = {
  wrong_branch: "Панель запущена не из основной версии. Обновление остановлено.",
  dirty_checkout: "В локальной копии есть несохранённые изменения. Обновление остановлено.",
  diverged: "История локальной версии расходится с основной. Нужна ручная проверка.",
  fetch_failed: "Не удалось проверить обновления. Проверьте подключение и повторите попытку.",
  invalid_repository: "Не удалось проверить состояние установки панели.",
  capability_apply_active: "Сейчас применяется конфигурация панели. Обновление можно запустить после завершения.",
  update_in_progress: "Обновление панели уже выполняется."
};

const UPDATE_STATUS_POLL_MS = 750;

function updateFailureCopy(result?: string): string {
  if (result === "rollback_restored") {
    return "Обновление не установлено. Предыдущая версия восстановлена.";
  }
  if (result === "rollback_failed") {
    return "Обновление завершилось ошибкой. Нужна проверка установки.";
  }
  if (result === "updater_stale") {
    return "Обновление остановилось без подтверждённого результата. Нужна проверка установки.";
  }
  return "Обновление не завершено. Повторите попытку или проверьте установку панели.";
}

function updateObserverFailureCopy(reason: "served_mismatch" | "served_unverified"): string {
  return reason === "served_mismatch"
    ? "Обновление завершилось, но панель обслуживает другую версию. Нужна проверка установки."
    : "Обновление завершилось, но целевая версия панели не подтверждена. Нужна проверка установки.";
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

async function fetchUpdateStatus(): Promise<UpdateOwnerState> {
  const response = await fetch("/api/v1/system/update/status", { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`Update status failed: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<UpdateOwnerState>;
}

async function fetchProductionBuild(): Promise<ProductionBuildIdentity> {
  const response = await fetch("/api/v1/system/production-build", { cache: "no-store" });
  if (!response.ok) throw new Error(`Production build identity failed: ${response.status}`);
  const identity = await response.json() as Partial<ProductionBuildIdentity>;
  if (
    identity.schemaVersion !== "dashboard-build.v1"
    || typeof identity.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(identity.revision)
    || identity.profile !== "accepted-v2"
    || identity.buildId !== `${identity.revision}:accepted-v2`
  ) {
    throw new Error("production_build_identity_invalid");
  }
  return identity as ProductionBuildIdentity;
}

function updateCheckFromOwnerState(state: UpdateOwnerState): PanelUpdateCheck | null {
  if (!state.currentHead || !state.targetHead) return null;
  return {
    schemaVersion: "panel-update.v1",
    currentHead: state.currentHead,
    targetHead: state.targetHead,
    updateAvailable: state.currentHead !== state.targetHead,
    updateAllowed: false,
    status: state.currentHead === state.targetHead ? "up_to_date" : "update_available",
    reason: "update_in_progress"
  };
}

function safeActivityEvents(events: UpdateActivityEvent[] | undefined): UpdateActivityEvent[] {
  if (!Array.isArray(events)) return [];
  return events
    .slice(-32)
    .filter((event): event is UpdateActivityEvent => {
      return Boolean(
        event
        && typeof event === "object"
        && typeof event.code === "string"
        && Object.prototype.hasOwnProperty.call(UPDATE_ACTIVITY_COPY, event.code)
      );
    });
}

function progressPhaseCopy(state: UpdateOwnerState | null, dialog: UpdateDialogState): string {
  if (dialog === "reconnecting") return "Переподключаемся к панели";
  if (state?.phase && Object.prototype.hasOwnProperty.call(UPDATE_ACTIVITY_COPY, state.phase)) {
    return UPDATE_ACTIVITY_COPY[state.phase];
  }
  if (state?.status === "success") return "Проверяем результат";
  if (state?.status === "failed") return "Обновление остановлено";
  return "Ожидаем состояние обновления";
}

export function useRuntimeStatus(): {
  availability: RuntimeAvailability;
  runtimeRevision: string | undefined;
} {
  const [availability, setAvailability] = useState<RuntimeAvailability>("loading");
  const [runtimeRevision, setRuntimeRevision] = useState<string | undefined>();

  useEffect(() => {
    let active = true;

    void fetch("/api/v1/system/runtime", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Runtime status failed: ${response.status}`);
        return response.json() as Promise<RuntimeStatus>;
      })
      .then((status) => {
        if (active) {
          setRuntimeRevision(status.revision);
          setAvailability(status.enabled ? "available" : "unavailable");
        }
      })
      .catch(() => {
        if (active) setAvailability("unavailable");
      });

    return () => {
      active = false;
    };
  }, []);

  return { availability, runtimeRevision };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runtimeIsStillReachable(delayMs = 1_000) {
  await wait(delayMs);
  try {
    const response = await fetch("/health/live", { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export function RuntimeControls({
  variant = "settings"
}: {
  variant?: "settings" | "system-v2";
} = {}) {
  const { confirmAction } = useActionConfirmation();
  const { guardMutation, locked } = useInteractionLock();
  const { status: accessStatus, refresh: refreshAccess } = useAccess();
  const { availability, runtimeRevision } = useRuntimeStatus();
  const [pending, setPending] = useState<RuntimeAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>("closed");
  const [updateCheck, setUpdateCheck] = useState<PanelUpdateCheck | null>(null);
  const [updateOwnerState, setUpdateOwnerState] = useState<UpdateOwnerState | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateAccepted, setUpdateAccepted] = useState(false);

  const handleUpdateObserverEvent = useCallback((event: UpdateObserverEvent) => {
    if (event.type === "active") {
      setUpdateOwnerState(event.state);
      setUpdateCheck((current) => current ?? updateCheckFromOwnerState(event.state));
      setUpdateAccepted(true);
      setUpdateDialog("applying");
      setUpdateMessage("Обновление выполняется… Панель откроется снова после завершения.");
      return;
    }
    if (event.type === "reconnecting") {
      setUpdateDialog("reconnecting");
      setUpdateMessage("Обновление выполняется. Переподключаемся к панели…");
      return;
    }
    if (event.type === "idle") {
      setUpdateOwnerState(event.state);
      setUpdateAccepted(false);
      setUpdateDialog("error");
      setUpdateMessage("Обновление не было запущено. Проверьте состояние панели и повторите попытку.");
      return;
    }
    setUpdateAccepted(false);
    if (event.type === "failure") {
      setUpdateOwnerState(event.state);
      setUpdateDialog("error");
      setUpdateMessage(
        event.reason === "served_mismatch" || event.reason === "served_unverified"
          ? updateObserverFailureCopy(event.reason)
          : updateFailureCopy(event.state.result)
      );
      return;
    }
    setUpdateOwnerState(event.state);
    setUpdateDialog("closed");
    setUpdateCheck(null);
    setUpdateMessage(null);
    setNotice(
      event.state.result === "up_to_date"
        ? "Установлена последняя версия панели."
        : "Обновление панели завершено."
    );
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;

    const discover = (allowPassiveRetry: boolean) => {
      void fetchUpdateStatus()
        .then(async (state) => {
          if (!active) return;
          if (isActiveUpdateState(state)) {
            setUpdateOwnerState(state);
            setUpdateCheck(updateCheckFromOwnerState(state));
            setUpdateAccepted(true);
            setUpdateDialog("applying");
            setUpdateMessage("Обновление выполняется… Панель откроется снова после завершения.");
            return;
          }
          const event = await resolvePanelUpdateState(state, fetchProductionBuild);
          if (!active) return;
          if (event.type === "idle") return;
          if (event.type === "failure") {
            setNotice(
              event.reason === "served_mismatch" || event.reason === "served_unverified"
                ? updateObserverFailureCopy(event.reason)
                : updateFailureCopy(event.state.result)
            );
            return;
          }
          if (event.type === "success") {
            setNotice(
              state.result === "up_to_date"
                ? "Установлена последняя версия панели."
                : "Обновление панели завершено."
            );
          }
        })
        .catch((error: unknown) => {
          if (!active) return;
          const status = error instanceof Error && "status" in error && typeof error.status === "number"
            ? error.status
            : null;
          // Passive discovery must not imply that an update exists. A single
          // silent retry can recover an active transaction during startup,
          // while a second failure leaves the normal controls untouched.
          if (!allowPassiveRetry || (status !== null && status < 500)) return;
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            discover(false);
          }, UPDATE_STATUS_POLL_MS);
        });
    };

    discover(true);
    return () => {
      active = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (locked && updateDialog !== "closed") {
      setUpdateAccepted(false);
      setUpdateDialog("closed");
      setUpdateCheck(null);
      setUpdateOwnerState(null);
      setUpdateMessage(null);
    }
  }, [locked, updateDialog]);

  useEffect(() => {
    if (!updateAccepted || !["applying", "reconnecting"].includes(updateDialog)) return;

    return observePanelUpdate({
      fetchStatus: fetchUpdateStatus,
      fetchBuild: fetchProductionBuild,
      pollMs: UPDATE_STATUS_POLL_MS,
      onEvent: handleUpdateObserverEvent
    });
  }, [handleUpdateObserverEvent, updateAccepted, updateDialog]);

  async function runAction(action: RuntimeAction) {
    if (!guardMutation()) return;
    if (pending || availability !== "available") return;

    if (action === "shutdown") {
      const confirmation = await confirmAction("system.runtime.shutdown", { revision: runtimeRevision });
      if (!confirmation.confirmed) return;
    }

    if (!guardMutation()) return;
    setPending(action);
    setNotice(action === "hide" ? "Скрываем панель…" : "Завершаем работу платформы…");

    if (action === "shutdown") {
      markRuntimeShutdownPending();
    }

    let responseReceived = false;
    try {
      const response = await fetch(`/api/v1/system/runtime/${action}`, {
        method: "POST",
        headers: { "x-panel-intent": "kiosk-control" },
        keepalive: action === "shutdown"
      });
      responseReceived = true;
      if (!response.ok) throw new Error(`Runtime action failed: ${response.status}`);

      if (action === "shutdown") {
        const stillReachable = await runtimeIsStillReachable(7_000);
        if (!stillReachable) {
          setNotice("Платформа остановлена. Закрываем окно…");
          window.close();
          return;
        }

        clearRuntimeShutdownPending();
        setPending(null);
        setNotice("Команда принята, но панель не остановилась. Повторите попытку или используйте ярлык Stop Control Center.");
        return;
      }

      await wait(3_000);
      if (!document.hidden) {
        setPending(null);
        setNotice("Команда принята, но окно не закрылось. Повторите попытку.");
      }
    } catch {
      if (action === "shutdown" && !responseReceived && !(await runtimeIsStillReachable())) return;
      if (action === "shutdown") clearRuntimeShutdownPending();
      setPending(null);
      setNotice("Действие не выполнено. Проверьте панель и повторите попытку.");
    }
  }

  async function checkForUpdate() {
    setUpdateAccepted(false);
    setUpdateDialog("checking");
    setUpdateCheck(null);
    setUpdateOwnerState(null);
    setUpdateMessage(null);
    try {
      const response = await fetch("/api/v1/system/update/check", {
        method: "POST",
        headers: { "x-panel-intent": "panel-update" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("update_check_failed");
      const payload = await response.json() as PanelUpdateCheck;
      setUpdateCheck(payload);
      setUpdateDialog("ready");
      if (payload.status === "up_to_date") {
        setUpdateMessage("Установлена последняя версия");
      } else if (!payload.updateAllowed) {
        setUpdateMessage(updateReasonCopy[payload.reason ?? ""] ?? "Обновление сейчас недоступно.");
      }
    } catch {
      setUpdateDialog("error");
      setUpdateMessage("Не удалось проверить обновления. Повторите попытку.");
    }
  }

  function openUpdateDialog() {
    if (!guardMutation()) return;
    if (pending || availability !== "available") return;
    void checkForUpdate();
  }

  async function applyUpdate() {
    if (!guardMutation() || updateDialog !== "ready" || !updateCheck) return;
    if (!updateCheck.updateAllowed || !updateCheck.updateAvailable) return;
    if (!updateCheck.currentHead || !updateCheck.targetHead) return;

    const freshAccess = await refreshAccess();
    if (!guardMutation()) return;
    if (!freshAccess || freshAccess.effectiveProfile !== "full") {
      setUpdateMessage("Для обновления нужен Полный доступ.");
      return;
    }

    setUpdateAccepted(false);
    setUpdateDialog("applying");
    setUpdateOwnerState(null);
    setUpdateMessage("Запускаем обновление…");
    let responseReceived = false;
    try {
      const response = await fetch("/api/v1/system/update/apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-panel-intent": "panel-update"
        },
        body: JSON.stringify({
          expectedCurrentHead: updateCheck.currentHead,
          expectedTargetHead: updateCheck.targetHead
        })
      });
      responseReceived = true;
      if (response.status === 409) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        if (payload.detail === "update_target_changed") {
          setUpdateMessage("Версии изменились. Проверяем обновления ещё раз…");
          await checkForUpdate();
          return;
        }
      }
      if (!response.ok) throw new Error("update_apply_failed");
      setUpdateAccepted(true);
      setUpdateMessage("Запускаем обновление… Панель откроется снова после завершения.");
    } catch {
      if (!responseReceived) {
        // A lost response does not prove that the server rejected the update.
        // Rejoin the durable observer and let the update lease/state decide.
        setUpdateAccepted(true);
        setUpdateDialog("reconnecting");
        setUpdateMessage("Обновление запускается. Переподключаемся к панели…");
        return;
      }
      setUpdateAccepted(false);
      setUpdateDialog("error");
      setUpdateMessage("Не удалось запустить обновление. Панель не была изменена.");
    }
  }

  const disabled = availability !== "available" || pending !== null || updateDialog !== "closed";
  const fullAccess = accessStatus?.effectiveProfile === "full";
  const canApplyUpdate = Boolean(
    updateDialog === "ready"
    && updateCheck?.updateAllowed
    && updateCheck?.updateAvailable
    && updateCheck.currentHead
    && updateCheck.targetHead
    && fullAccess
  );
  const updateProgress = updateProgressPercent(updateOwnerState);
  const updateActivity = safeActivityEvents(updateOwnerState?.events);
  const showUpdateProgress = ["applying", "reconnecting", "error"].includes(updateDialog) || updateOwnerState !== null;

  return (
    <>
      {variant === "settings" && <AccessSettingsPanel />}
      <section
        className={`settings-section runtime-controls${variant === "system-v2" ? " system-runtime-zone" : ""}`}
        aria-labelledby="runtime-controls-title"
        data-testid={variant === "system-v2" ? "system-runtime-zone" : undefined}
      >
        <div className="runtime-controls-copy">
          <h2 id="runtime-controls-title">Управление панелью</h2>
          <p>{variant === "system-v2" ? "Системные действия панели." : "Скрытие закрывает окно. Панель можно вернуть ярлыком запуска."}</p>
          {availability === "unavailable" && (
            <span className="runtime-controls-status">Системные действия недоступны на этом устройстве.</span>
          )}
          {notice && <span className="runtime-controls-status" role="status">{notice}</span>}
        </div>
        <div className="runtime-control-actions">
          <button className="runtime-hide-button" type="button" disabled={disabled} onClick={() => void runAction("hide")}>
            {pending === "hide" ? "Скрываем…" : "Скрыть панель"}
          </button>
          <button className="runtime-update-button" type="button" disabled={disabled} onClick={openUpdateDialog}>
            Обновить панель
          </button>
          <button className="runtime-shutdown-button" type="button" disabled={disabled} onClick={() => void runAction("shutdown")}>
            {pending === "shutdown" ? "Закрываем…" : "Полностью закрыть"}
          </button>
        </div>
      </section>

      {updateDialog !== "closed" && !locked && (
        <div className="action-confirmation-backdrop" role="presentation">
          <section
            className="action-confirmation runtime-update-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-update-title"
            aria-describedby="runtime-update-description"
            data-testid="runtime-update-dialog"
          >
            <div className="action-confirmation__header">
              <div>
                <p className="action-confirmation__kicker">Обновление панели</p>
                <h2 id="runtime-update-title">Обновить панель</h2>
              </div>
            </div>
            <p id="runtime-update-description" className="action-confirmation__description">
              {updateDialog === "checking"
                ? "Проверяем обновления…"
                : ["applying", "reconnecting"].includes(updateDialog)
                  ? "Обновление выполняется. Можно закрыть это окно — отмена не прерывает обновление."
                  : "Проверенная версия будет установлена только после вашего подтверждения."}
            </p>

            {updateCheck && (
              <div className="runtime-update-versions">
                <div><span>Текущая версия</span><strong>{shortSha(updateCheck.currentHead)}</strong></div>
                <div><span>После обновления</span><strong>{shortSha(updateCheck.targetHead)}</strong></div>
              </div>
            )}

            {updateMessage && <p className="runtime-update-message" role="status">{updateMessage}</p>}
            {!fullAccess && updateDialog === "ready" && updateCheck?.updateAvailable && updateCheck.updateAllowed && (
              <p className="runtime-update-message">Для установки включите Полный доступ.</p>
            )}

            {showUpdateProgress && (
              <div className="runtime-update-progress" data-testid="runtime-update-progress">
                <div className="runtime-update-progress__summary">
                  <div>
                    <span>Состояние обновления</span>
                    <strong data-testid="runtime-update-phase">{progressPhaseCopy(updateOwnerState, updateDialog)}</strong>
                  </div>
                  <strong data-testid="runtime-update-percent">{updateProgress}%</strong>
                </div>
                <div
                  className="runtime-update-progress__track"
                  role="progressbar"
                  aria-label="Прогресс обновления"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updateProgress}
                >
                  <span style={{ width: `${updateProgress}%` }} />
                </div>
                <div className="runtime-update-activity" aria-label="Активность обновления">
                  <span>Активность</span>
                  <ol data-testid="runtime-update-activity">
                    {updateActivity.length > 0
                      ? updateActivity.map((event, index) => (
                        <li key={`${event.code}-${index}`}>{UPDATE_ACTIVITY_COPY[event.code]}</li>
                      ))
                      : <li>Ожидаем подтверждённую фазу обновления</li>}
                  </ol>
                </div>
              </div>
            )}

            <div className="action-confirmation__actions">
              <button
                type="button"
                className="action-confirmation__cancel"
                disabled={updateDialog === "applying"}
                onClick={() => {
                  setUpdateAccepted(false);
                  setUpdateDialog("closed");
                  setUpdateCheck(null);
                  setUpdateOwnerState(null);
                  setUpdateMessage(null);
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                className="action-confirmation__confirm"
                disabled={!canApplyUpdate || updateDialog === "applying"}
                onClick={() => void applyUpdate()}
              >
                {updateDialog === "applying" ? "Запускаем…" : "Обновить"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
