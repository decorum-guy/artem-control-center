import { useCallback, useEffect, useState } from "react";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { StatusText } from "./ShellPrimitives";
import { newHomeAssistantRequestId } from "./homeAssistantControlApi";
import { HA_RESTART, HA_UPDATE_CORE, HOME_SERVER_BOT_RESTART, HOME_SERVER_CADDY_RESTART, fetchHomeAssistantMaintenance, fetchHomeAssistantMaintenanceOperation, startHomeAssistantMaintenance, type HomeAssistantMaintenanceActionId, type HomeAssistantMaintenanceStatus, type MaintenanceOperation } from "./homeAssistantMaintenanceApi";
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
      showNotice({ id: "home-assistant-maintenance", severity: "warning", title: "Домашний сервер", detail: errorCopy(decision?.availability ?? null), timeoutMs: 8_000 });
      return;
    }
    const confirmation = await confirmAction(actionId);
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
  const ha = status?.services.homeAssistant;
  const caddy = status?.services.caddy;
  const bot = status?.services.bot;
  const stateLabel = !status || !status.configured || !status.reachable ? "Недоступно" : ha?.healthy === false ? "Требует внимания" : "На связи";
  return <section className="ha-maintenance" data-testid="home-assistant-maintenance" aria-labelledby="ha-maintenance-title">
    <header><div><p className="section-kicker">Система · домашний сервер</p><h2 id="ha-maintenance-title">Home Assistant</h2><p>{operation ? phaseCopy[operation.status] : "Обслуживание доступно только через фиксированные системные действия."}</p></div><StatusText label={stateLabel} tone={status?.reachable ? "success" : "unavailable"} /></header>
    <dl className="ha-maintenance__versions"><div><dt>Версия Home Assistant</dt><dd>{ha?.installedVersion ?? "—"}</dd></div><div><dt>Образ контейнера</dt><dd>{ha?.configuredImage ?? "—"}</dd></div></dl>
    {operation?.status === "failed" && <p className="ha-maintenance__notice" role="status">{errorCopy(operation.failureCode)}</p>}
    <div className="ha-maintenance__actions"><button type="button" onClick={() => void run(HA_RESTART)} disabled={active || !restartDecision || (!restartDecision.allowed && restartDecision.availability !== "elevation_required")}>Перезапустить</button><button type="button" onClick={() => void run(HA_UPDATE_CORE)} disabled={active || !updateDecision || (!updateDecision.allowed && updateDecision.availability !== "elevation_required")}>Проверить и обновить</button></div>
    <div className="ha-maintenance__service-actions"><span>Caddy · {caddy?.healthy ? "на связи" : "нет подтверждения"}</span><button type="button" onClick={() => void run(HOME_SERVER_CADDY_RESTART)} disabled={active || !status?.actions[HOME_SERVER_CADDY_RESTART]?.allowed}>Перезапустить Caddy</button><span>Telegram Bot · {bot?.healthy ? "на связи" : "нет подтверждения"}</span><button type="button" onClick={() => void run(HOME_SERVER_BOT_RESTART)} disabled={active || !status?.actions[HOME_SERVER_BOT_RESTART]?.allowed}>Перезапустить бота</button></div>
  </section>;
}
