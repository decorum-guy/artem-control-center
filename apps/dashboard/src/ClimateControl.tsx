import { SelectField } from "./ui/SelectField";
import { v3VisualSkinEnabled } from "./visualShellConfig";
import { TemperatureGauge } from "./ui/RingGauge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { Icon } from "./icons";
import { useCommandSeries } from "./useCommandSeries";
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
    case "ha_transport_uncertain":
      return "Результат команды не подтверждён. Проверяем состояние кондиционера.";
    case "ha_action_busy":
      return "Кондиционер уже выполняет другую команду.";
    case "ha_action_disabled":
    case "gate_disabled":
      return "Управление выключено в настройках возможностей.";
    case "profile_blocked":
      return "Команда недоступна в текущем профиле.";
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

type ClimateIntent = {
  id: ClimateActionId;
  temperature?: number;
  mode?: ClimateHvacMode;
  fanMode?: ClimateFanMode;
  revision?: number;
  powerFence?: number;
};

function turnsOff(intent: ClimateIntent) {
  return intent.id === HOME_CLIMATE_POWER_OFF || intent.mode === "off";
}

function isPower(intent: ClimateIntent) {
  return intent.id === HOME_CLIMATE_POWER_ON || turnsOff(intent);
}

export function coalesceClimate(queue: ClimateIntent[], intent: ClimateIntent): ClimateIntent[] {
  if (turnsOff(intent)) return [intent];
  if (isPower(intent)) return [...queue, intent];
  if (intent.id === HOME_CLIMATE_SET_MODE) {
    return queue.at(-1)?.id === HOME_CLIMATE_SET_MODE && !isPower(queue.at(-1)!)
      ? [...queue.slice(0, -1), intent] : [...queue, intent];
  }
  const barrier = queue.reduce((last, item, index) => isPower(item) || item.id === HOME_CLIMATE_SET_MODE ? index : last, -1);
  return queue.filter((item, index) => index <= barrier || item.id !== intent.id).concat(intent);
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
  const { status: accessStatus, ensureCapability, explainAvailability } = useAccess();
  const { guardMutation, locked } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<HomeAssistantActionAvailability | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const data = climateData(service);
  const climateLive = service.health === "healthy" && data.available !== false && data.stale !== true;
  const minimumTemperature = 16;
  const maximumTemperature = 32;
  const targetTemperature = typeof data.targetTemperature === "number" ? data.targetTemperature : null;
  const [confirmed, setConfirmed] = useState({ state: data.state ?? "off", target: targetTemperature, fan: data.fanMode });
  const [draft, setDraft] = useState<{ value: number; revision: number } | null>(null);
  const draftRef = useRef(draft);
  const edit = useRef(0);
  const powerFence = useRef(0);
  const revision = useRef(0);
  const serviceId = useRef(service.id);
  const mounted = useRef(true);
  const availabilityRead = useRef(0);
  const [, redraw] = useState(0);
  const changeDraft = (next: typeof draft) => {
    draftRef.current = next;
    setDraft(next);
  };
  const modes = useMemo(
    () => hvacOrder.filter((mode) => (data.hvacModes ?? []).includes(mode)),
    [data.hvacModes]
  );
  const fans = useMemo(
    () => fanOrder.filter((mode) => (data.fanModes ?? []).includes(mode)),
    [data.fanModes]
  );

  const refresh = useCallback(async (series?: AbortSignal) => {
    const read = ++availabilityRead.current;
    const timeout = AbortSignal.timeout(7_000);
    const signal = series ? AbortSignal.any([series, timeout]) : timeout;
    const isLatest = () => mounted.current && availabilityRead.current === read && !series?.aborted;
    try {
      const next = await fetchHomeAssistantActionAvailability(signal);
      if (isLatest()) {
        setAvailability(next);
        setApiAvailable(true);
      }
      return signal.aborted ? null : next;
    } catch {
      if (isLatest()) {
        setAvailability(null);
        setApiAvailable(false);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setConfirmed({ state: data.state ?? "off", target: targetTemperature, fan: data.fanMode });
    if (serviceId.current !== service.id) {
      serviceId.current = service.id;
      draftRef.current = null;
      setDraft(null);
    }
  }, [service.id, data.state, targetTemperature, data.fanMode]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current++; };
  }, []);

  const queue = useCommandSeries<ClimateIntent, void>({
    mode: "coalesced",
    scope: service.id,
    coalesce: coalesceClimate,
    enabled: interactive && !locked && climateLive && accessStatus?.effectiveProfile !== "read_only",
    onProgress: () => redraw(value => value + 1),
    dispatch: async (intent, signal) => {
      const guardRevision = revision.current;
      const identity = service.id;
      const decision = (await refresh(signal))?.actions[intent.id];
      if (signal.aborted || !guardMutation() || !mounted.current || identity !== serviceId.current
          || guardRevision !== revision.current) throw new Error("queue_closed");
      if (!decision?.allowed) {
        if (decision?.availability === "elevation_required") {
          if (!await ensureCapability(intent.id, "Кондиционер")) throw new Error("profile_blocked");
        } else {
          throw new Error(decision?.availability === "busy" ? "ha_action_busy" : decision?.availability ?? "ha_entity_unavailable");
        }
      }
      if (signal.aborted || !guardMutation() || guardRevision !== revision.current) throw new Error("queue_closed");
      if (!turnsOff(intent) && intent.powerFence !== powerFence.current) return;
      const requestId = newHomeAssistantRequestId();
      const response = await executeHomeAssistantAction({
        actionId: intent.id, requestId, temperature: intent.temperature ?? null,
        mode: intent.mode ?? null, fanMode: intent.fanMode ?? null
      }, AbortSignal.timeout(26_000)).catch(error => {
        if (error instanceof DOMException || error instanceof TypeError) throw new Error("ha_transport_uncertain");
        throw error;
      });
      if (response.requestId !== requestId || response.actionId !== intent.id || response.status !== "confirmed" || !response.climate) {
        throw new Error("ha_transport_uncertain");
      }
      if (mounted.current && identity === serviceId.current) {
        setConfirmed({ state: response.climate.state, target: response.climate.targetTemperature, fan: response.climate.fanMode });
        if (intent.revision !== undefined && draftRef.current?.revision === intent.revision) changeDraft(null);
      }
    },
    onFinish: (result) => {
      if (result.cancelled) return;
      const error = result.error instanceof Error ? result.error.message : null;
      if (error === "queue_closed") return;
      showNotice({
        id: "home.climate.action", title: "Кондиционер", severity: error ? "warning" : "success",
        detail: error ? actionErrorCopy(error) : "Изменение подтверждено Home Assistant.", timeoutMs: error ? 10_000 : 6_000
      });
      void refresh();
    }
  });

  const submitted = queue.pending();
  const isPending = (action: ClimateActionId) => submitted.some(intent => intent.id === action);
  const powerPending = submitted.some(intent => isPower(intent) || intent.id === HOME_CLIMATE_SET_MODE);
  const canUse = (action: ClimateActionId) => {
    const decision = availability?.actions[action];
    return interactive && !locked && climateLive && accessStatus?.effectiveProfile !== "read_only" && Boolean(
      decision && (decision.allowed || decision.availability === "elevation_required" ||
        (decision.availability === "busy" && queue.isActive() && decision.gateEnabled && decision.integrationAvailable)));
  };
  const submit = (intent: ClimateIntent) => {
    if (!canUse(intent.id) || !guardMutation()) return false;
    if (turnsOff(intent)) powerFence.current++;
    if (!queue.submit({ ...intent, powerFence: powerFence.current })) {
      showNotice({ id: "home.climate.action", title: "Кондиционер", severity: "warning",
        detail: "Ожидают подтверждения несколько команд.", timeoutMs: 4_000 });
      return false;
    }
    return true;
  };

  const state = confirmed.state;
  const powerFor = (pending: ClimateIntent[]) => {
    const choice = pending.slice().reverse().find(intent => isPower(intent) || intent.id === HOME_CLIMATE_SET_MODE);
    const on = choice ? !turnsOff(choice) : state !== "off";
    return on ? HOME_CLIMATE_POWER_OFF : HOME_CLIMATE_POWER_ON;
  };
  const powerAction = powerFor(submitted);
  const stateLabel = climateHvacLabels[state] ?? "Состояние неизвестно";
  const statusLabel = !climateLive
    ? service.health === "stale" || data.stale ? "Данные устарели" : "Недоступен"
    : stateLabel;
  const intendedMode = submitted.slice().reverse().find(intent => intent.mode)?.mode;
  const displayMode = intendedMode ?? state;
  const selectedMode = modes.includes(displayMode) ? displayMode : modes[0] ?? "off";
  const intendedFan = submitted.slice().reverse().find(intent => intent.fanMode)?.fanMode ?? confirmed.fan;
  const selectedFan = intendedFan && fans.includes(intendedFan) ? intendedFan : fans[0] ?? "one";
  const queuedTemperature = submitted.slice().reverse().find(intent => intent.temperature !== undefined)?.temperature;
  const draftTarget = draft?.value ?? queuedTemperature ?? confirmed.target;
  const targetDirty = draft !== null && draft.value !== (queuedTemperature ?? confirmed.target);
  const temperaturePending = isPending(HOME_CLIMATE_SET_TEMPERATURE);
  const updateDraft = (delta: number) => {
    if (!canUse(HOME_CLIMATE_SET_TEMPERATURE)) return;
    const base = draftRef.current?.value ?? queuedTemperature ?? confirmed.target;
    if (base !== null) changeDraft({ value: Math.min(maximumTemperature, Math.max(minimumTemperature, base + delta)), revision: ++edit.current });
  };
  const confirmDraft = () => {
    const next = draftRef.current;
    const last = queue.pending().slice().reverse().find(intent => intent.temperature !== undefined)?.temperature;
    if (next && next.value !== (last ?? confirmed.target)) {
      submit({ id: HOME_CLIMATE_SET_TEMPERATURE, temperature: next.value, revision: next.revision });
    }
  };

  return (
    <section
      className={`climate-control climate-control--${variant}${!climateLive ? " climate-control--unavailable" : ""}`}
      data-testid={`climate-control-${variant}`}
      data-instrument-active={v3VisualSkinEnabled ? climateLive && state !== "off" : undefined}
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
          aria-label={powerAction === HOME_CLIMATE_POWER_ON ? "Включить кондиционер" : "Выключить кондиционер"}
          aria-pressed={state !== "off"}
          aria-busy={powerPending}
          onClick={() => submit({ id: powerFor(queue.pending()) })}
          title={availability?.actions[powerAction] ? climateAvailabilityCopy(availability.actions[powerAction].availability, explainAvailability) : "Проверяем доступность"}
        >
          {powerPending ? <Icon name="refresh" size={20} className="climate-control__pending-icon" /> : <Icon name="power" size={22} />}
        </button>

        <div className="climate-control__temperature-control" aria-label="Целевая температура">
          <span className="climate-control__target-value" data-testid={`climate-temperature-value-${variant}`}>
            {v3VisualSkinEnabled ? <TemperatureGauge value={draftTarget} tone="accent" label="Целевая температура"
              reading={climateLive && draftTarget !== null ? { kind: "progress", fraction: (draftTarget - minimumTemperature) / (maximumTemperature - minimumTemperature) } : { kind: "unavailable" }} /> : String(draftTarget ?? "—") + "°"}
          </span>
          <button
            type="button"
            className="climate-control__stepper"
            data-testid={`climate-temperature-decrease-${variant}`}
            disabled={!canUse(HOME_CLIMATE_SET_TEMPERATURE) || draftTarget === null || draftTarget <= minimumTemperature}
            onClick={() => updateDraft(-1)}
            aria-label="Уменьшить целевую температуру"
          >
            <Icon name="minus" size={24} />
          </button>
          <button
            type="button"
            className="climate-control__stepper"
            data-testid={`climate-temperature-increase-${variant}`}
            disabled={!canUse(HOME_CLIMATE_SET_TEMPERATURE) || draftTarget === null || draftTarget >= maximumTemperature}
            onClick={() => updateDraft(1)}
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
            onClick={confirmDraft}
          >
            {temperaturePending ? <Icon name="refresh" size={20} className="climate-control__pending-icon" /> : <Icon name="check" size={20} />}
          </button>
        </div>

        <label className="climate-control__select-label climate-control__mode-label" aria-busy={isPending(HOME_CLIMATE_SET_MODE)}>
          <span>Режим</span>
          <SelectField
            value={selectedMode}
            disabled={!canUse(HOME_CLIMATE_SET_MODE) || !modes.length}
            onValueChange={(nextValue) => submit({ id: HOME_CLIMATE_SET_MODE, mode: nextValue as ClimateHvacMode })}
            aria-label="Режим кондиционера"
          >
            {modes.map((mode) => <option key={mode} value={mode}>{climateHvacLabels[mode]}</option>)}
          </SelectField>
        </label>

        <label className="climate-control__select-label climate-control__fan-label" aria-busy={isPending(HOME_CLIMATE_SET_FAN_MODE)}>
          <span>Скорость вентилятора</span>
          <SelectField
            value={selectedFan}
            disabled={!canUse(HOME_CLIMATE_SET_FAN_MODE) || !fans.length}
            onValueChange={(nextValue) => submit({ id: HOME_CLIMATE_SET_FAN_MODE, fanMode: nextValue as ClimateFanMode })}
            aria-label="Скорость вентилятора"
          >
            {fans.map((fan) => <option key={fan} value={fan}>Скорость {climateFanLabels[fan]}</option>)}
          </SelectField>
        </label>
      </div>
      {!apiAvailable && interactive && <span className="climate-control__api-note">Проверяем доступность управления…</span>}
    </section>
  );
}
