import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KettleData, ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import {
  executeHomeAssistantAction, fetchHomeAssistantActionAvailability,
  HOME_KETTLE_BOIL, HOME_KETTLE_SET_TEA_MODE, newHomeAssistantRequestId,
  type HomeAssistantActionAvailability, type KettleActionId, type KettleTeaMode
} from "./homeAssistantControlApi";
import "./KettleControl.css";

export const kettleTeaLabels: Record<KettleTeaMode, string> = {
  white_tea: "Белый чай", green_tea: "Зелёный чай", red_tea: "Красный чай",
  herbal_tea: "Травяной чай", flower_tea: "Цветочный чай", puerh_tea: "Пуэр",
  oolong_tea: "Улун", black_tea: "Чёрный чай"
};
const teaOrder = Object.keys(kettleTeaLabels) as KettleTeaMode[];
const rowHeight = 56;

function status(data: KettleData, service: ServiceSnapshot): string {
  if (data.stale || service.health === "stale") return "Данные устарели";
  if (!data.available || service.health === "offline" || data.stage === "unavailable") return "Недоступен";
  if (data.stage === "off") return "Выключен";
  if (data.operationMode && data.operationMode in kettleTeaLabels) return kettleTeaLabels[data.operationMode as KettleTeaMode];
  if (data.operationMode === "on") return data.targetTemperature === 100 ? "Нагрев до 100°" : "Нагрев";
  return "Состояние неизвестно";
}

function errorCopy(code: string): string {
  if (code === "ha_service_failed") return "Home Assistant не принял команду.";
  if (code === "ha_verification_timeout") return "Home Assistant не подтвердил состояние вовремя.";
  if (code === "ha_entity_unavailable" || code === "ha_integration_unavailable") return "Состояние чайника сейчас недоступно.";
  return "Команда чайника не выполнена.";
}

