import { useCallback, useEffect, useState } from "react";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { StatusText } from "./ShellPrimitives";
import { newHomeAssistantRequestId } from "./homeAssistantControlApi";
import { HA_RESTART, HA_UPDATE_CORE, fetchHomeAssistantMaintenance, fetchHomeAssistantMaintenanceOperation, startHomeAssistantMaintenance, type HomeAssistantMaintenanceActionId, type HomeAssistantMaintenanceStatus, type MaintenanceOperation } from "./homeAssistantMaintenanceApi";
import "./HomeAssistantMaintenance.css";

const phaseCopy: Record<MaintenanceOperation["status"], string> = {
  requested: "Готовим действие…",
  dispatching: "Отправляем команду…",
  waiting_for_disconnect: "Home Assistant перезапускается…",
  waiting_for_recovery: "Ожидаем возвращения Home Assistant…",
  verifying: "Проверяем новую версию…",
  success: "Действие подтверждено.",
  failed: "Действие не завершено."
};

function errorCopy(code: string | null): string {
  if (code === "admin_required") return "Для системных действий нужен токен администратора Home Assistant.";
  if (code === "restart_recovery_timeout" || code === "update_recovery_timeout") return "Home Assistant не вернулся за отведённое время.";
  if (code === "update_not_applied") return "Home Assistant вернулся, но новая версия не подтверждена.";
  return "Системное действие сейчас недоступно.";
}

export function HomeAssistantMaintenance() {
  const { ensureCapability } = useAccess();
  const { confirmAction } = useActionConfirmation();
  const { guardMutation } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [status, setStatus] = useState<HomeAssistantMaintenanceStatus | null>(null);
  const [operation, setOperation] = useState<MaintenanceOperation | null>(null);

  const refresh = useCallback(async () => {
    try { const next = await fetchHomeAssistantMaintenance(); setStatus(next); return next; }
    catch { setStatus(null); return null; }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 10_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!operation || operation.status === "success" || operation.status === "failed") return;
    const timer = window.setInterval(() => {
      void fetchHomeAssistantMaintenanceOperation(operation.requestId).then((next) => {
        setOperation(next);
        if (next.status === "success") { showNotice({ id: "home-assistant-maintenance", severity: "success", title: "Home Assistant", detail: "Системное действие подтверждено.", timeoutMs: 6_000 }); void refresh(); }
        if (next.status === "failed") { showNotice({ id: "home-assistant-maintenance", severity: "error", title: "Home Assistant", detail: errorCopy(next.failureCode), timeoutMs: 10_000 }); void refresh(); }
      }).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [operation, refresh, showNotice]);

  const run = useCallback(async (actionId: HomeAssistantMaintenanceActionId) => {
    if (operation || !guardMutation()) return;
    let next = status ?? await refresh();
    let decision = next?.actions[actionId];
    if (decision?.availability === "elevation_required") {
      if (await ensureCapability(actionId, "Обслуживание Home Assistant")) { next = await refresh(); decision = next?.actions[actionId]; }
    }
    if (!decision?.allowed) {
      showNotice({ id: "home-assistant-maintenance", severity: "warning", title: "Home Assistant", detail: decision?.availability === "integration_unavailable" && next?.configured && next?.reachable && !next?.adminAuthorized ? errorCopy("admin_required") : errorCopy(decision?.availability ?? null), timeoutMs: 8_000 });
      return;
    }
    const versions = `${next?.installedVersion ?? "текущая версия"} → ${next?.latestVersion ?? "новая версия"}`;
    const confirmation = await confirmAction(actionId, actionId === HA_UPDATE_CORE ? { description: `${versions}\n\nHome Assistant станет временно недоступен во время обновления и перезапуска.` } : undefined);
    if (!confirmation.confirmed || !guardMutation()) return;
    try {
      const started = await startHomeAssistantMaintenance(actionId, newHomeAssistantRequestId());
      setOperation(started);
      showNotice({ id: "home-assistant-maintenance", severity: "progress", title: "Home Assistant", detail: actionId === HA_RESTART ? "Перезапускаем Home Assistant…" : "Устанавливаем обновление…" });
    } catch (error) {
      showNotice({ id: "home-assistant-maintenance", severity: "error", title: "Home Assistant", detail: errorCopy(error instanceof Error ? error.message : null), timeoutMs: 10_000 });
    }
  }, [confirmAction, ensureCapability, guardMutation, operation, refresh, showNotice, status]);

  const updateDecision = status?.actions[HA_UPDATE_CORE];
  const restartDecision = status?.actions[HA_RESTART];
  const active = Boolean(operation && operation.status !== "success" && operation.status !== "failed");
  const stateLabel = !status ? "Недоступно" : !status.configured || !status.reachable ? "Недоступно" : !status.adminAuthorized ? "Требуется administrator token" : status.updateInProgress ? "Обновляется" : status.updateAvailable ? "Доступно обновление" : "Последняя версия";
  return <section className="ha-maintenance" data-testid="home-assistant-maintenance" aria-labelledby="ha-maintenance-title">
    <header><div><p className="section-kicker">Система · Home Assistant</p><h2 id="ha-maintenance-title">Home Assistant</h2><p>{operation ? phaseCopy[operation.status] : "Обслуживание доступно только через фиксированные системные действия."}</p></div><StatusText label={stateLabel} tone={status?.reachable && status.adminAuthorized ? "success" : "unavailable"} /></header>
    <dl className="ha-maintenance__versions"><div><dt>Текущая версия</dt><dd>{status?.installedVersion ?? "—"}</dd></div><div><dt>Последняя версия</dt><dd>{status?.latestVersion ?? "—"}</dd></div></dl>
    {status?.configured && status.reachable && !status.adminAuthorized && <p className="ha-maintenance__notice" role="status">Для системных действий нужен токен администратора Home Assistant.</p>}
    {operation?.status === "failed" && <p className="ha-maintenance__notice" role="status">{errorCopy(operation.failureCode)}</p>}
    <div className="ha-maintenance__actions"><button type="button" onClick={() => void run(HA_RESTART)} disabled={active || !restartDecision || (!restartDecision.allowed && restartDecision.availability !== "elevation_required")}>Перезапустить</button><button type="button" onClick={() => void run(HA_UPDATE_CORE)} disabled={active || !status?.updateAvailable || !updateDecision || (!updateDecision.allowed && updateDecision.availability !== "elevation_required")}>Обновить</button></div>
  </section>;
}
