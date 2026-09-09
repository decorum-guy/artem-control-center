import { useCallback, useEffect, useState } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { Icon } from "./icons";
import {
  executeHomeAssistantAction,
  fetchHomeAssistantActionAvailability,
  newHomeAssistantRequestId,
  ROG_PSU_BP1_OFF,
  ROG_PSU_BP1_ON,
  ROG_PSU_BP2_OFF,
  ROG_PSU_BP2_ON,
  ROG_PSU_MODE_FULL,
  ROG_PSU_MODE_NORMAL,
  type HomeAssistantActionAvailability,
  type RogPsuActionId
} from "./homeAssistantControlApi";
import { StatusText } from "./ShellPrimitives";
import "./RogPsuControls.css";

type PsuState = "on" | "off" | "unavailable";
type PsuMode = "full" | "normal" | "secondary_only" | "off" | "unavailable";

interface PsuData {
  mode?: PsuMode;
  stale?: boolean;
  psu1?: { state?: PsuState; available?: boolean };
  psu2?: { state?: PsuState; available?: boolean };
}

const modeLabels: Record<PsuMode, string> = {
  full: "Полная мощность · 2 БП",
  normal: "Обычная мощность · БП 1",
  secondary_only: "Один БП · БП 2",
  off: "Оба БП выключены",
  unavailable: "Состояние питания неизвестно"
};

const psuStateLabels: Record<PsuState, string> = {
  on: "Включён",
  off: "Выключен",
  unavailable: "Недоступен"
};

export function rogPsuModeLabel(mode: PsuMode | undefined): string {
  return modeLabels[mode ?? "unavailable"];
}

export function rogPsuStateLabel(state: PsuState | undefined): string {
  return psuStateLabels[state ?? "unavailable"];
}

function psuData(service: ServiceSnapshot): PsuData {
  return service.data as PsuData;
}

function actionErrorCopy(code: string): string {
  switch (code) {
    case "last_psu_off_blocked":
      return "Последний включённый блок питания выключить нельзя.";
    case "ha_verification_timeout":
      return "Home Assistant не подтвердил изменение питания вовремя.";
    case "ha_service_failed":
      return "Home Assistant не принял команду питания.";
    case "ha_integration_unavailable":
    case "ha_entity_unavailable":
      return "Состояние блоков питания сейчас недоступно.";
    default:
      return "Команда питания не выполнена.";
  }
}

function actionLabel(actionId: RogPsuActionId): string {
  switch (actionId) {
    case ROG_PSU_MODE_NORMAL: return "Обычная мощность";
    case ROG_PSU_MODE_FULL: return "Полная мощность";
    case ROG_PSU_BP1_ON: return "Включить БП 1";
    case ROG_PSU_BP1_OFF: return "Выключить БП 1";
    case ROG_PSU_BP2_ON: return "Включить БП 2";
    case ROG_PSU_BP2_OFF: return "Выключить БП 2";
  }
}

function availabilityCopy(availability: string, explain: (value: string) => string): string {
  return availability === "gate_disabled"
    ? "Управление блоками питания выключено в настройках возможностей."
    : explain(availability);
}

function displayActionLabel(actionId: RogPsuActionId, variant: "system" | "home" | "overview"): string {
  if (variant === "home" && actionId === ROG_PSU_MODE_NORMAL) return "Обычный режим";
  return actionLabel(actionId);
}

