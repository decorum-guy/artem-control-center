import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { Icon } from "./icons";
import {
  fetchHomeAssistantActionAvailability,
  executeHomeAssistantAction,
  HOME_CLIMATE_POWER_OFF,
  HOME_CLIMATE_POWER_ON,
  HOME_CLIMATE_SET_FAN_MODE,
  HOME_CLIMATE_SET_MODE,
  HOME_CLIMATE_SET_TEMPERATURE,
  newHomeAssistantRequestId,
  type ClimateActionId,
  type ClimateFanMode,
  type ClimateHvacMode,
  type HomeAssistantActionAvailability
} from "./homeAssistantControlApi";
import "./ClimateControl.css";

export const climateHvacLabels: Record<ClimateHvacMode, string> = {
  auto: "Авто",
  heat: "Обогрев",
  cool: "Охлаждение",
  dry: "Осушение",
  fan_only: "Вентиляция",
  off: "Выкл"
};

export const climateFanLabels: Record<ClimateFanMode, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5"
};

const hvacOrder: ClimateHvacMode[] = ["cool", "heat", "fan_only", "dry", "auto", "off"];
const fanOrder: ClimateFanMode[] = ["one", "two", "three", "four", "five"];

interface ClimateData {
  state?: ClimateHvacMode;
  available?: boolean;
  stale?: boolean;
  targetTemperature?: number | null;
  currentTemperature?: number | null;
  minTemperature?: number | null;
  maxTemperature?: number | null;
  temperatureStep?: number | null;
  hvacModes?: string[];
  fanMode?: ClimateFanMode | null;
  fanModes?: string[];
}

function climateData(service: ServiceSnapshot): ClimateData {
  return service.data as ClimateData;
}

function actionErrorCopy(code: string): string {
  switch (code) {
    case "ha_verification_timeout":
      return "Home Assistant не подтвердил изменение состояния вовремя.";
    case "ha_service_failed":
      return "Home Assistant не принял команду.";
    case "ha_integration_unavailable":
    case "ha_entity_unavailable":
      return "Состояние кондиционера сейчас недоступно.";
    default:
      return "Команда кондиционера не выполнена.";
  }
}

function climateAvailabilityCopy(availability: string, explain: (value: string) => string): string {
  return availability === "gate_disabled"
    ? "Управление выключено в настройках возможностей."
    : explain(availability);
}