export function KettleControl({ service, variant = "home", interactive = true }: { service: ServiceSnapshot; variant?: "home" | "overview"; interactive?: boolean }) {
  const data = service.data as unknown as KettleData;
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation, locked } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<HomeAssistantActionAvailability | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<KettleTeaMode | null>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => teaOrder.filter((mode) => data.availableTeaModes?.includes(mode)), [data.availableTeaModes]);
  const live = service.health === "healthy" && data.available && !data.stale && data.stage !== "unavailable";
  const currentTemperature = typeof data.currentTemperature === "number" && Number.isFinite(data.currentTemperature) ? `${data.currentTemperature}°` : "—°";

  const refresh = useCallback(async () => {
    try {
      const result = await fetchHomeAssistantActionAvailability();
      setAvailability(result);
      return result;
    } catch {
      setAvailability(null);
      return null;
    }
  }, []);
  useEffect(() => {
    if (!interactive) setPickerOpen(false);
  }, [interactive]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !pendingRef.current) setPickerOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pickerOpen]);

  const canUse = (actionId: KettleActionId) => {
    const decision = availability?.actions[actionId];
    return Boolean(interactive && live && !locked && !pending && decision && (decision.allowed || decision.availability === "elevation_required"));
  };
  const run = async (actionId: KettleActionId, teaMode?: KettleTeaMode) => {
    if (!interactiveRef.current || !live || pendingRef.current || !guardMutation()) return;
    pendingRef.current = true;
    setPending(true);
    try {
      let decision = availability?.actions[actionId] ?? (await refresh())?.actions[actionId];
      if (decision?.availability === "elevation_required") {
        const elevated = await ensureCapability(actionId, "Чайник");
        if (elevated) decision = (await refresh())?.actions[actionId] ?? decision;
      }
      if (!decision?.allowed) {
        showNotice({ id: "home.kettle.action", severity: "warning", title: "Чайник", detail: decision ? explainAvailability(decision.availability) : "Управление чайником сейчас недоступно.", timeoutMs: 6_000 });
        return;
      }
      if (!interactiveRef.current || !guardMutation()) return;
      showNotice({ id: "home.kettle.action", severity: "progress", title: "Чайник", detail: "Отправляем команду и ждём подтверждение…" });
      await executeHomeAssistantAction({ actionId, requestId: newHomeAssistantRequestId(), ...(teaMode ? { teaMode } : {}) });
      showNotice({ id: "home.kettle.action", severity: "success", title: "Чайник", detail: "Изменение подтверждено Home Assistant.", timeoutMs: 6_000 });
      setPickerOpen(false);
      await refresh();
    } catch (error) {
      showNotice({ id: "home.kettle.action", severity: "error", title: "Чайник", detail: errorCopy(error instanceof Error ? error.message : "action_failed"), timeoutMs: 10_000 });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const openPicker = () => {
    if (!canUse(HOME_KETTLE_SET_TEA_MODE) || options.length === 0) return;
    const initial = data.operationMode && options.includes(data.operationMode as KettleTeaMode) ? data.operationMode as KettleTeaMode : options[0];
    setSelected(initial);
    setPickerOpen(true);
    requestAnimationFrame(() => { if (wheelRef.current) wheelRef.current.scrollTop = options.indexOf(initial) * rowHeight; });
  };
  const onWheelScroll = () => {
    const index = Math.max(0, Math.min(options.length - 1, Math.round((wheelRef.current?.scrollTop ?? 0) / rowHeight)));
    setSelected(options[index] ?? null);
  };

  return <section className={`kettle-control kettle-control--${variant}`} data-testid="kettle-control" aria-label="Чайник">
    <h2>Чайник</h2>
    <p className="kettle-control__temperature-label" aria-hidden="true">Текущая температура:</p>
    <div className="kettle-control__temperature" data-testid="kettle-current-temperature" aria-label={`Текущая температура воды ${currentTemperature}`}>{currentTemperature}</div>
    <p className="kettle-control__status" role="status">{status(data, service)}</p>
    <div className="kettle-control__actions">
      <button type="button" disabled={!canUse(HOME_KETTLE_BOIL)} onClick={() => void run(HOME_KETTLE_BOIL)}>Включить</button>
      <button type="button" disabled={!canUse(HOME_KETTLE_SET_TEA_MODE) || options.length === 0} onClick={openPicker}>Выбрать чай</button>
    </div>
    {!live && <p className="kettle-control__notice">Управление отключено до подтверждения свежего состояния.</p>}
    {pickerOpen && interactive && <div className="kettle-picker-backdrop" onClick={() => { if (!pending) setPickerOpen(false); }}>
      <div className="kettle-picker" role="dialog" aria-modal="true" aria-labelledby="kettle-picker-title" onClick={(event) => event.stopPropagation()}>
        <div className="kettle-picker__header"><h3 id="kettle-picker-title">Выбрать чай</h3><button type="button" aria-label="Закрыть" disabled={pending} onClick={() => setPickerOpen(false)}>Закрыть</button></div>
        <div className="kettle-picker__wheel" ref={wheelRef} onScroll={onWheelScroll} aria-label="Виды чая">
          {options.map((mode) => <button key={mode} type="button" className="kettle-picker__option" aria-selected={selected === mode} onClick={() => { if (wheelRef.current) wheelRef.current.scrollTop = options.indexOf(mode) * rowHeight; setSelected(mode); }}>{kettleTeaLabels[mode]}</button>)}
        </div>
        <div className="kettle-picker__actions"><button type="button" disabled={pending} onClick={() => setPickerOpen(false)}>Отмена</button><button type="button" className="kettle-picker__start" disabled={pending || !selected || !canUse(HOME_KETTLE_SET_TEA_MODE)} onClick={() => { if (selected) void run(HOME_KETTLE_SET_TEA_MODE, selected); }}>Запустить</button></div>
      </div>
    </div>}
  </section>;
}
