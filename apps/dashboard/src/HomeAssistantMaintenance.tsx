import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { StatusText } from "./ShellPrimitives";
import { newHomeAssistantRequestId } from "./homeAssistantControlApi";
import {
  HA_RESTART, HA_UPDATE_CORE, HOME_SERVER_BOT_RESTART, HOME_SERVER_CADDY_RESTART,
  checkHomeAssistantUpdate, fetchHomeAssistantMaintenance, fetchHomeAssistantMaintenanceOperation,
  startHomeAssistantMaintenance, type HomeAssistantMaintenanceActionId, type HomeAssistantMaintenanceStatus,
  type HomeAssistantUpdateCheck, type MaintenanceDecision, type MaintenanceOperation
} from "./homeAssistantMaintenanceApi";
import { formatPanelDate } from "./panelDate";
import { Button } from "./ui/Controls";
import "./HomeAssistantMaintenance.css";

const failureCopy: Record<string, string> = {
  maintenance_busy: "На домашнем сервере уже выполняется другая операция.",
  maintenance_disabled: "Это действие отключено на домашнем сервере.",
  configuration_missing: "На домашнем сервере не настроено обслуживание контейнеров.",
  home_server_not_configured: "На панели не настроено подключение к домашнему серверу.",
  ssh_timeout: "Домашний сервер не ответил вовремя.",
  ssh_transport_failed: "Не удалось подключиться к домашнему серверу.",
  ssh_client_unavailable: "На панели недоступен клиент SSH.",
  ssh_identity_file_missing: "На панели отсутствует ключ подключения к домашнему серверу.",
  ssh_known_hosts_file_missing: "На панели отсутствует файл проверки подлинности домашнего сервера.",
  ssh_invalid_response: "Домашний сервер вернул неподтверждённый ответ.",
  ssh_output_too_large: "Ответ домашнего сервера превысил допустимый размер.",
  installed_version_unknown: "Не удалось прочитать установленную версию Home Assistant.",
  unsupported_release_channel: "Для этого образа нельзя сравнить версии с официальным каналом stable.",
  release_feed_unavailable: "Не удалось получить версию из каталога Home Assistant. Повторите проверку позже.",
  compose_failed: "Docker Compose не завершил команду на домашнем сервере.",
  update_failed: "Не удалось проверить или применить образ Home Assistant.",
  update_not_applied: "После запуска образ Home Assistant отличается от загруженного.",
  restart_recovery_timeout: "Сервис не подтвердил готовность после перезапуска.",
  update_recovery_timeout: "Home Assistant не подтвердил готовность после установки.",
  helper_failed: "Служба обслуживания домашнего сервера не подтвердила результат.",
  request_id_conflict: "Этот запрос уже использован для другого действия.",
  request_failed_422: "Панель отклонила формат запроса."
};

export function maintenanceActionCopy(actionId: HomeAssistantMaintenanceActionId): { title: string; progress: string } {
  if (actionId === HA_RESTART) return { title: "Home Assistant", progress: "Перезапускаем Home Assistant…" };
  if (actionId === HA_UPDATE_CORE) return { title: "Home Assistant", progress: "Устанавливаем обновление Home Assistant…" };
  if (actionId === HOME_SERVER_CADDY_RESTART) return { title: "Caddy", progress: "Перезапускаем Caddy…" };
  return { title: "Telegram Bot", progress: "Перезапускаем Telegram-бота…" };
}

export function maintenanceOperationActive(operation: MaintenanceOperation | null): boolean {
  return Boolean(operation && operation.status !== "success" && operation.status !== "failed");
}

function mayRequest(decision?: MaintenanceDecision) {
  return Boolean(decision?.allowed || decision?.availability === "elevation_required");
}

function checkSummary(check: HomeAssistantUpdateCheck) {
  if (check.state === "available") return `Доступна версия ${check.latestVersion}.`;
  if (check.state === "ahead") return `Установленная версия новее версии ${check.latestVersion} в стабильном канале.`;
  return `Установлена актуальная версия ${check.installedVersion}.`;
}