export function ClimateControl({
  service,
  variant,
  interactive = true,
  overviewSizeVariant
}: {
  service: ServiceSnapshot;
  variant: "home" | "overview";
  interactive?: boolean;
  overviewSizeVariant?: "compact" | "standard" | "large";
}) {
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation, locked } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<HomeAssistantActionAvailability | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [pendingAction, setPendingAction] = useState<ClimateActionId | null>(null);
  const data = climateData(service);
  const climateLive = service.health === "healthy" && data.available !== false && data.stale !== true;
  const minimumTemperature = 16;
  const maximumTemperature = 32;
  const targetTemperature = typeof data.targetTemperature === "number" ? data.targetTemperature : null;
  const [confirmedTarget, setConfirmedTarget] = useState<number | null>(targetTemperature);
  const [draftTarget, setDraftTarget] = useState<number | null>(targetTemperature);
  const serviceIdRef = useRef(service.id);
  const modes = useMemo(
    () => hvacOrder.filter((mode) => (data.hvacModes ?? []).includes(mode)),
    [data.hvacModes]
  );
  const fans = useMemo(
    () => fanOrder.filter((mode) => (data.fanModes ?? []).includes(mode)),
    [data.fanModes]
  );

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

  useEffect(() => {
    if (serviceIdRef.current !== service.id) {
      serviceIdRef.current = service.id;
      setConfirmedTarget(targetTemperature);
      setDraftTarget(targetTemperature);
      return;
    }
    setConfirmedTarget((previousConfirmed) => {
      setDraftTarget((previousDraft) => previousDraft === previousConfirmed ? targetTemperature : previousDraft);
      return targetTemperature;
    });
  }, [service.id, targetTemperature]);

  const canUse = useCallback((actionId: ClimateActionId) => {
    const decision = availability?.actions[actionId];
    return Boolean(
      interactive &&
      !locked &&
      climateLive &&
      !pendingAction &&
      decision &&
      (decision.allowed || decision.availability === "elevation_required")
    );
  }, [availability, climateLive, interactive, locked, pendingAction]);

  const run = useCallback(async (
    actionId: ClimateActionId,
    values: { temperature?: number; mode?: ClimateHvacMode; fanMode?: ClimateFanMode } = {}
  ) => {
    if (!interactive || pendingAction || !guardMutation()) return null;
    let decision = availability?.actions[actionId] ?? null;
    if (!decision) {
      const next = await refresh();
      decision = next?.actions[actionId] ?? null;
    }
    if (!decision) {
      showNotice({ id: "home.climate.action", severity: "warning", title: "Кондиционер", detail: "Управление кондиционером сейчас недоступно.", timeoutMs: 6_000 });
      return null;
    }
    if (!decision.allowed && decision.availability === "elevation_required") {
      const elevated = await ensureCapability(actionId, "Кондиционер");
      if (elevated) {
        const next = await refresh();
        decision = next?.actions[actionId] ?? decision;
      }
    }
    if (!decision.allowed) {
      showNotice({ id: "home.climate.action", severity: "warning", title: "Кондиционер", detail: climateAvailabilityCopy(decision.availability, explainAvailability), timeoutMs: 6_000 });
      return null;
    }
    if (!guardMutation()) return null;
    setPendingAction(actionId);
    showNotice({ id: "home.climate.action", severity: "progress", title: "Кондиционер", detail: "Отправляем команду и ждём подтверждение…" });
    try {
      const response = await executeHomeAssistantAction({
        actionId,
        requestId: newHomeAssistantRequestId(),
        temperature: values.temperature ?? null,
        mode: values.mode ?? null,
        fanMode: values.fanMode ?? null
      });
      showNotice({ id: "home.climate.action", severity: "success", title: "Кондиционер", detail: "Изменение подтверждено Home Assistant.", timeoutMs: 6_000 });
      await refresh();
      return response;
    } catch (error) {
      showNotice({ id: "home.climate.action", severity: "error", title: "Кондиционер", detail: actionErrorCopy(error instanceof Error ? error.message : "action_failed"), timeoutMs: 10_000 });
      return null;
    } finally {
      setPendingAction(null);
    }
  }, [availability, ensureCapability, explainAvailability, guardMutation, interactive, pendingAction, refresh, showNotice]);

  const state = data.state ?? "off";
  const powerAction = state === "off" ? HOME_CLIMATE_POWER_ON : HOME_CLIMATE_POWER_OFF;
  const stateLabel = climateHvacLabels[state] ?? "Состояние неизвестно";
  const statusLabel = !climateLive
    ? service.health === "stale" || data.stale ? "Данные устарели" : "Недоступен"
    : stateLabel;
  const selectedMode = modes.includes(state) ? state : modes[0] ?? "off";
  const selectedFan = data.fanMode && fans.includes(data.fanMode) ? data.fanMode : fans[0] ?? "one";
  const step = 1;
  const targetDirty = draftTarget !== confirmedTarget;
  const temperaturePending = pendingAction === HOME_CLIMATE_SET_TEMPERATURE;
  const updateDraft = (delta: number) => {
    if (draftTarget === null || temperaturePending || !canUse(HOME_CLIMATE_SET_TEMPERATURE)) return;
    setDraftTarget(Math.min(maximumTemperature, Math.max(minimumTemperature, draftTarget + delta)));
  };
  const confirmDraft = async () => {
    if (draftTarget === null || !targetDirty || temperaturePending) return;
    const response = await run(HOME_CLIMATE_SET_TEMPERATURE, { temperature: draftTarget });
    const confirmed = response?.climate?.targetTemperature;
    if (typeof confirmed === "number") {
      setConfirmedTarget(confirmed);
      setDraftTarget(confirmed);
    }
  };

  return (
    <section
      className={`climate-control climate-control--${variant}${!climateLive ? " climate-control--unavailable" : ""}`}
      data-testid={`climate-control-${variant}`}
      data-overview-size-variant={variant === "overview" ? overviewSizeVariant ?? "standard" : undefined}
      aria-labelledby={`climate-control-title-${variant}`}
    >
      <header className="climate-control__header">
        <div>
          <h2 id={`climate-control-title-${variant}`}>{service.title}</h2>
        </div>
        <span className="climate-control__status" data-health={service.health}>{statusLabel}</span>
      </header>

      {!climateLive && <p className="climate-control__notice" role="status">Управление отключено до подтверждения свежего состояния.</p>}

      <div className="climate-control__controls">
        <button
          type="button"
          className={`climate-control__power climate-control__power--${state === "off" ? "off" : "on"}`}
          data-testid={`climate-power-${variant}`}
          data-power-state={state === "off" ? "off" : "on"}
          disabled={!canUse(powerAction)}
          aria-label={state === "off" ? "Включить кондиционер" : "Выключить кондиционер"}
          aria-pressed={state !== "off"}
          aria-busy={pendingAction === powerAction}
          onClick={() => void run(powerAction)}
          title={availability?.actions[powerAction] ? climateAvailabilityCopy(availability.actions[powerAction].availability, explainAvailability) : "Проверяем доступность"}
        >
          {pendingAction === powerAction ? <Icon name="refresh" size={20} className="climate-control__pending-icon" /> : <Icon name="power" size={22} />}
        </button>

        <div className="climate-control__temperature-control" aria-label="Целевая температура">
          <span className="climate-control__target-value" data-testid={`climate-temperature-value-${variant}`}>{draftTarget ?? "—"}°</span>
          <button
            type="button"
            className="climate-control__stepper"
            data-testid={`climate-temperature-decrease-${variant}`}
            disabled={!canUse(HOME_CLIMATE_SET_TEMPERATURE) || draftTarget === null || draftTarget <= minimumTemperature}
            onClick={() => updateDraft(-step)}
            aria-label="Уменьшить целевую температуру"
          >
            <Icon name="minus" size={24} />
          </button>
          <button
            type="button"
            className="climate-control__stepper"
            data-testid={`climate-temperature-increase-${variant}`}
            disabled={!canUse(HOME_CLIMATE_SET_TEMPERATURE) || draftTarget === null || draftTarget >= maximumTemperature}
            onClick={() => updateDraft(step)}
            aria-label="Увеличить целевую температуру"
          >
            <Icon name="plus" size={24} />
          </button>
          <button
            type="button"
            className={`climate-control__confirm${targetDirty ? " climate-control__confirm--dirty" : ""}`}
            data-testid={`climate-temperature-confirm-${variant}`}
            disabled={!canUse(HOME_CLIMATE_SET_TEMPERATURE) || !targetDirty}
            aria-label={targetDirty ? "Подтвердить целевую температуру" : "Целевая температура подтверждена"}
            aria-busy={temperaturePending}
            title={targetDirty ? "Подтвердить целевую температуру" : "Целевая температура подтверждена"}
            onClick={() => void confirmDraft()}
          >
            {temperaturePending ? <Icon name="refresh" size={20} className="climate-control__pending-icon" /> : <Icon name="check" size={20} />}
          </button>
        </div>

        <label className="climate-control__select-label climate-control__mode-label">
          <span>Режим</span>
          <select
            value={selectedMode}
            disabled={!canUse(HOME_CLIMATE_SET_MODE) || !modes.length}
            onChange={(event) => void run(HOME_CLIMATE_SET_MODE, { mode: event.target.value as ClimateHvacMode })}
            aria-label="Режим кондиционера"
          >
            {modes.map((mode) => <option key={mode} value={mode}>{climateHvacLabels[mode]}</option>)}
          </select>
        </label>

        <label className="climate-control__select-label climate-control__fan-label">
          <span>Скорость вентилятора</span>
          <select
            value={selectedFan}
            disabled={!canUse(HOME_CLIMATE_SET_FAN_MODE) || !fans.length}
            onChange={(event) => void run(HOME_CLIMATE_SET_FAN_MODE, { fanMode: event.target.value as ClimateFanMode })}
            aria-label="Скорость вентилятора"
          >
            {fans.map((fan) => <option key={fan} value={fan}>Скорость {climateFanLabels[fan]}</option>)}
          </select>
        </label>
      </div>
      {!apiAvailable && interactive && <span className="climate-control__api-note">Проверяем доступность управления…</span>}
    </section>
  );
}