export function RogPsuControls({ service, interactive = true, variant = "system" }: { service: ServiceSnapshot; interactive?: boolean; variant?: "system" | "home" | "overview" }) {
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<HomeAssistantActionAvailability | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [pendingAction, setPendingAction] = useState<RogPsuActionId | null>(null);
  const data = psuData(service);
  const psu1State = data.psu1?.state ?? "unavailable";
  const psu2State = data.psu2?.state ?? "unavailable";
  const live = service.health === "healthy" && data.stale !== true && psu1State !== "unavailable" && psu2State !== "unavailable";

  const refresh = useCallback(async () => {
    try {
      const next = await fetchHomeAssistantActionAvailability();
      setAvailability(next);
      setApiAvailable(true);
      return next;
    } catch {
      setAvailability(null);
      setApiAvailable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const canUse = useCallback((actionId: RogPsuActionId, preconditionOk = true) => {
    const decision = availability?.actions[actionId];
    return Boolean(
      interactive &&
      live &&
      !pendingAction &&
      preconditionOk &&
      decision &&
      (decision.allowed || decision.availability === "elevation_required")
    );
  }, [availability, interactive, live, pendingAction]);

  const run = useCallback(async (actionId: RogPsuActionId) => {
    if (!interactive || pendingAction || !guardMutation()) return;
    let decision = availability?.actions[actionId] ?? null;
    if (!decision) {
      const next = await refresh();
      decision = next?.actions[actionId] ?? null;
    }
    if (!decision) {
      showNotice({ id: "system.rog-g703-psu.action", severity: "warning", title: "Питание ASUS ROG", detail: "Управление питанием сейчас недоступно.", timeoutMs: 6_000 });
      return;
    }
    if (!decision.allowed && decision.availability === "elevation_required") {
      const elevated = await ensureCapability(actionId, "Питание ASUS ROG");
      if (elevated) {
        const next = await refresh();
        decision = next?.actions[actionId] ?? decision;
      }
    }
    if (!decision.allowed) {
      showNotice({ id: "system.rog-g703-psu.action", severity: "warning", title: "Питание ASUS ROG", detail: availabilityCopy(decision.availability, explainAvailability), timeoutMs: 6_000 });
      return;
    }
    if (!guardMutation()) return;
    setPendingAction(actionId);
    showNotice({ id: "system.rog-g703-psu.action", severity: "progress", title: "Питание ASUS ROG", detail: "Отправляем команду и ждём подтверждение…" });
    try {
      await executeHomeAssistantAction({ actionId, requestId: newHomeAssistantRequestId() });
      showNotice({ id: "system.rog-g703-psu.action", severity: "success", title: "Питание ASUS ROG", detail: "Изменение подтверждено Home Assistant.", timeoutMs: 6_000 });
      await refresh();
    } catch (error) {
      showNotice({ id: "system.rog-g703-psu.action", severity: "error", title: "Питание ASUS ROG", detail: actionErrorCopy(error instanceof Error ? error.message : "action_failed"), timeoutMs: 10_000 });
    } finally {
      setPendingAction(null);
    }
  }, [availability, ensureCapability, explainAvailability, guardMutation, interactive, pendingAction, refresh, showNotice]);

  const canSwitchOff = (state: PsuState, otherState: PsuState) => state === "on" && otherState === "on" && live;
  const mode = data.mode ?? "unavailable";
  const statusLabel = mode === "unavailable"
    ? rogPsuModeLabel(mode)
    : !live
      ? (service.health === "stale" || data.stale ? "Данные устарели" : "Недоступен")
      : rogPsuModeLabel(mode);

  return (
    <section className={`rog-psu-controls rog-psu-controls--${variant}${!live ? " rog-psu-controls--unavailable" : ""}`} data-testid={variant === "overview" ? "overview-rog-psu-controls" : "rog-psu-controls"} data-variant={variant} aria-label={variant === "overview" ? "Режимы питания ASUS ROG" : undefined} aria-labelledby={variant === "overview" ? undefined : `rog-psu-title-${variant}`}>
      {variant !== "overview" && <header className="rog-psu-controls__header">
        <div>
          {variant === "system" && <p className="section-kicker">Система · питание</p>}
          <h2 id={`rog-psu-title-${variant}`}>{variant === "home" ? "Блоки питания" : service.title}</h2>
        </div>
        <StatusText label={statusLabel} tone={live ? "success" : service.health === "stale" ? "stale" : "unavailable"} />
      </header>}

      {!live && variant !== "overview" && <p className="rog-psu-controls__notice" role="status">Управление отключено до подтверждения свежего состояния.</p>}

      <div className="rog-psu-controls__modes" aria-label="Режимы питания">
        {[ROG_PSU_MODE_NORMAL, ROG_PSU_MODE_FULL].map((actionId) => (
          <button
            key={actionId}
            type="button"
            className={`rog-psu-controls__mode${variant === "overview" ? " rog-psu-controls__mode--overview" : ""}${mode === (actionId === ROG_PSU_MODE_FULL ? "full" : "normal") ? " rog-psu-controls__mode--selected" : ""}`}
            disabled={!canUse(actionId)}
            aria-busy={pendingAction === actionId}
            aria-pressed={mode === (actionId === ROG_PSU_MODE_FULL ? "full" : "normal")}
            aria-label={actionId === ROG_PSU_MODE_NORMAL ? "Обычный режим питания ASUS ROG" : "Полная мощность ASUS ROG"}
            data-testid={variant === "overview" ? `overview-rog-psu-${actionId === ROG_PSU_MODE_NORMAL ? "normal" : "full"}` : undefined}
            title={`${actionId === ROG_PSU_MODE_NORMAL ? "Обычный режим питания ASUS ROG" : "Полная мощность ASUS ROG"}. ${availability?.actions[actionId] ? availabilityCopy(availability.actions[actionId].availability, explainAvailability) : "Проверяем доступность"}`}
            onClick={() => void run(actionId)}
          >
            {variant === "overview"
              ? <Icon name={pendingAction === actionId ? "refresh" : actionId === ROG_PSU_MODE_NORMAL ? "economy" : "performance"} size={20} className={pendingAction === actionId ? "rog-psu-controls__pending-icon" : undefined} />
              : pendingAction === actionId ? "Проверяем…" : displayActionLabel(actionId, variant)}
          </button>
        ))}
      </div>

      {variant !== "overview" && <div className="rog-psu-controls__rows">
        {([
          { number: 1 as const, state: psu1State, on: ROG_PSU_BP1_ON, off: ROG_PSU_BP1_OFF, other: psu2State },
          { number: 2 as const, state: psu2State, on: ROG_PSU_BP2_ON, off: ROG_PSU_BP2_OFF, other: psu1State }
        ]).map(({ number, state, on, off, other }) => {
          const targetAction = state === "on" ? off : on;
          const offAllowed = state !== "on" || canSwitchOff(state, other);
          return (
            <div className="rog-psu-controls__row" key={number}>
              <div className="rog-psu-controls__identity">
                <strong>БП {number}</strong>
                <StatusText label={rogPsuStateLabel(state)} tone={state === "on" ? "success" : state === "off" ? "neutral" : "unavailable"} />
              </div>
              <button
                type="button"
                className={`rog-psu-controls__toggle${state === "on" ? " rog-psu-controls__toggle--on" : ""}`}
                data-testid={`rog-psu-toggle-${number}`}
                aria-label={`${state === "on" ? "Выключить" : "Включить"} БП ${number}`}
                aria-pressed={state === "on"}
                aria-busy={pendingAction === targetAction}
                disabled={!canUse(targetAction, offAllowed)}
                title={!offAllowed ? "Нельзя выключить последний включённый блок питания" : availability?.actions[targetAction] ? availabilityCopy(availability.actions[targetAction].availability, explainAvailability) : "Проверяем доступность"}
                onClick={() => void run(targetAction)}
              >
                <Icon name="power" size={22} />
              </button>
            </div>
          );
        })}
      </div>}

      {!apiAvailable && interactive && variant !== "overview" && <p className="rog-psu-controls__notice">Проверяем доступность управления…</p>}
      {variant === "system" && <p className="rog-psu-controls__note">Состояние показывает только два подтверждённых переключателя Home Assistant. Телеметрия мощности не подключена.</p>}
    </section>
  );
}