export function HomeAssistantMaintenance({ target }: { target?: "homeAssistant" | "bot" } = {}) {
  const titleId = useId();
  const { ensureCapability, explainAvailability } = useAccess();
  const { confirmAction } = useActionConfirmation();
  const { guardMutation } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [status, setStatus] = useState<HomeAssistantMaintenanceStatus | null>(null);
  const [operation, setOperation] = useState<MaintenanceOperation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [check, setCheck] = useState<HomeAssistantUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailure, setCheckFailure] = useState<string | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const statusSequence = useRef(0);
  const actionPending = useRef(false);
  const inProgress = maintenanceOperationActive(operation);
  const busy = submitting || inProgress || Boolean(status?.busy);
  const errorMessage = useCallback((code: string | null) => {
    if (code && ["busy", "gate_disabled", "profile_blocked", "pin_not_configured", "integration_unavailable", "elevation_required"].includes(code)) {
      return explainAvailability(code);
    }
    return failureCopy[code ?? ""] ?? "Не удалось получить подтверждение от панели. Проверьте состояние сервиса.";
  }, [explainAvailability]);

  const refresh = useCallback(async () => {
    const sequence = ++statusSequence.current;
    const next = await fetchHomeAssistantMaintenance().catch(() => null);
    if (sequence === statusSequence.current) {
      setStatus(next);
      setStatusLoaded(true);
      if (next?.activeOperation) setOperation(next.activeOperation);
    }
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    let timer: number;
    async function poll() {
      await refresh();
      if (live) timer = window.setTimeout(poll, 10_000);
    }
    void poll();
    return () => { live = false; ++statusSequence.current; window.clearTimeout(timer); };
  }, [refresh]);

  const activeRequest = inProgress ? operation?.requestId : undefined;
  useEffect(() => {
    if (!activeRequest) return;
    const requestId = activeRequest;
    let live = true;
    let timer: number;
    async function poll() {
      let next: MaintenanceOperation | null = null;
      try { next = await fetchHomeAssistantMaintenanceOperation(requestId); }
      catch (error) {
        if (live && error instanceof Error && error.message === "request_failed_404") {
          setOperation(null);
          setCheck(null);
          showNotice({ id: "home-assistant-maintenance", severity: "warning", title: "Домашний сервер",
            detail: "Панель потеряла запись операции. Проверьте состояние сервиса перед повтором.", timeoutMs: 10_000 });
          void refresh();
          return;
        }
      }
      if (!live) return;
      if (next) {
        setOperation(next);
        if (next.status === "success" || next.status === "failed") {
          const success = next.status === "success";
          const detail = success ? successMessage(next) : errorMessage(next.failureCode);
          showNotice({ id: "home-assistant-maintenance", title: maintenanceActionCopy(next.actionId).title,
            severity: success ? "success" : "error", detail, timeoutMs: success ? 6_000 : 10_000 });
          if (next.actionId === HA_UPDATE_CORE) setCheck(null);
          void refresh();
          return;
        }
      }
      timer = window.setTimeout(poll, 1_000);
    }
    timer = window.setTimeout(poll, 1_000);
    return () => { live = false; window.clearTimeout(timer); };
  }, [activeRequest, errorMessage, refresh, showNotice]);

  async function checkVersion() {
    if (checking) return;
    setChecking(true);
    setCheckFailure(null);
    try { setCheck(await checkHomeAssistantUpdate()); }
    catch (error) { setCheckFailure(error instanceof Error ? error.message : "check_failed"); }
    finally { setChecking(false); }
  }

  async function run(actionId: HomeAssistantMaintenanceActionId) {
    if (actionPending.current || busy || !guardMutation()) return;
    actionPending.current = true;
    try {
      let decision = (status ?? await refresh())?.actions[actionId];
      if (decision?.availability === "elevation_required") {
        if (!await ensureCapability(actionId, "Обслуживание домашнего сервера")) return;
        decision = (await refresh())?.actions[actionId];
      }
      if (!decision?.allowed) throw new Error(decision?.availability ?? "integration_unavailable");
      const install = actionId === HA_UPDATE_CORE;
      const confirmation = await confirmAction(actionId, install ? {
        description: checkFailure === "unsupported_release_channel" || !check
          ? "Домашний сервер проверит заданный в Docker Compose образ. Если он изменился, Home Assistant перезапустится для установки."
          : `Сейчас установлена версия ${check.installedVersion}. В стабильном канале доступна ${check.latestVersion}. На время установки Home Assistant перезапустится.`
      } : undefined);
      if (!confirmation.confirmed || !guardMutation()) return;
      setSubmitting(true);
      const started = await startHomeAssistantMaintenance(actionId, newHomeAssistantRequestId());
      setOperation(started);
      const copy = maintenanceActionCopy(actionId);
      showNotice({ id: "home-assistant-maintenance", severity: "progress", title: copy.title, detail: copy.progress });
    } catch (error) {
      showNotice({ id: "home-assistant-maintenance", severity: "error", title: maintenanceActionCopy(actionId).title,
        detail: errorMessage(error instanceof Error ? error.message : null), timeoutMs: 10_000 });
    } finally { actionPending.current = false; setSubmitting(false); }
  }

  function actionButton(id: HomeAssistantMaintenanceActionId, label: string) {
    const decision = status?.actions[id];
    const reason = decision && !decision.allowed ? explainAvailability(decision.availability) : null;
    return <div className="ha-maintenance__action">
      <Button variant={id === HA_UPDATE_CORE ? "primary" : "secondary"} disabled={busy || !mayRequest(decision)} onClick={() => void run(id)}>{label}</Button>
      {reason && <small>{reason}</small>}
    </div>;
  }

  const ha = status?.services.homeAssistant;
  const service = target === "bot" ? status?.services.bot : ha;
  const reachable = status?.reachable && service?.running;
  const stateLabel = !statusLoaded ? "Проверяем связь…" : !reachable ? "Нет связи" : service.healthy === false ? "Требует внимания" : service.healthy ? "На связи" : "Контейнер запущен";
  const message = operation && (operation.status === "failed" ? errorMessage(operation.failureCode) : operation.status === "success" ? successMessage(operation) : maintenanceActionCopy(operation.actionId).progress);
  const previousCheck = checking || Boolean(checkFailure) || Boolean(check && ha?.installedVersion && check.installedVersion !== ha.installedVersion);
  const available = check?.state === "available" && !previousCheck;
  return <section className="ha-maintenance" data-testid="home-assistant-maintenance" aria-labelledby={titleId}>
    <header>
      <div><p className="section-kicker">Домашний сервер</p><h2 id={titleId}>{target === "bot" ? "Telegram-бот" : "Home Assistant"}</h2></div>
      <StatusText label={stateLabel} tone={!reachable ? "unavailable" : service.healthy === false ? "warning" : "success"} />
    </header>
    {statusLoaded && !status?.reachable && <p className="ha-maintenance__notice">{errorMessage(status?.statusReason ?? null)}</p>}
    {target !== "bot" && <>
      <dl className="ha-maintenance__versions">
        <div><dt>Установленная версия</dt><dd>{ha?.installedVersion || "—"}</dd></div>
        <div><dt>Образ контейнера</dt><dd>{ha?.configuredImage || "—"}</dd></div>
      </dl>
      <div className="ha-maintenance__update">
        <div className="ha-maintenance__actions">
          <Button variant={available ? "secondary" : "primary"} pendingLabel={checking ? "Проверяем версии…" : undefined} disabled={busy} onClick={() => void checkVersion()}>
            Проверить обновления
          </Button>
          {available && actionButton(HA_UPDATE_CORE, "Установить обновление")}
          {checkFailure === "unsupported_release_channel" && actionButton(HA_UPDATE_CORE, "Обновить настроенный образ")}
        </div>
        <div role="status" className="ha-maintenance__check-result">
          {checkFailure && <p className="ha-maintenance__notice">{errorMessage(checkFailure)}</p>}
          {check && <p>{previousCheck ? `Последняя подтверждённая версия в каталоге — ${check.latestVersion}.` : checkSummary(check)} <time dateTime={check.checkedAt}>Проверено {formatPanelDate(check.checkedAt)}</time></p>}
        </div>
      </div>
      {actionButton(HA_RESTART, "Перезапустить Home Assistant")}
    </>}
    {!target && <div className="ha-maintenance__service">
      <span>Caddy · {serviceHealth(status?.services.caddy)}</span>{actionButton(HOME_SERVER_CADDY_RESTART, "Перезапустить Caddy")}
    </div>}
    {target !== "homeAssistant" && <div className="ha-maintenance__service">
      {!target && <span>Telegram-бот · {serviceHealth(status?.services.bot)}</span>}{actionButton(HOME_SERVER_BOT_RESTART, "Перезапустить Telegram-бота")}
    </div>}
    {message && <p className="ha-maintenance__notice" role="status">{message}</p>}
  </section>;
}

function serviceHealth(service?: { running: boolean; healthy: boolean | null }) {
  if (!service?.running) return "нет связи";
  if (service.healthy === false) return "требует внимания";
  return service.healthy ? "на связи" : "контейнер запущен";
}

function successMessage(operation: MaintenanceOperation) {
  if (operation.result === "up_to_date") return "Образ Home Assistant уже актуален.";
  if (operation.actionId === HA_UPDATE_CORE) return "Обновление установлено. Home Assistant снова на связи.";
  return "Перезапуск подтверждён.";
}
