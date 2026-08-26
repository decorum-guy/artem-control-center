import { useEffect, useState } from "react";
import { AccessSettingsPanel, useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import {
  clearRuntimeShutdownPending,
  markRuntimeShutdownPending
} from "./runtimeLifecycle";
import "./RuntimeControls.css";

type RuntimeAction = "hide" | "shutdown";
export type RuntimeAvailability = "loading" | "available" | "unavailable";

type UpdateDialogState = "closed" | "checking" | "ready" | "applying" | "error";

interface PanelUpdateCheck {
  schemaVersion: "panel-update.v1";
  currentHead: string | null;
  targetHead: string | null;
  updateAvailable: boolean;
  updateAllowed: boolean;
  status: "update_available" | "up_to_date" | "blocked";
  reason: string | null;
}

interface PanelUpdateOwnerState {
  schemaVersion: 1;
  status: "idle" | "checking" | "updating" | "success" | "failed";
  result?: string;
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

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
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
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/system/update/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<PanelUpdateOwnerState>;
      })
      .then((state) => {
        if (!active || !state) return;
        if (state.status === "failed" && state.result === "rollback_restored") {
          setNotice("Последнее обновление не установлено. Предыдущая версия восстановлена.");
        } else if (state.status === "failed") {
          setNotice("Последнее обновление завершилось ошибкой. Нужна проверка установки.");
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (locked && updateDialog !== "closed") {
      setUpdateDialog("closed");
      setUpdateCheck(null);
      setUpdateMessage(null);
    }
  }, [locked, updateDialog]);

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
    setUpdateDialog("checking");
    setUpdateCheck(null);
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

    setUpdateDialog("applying");
    setUpdateMessage("Запускаем обновление…");
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
      if (response.status === 409) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        if (payload.detail === "update_target_changed") {
          setUpdateMessage("Версии изменились. Проверяем обновления ещё раз…");
          await checkForUpdate();
          return;
        }
      }
      if (!response.ok) throw new Error("update_apply_failed");
      setUpdateMessage("Запускаем обновление… Панель откроется снова после завершения.");
    } catch {
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
              {updateDialog === "checking" ? "Проверяем обновления…" : "Проверенная версия будет установлена только после вашего подтверждения."}
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

            <div className="action-confirmation__actions">
              <button
                type="button"
                className="action-confirmation__cancel"
                disabled={updateDialog === "applying"}
                onClick={() => {
                  setUpdateDialog("closed");
                  setUpdateCheck(null);
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
