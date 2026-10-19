import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import {
  executeHomeAssistantAction, fetchHomeAssistantActionAvailability, newHomeAssistantRequestId,
  LIGHT_STRIP_POWER_ON, LIGHT_STRIP_POWER_OFF, LIGHT_STRIP_SET_BRIGHTNESS,
  LIGHT_STRIP_SET_COLOR, LIGHT_STRIP_SET_TEMPERATURE, LIGHT_STRIP_SET_EFFECT,
  type HomeAssistantActionAvailability, type LightStripActionId
} from "./homeAssistantControlApi";
import "./LightStripControl.css";

interface Favorite {
  key: string;
  count: number;
  effect: string | null;
  hsColor: [number, number] | null;
  colorTempKelvin: number | null;
}

interface LightData {
  state?: "on" | "off" | "unavailable";
  available?: boolean;
  stale?: boolean;
  brightness?: number | null;
  hsColor?: [number, number] | null;
  rgbColor?: [number, number, number] | null;
  colorTempKelvin?: number | null;
  minColorTempKelvin?: number | null;
  maxColorTempKelvin?: number | null;
  effect?: string | null;
  effects?: string[];
  supportedColorModes?: string[];
  favorites?: Favorite[];
}

const palette: Record<string, string> = {
  "Мягкий белый": "#ffe7c5", "Теплый белый": "#ffd5a0", "Белый": "#ffffff",
  "Дневной белый": "#f4f7ff", "Холодный белый": "#d9ecff", "Красный": "#f44743",
  "Коралловый": "#ff735f", "Оранжевый": "#ff933e", "Желтый": "#ffd34a",
  "Салатовый": "#b7ed54", "Зеленый": "#49c76f", "Изумрудный": "#40b99d",
  "Бирюзовый": "#43d4cc", "Голубой": "#62bded", "Синий": "#547cf0",
  "Лунный": "#a8beef", "Сиреневый": "#b39bee", "Фиолетовый": "#8468d9",
  "Пурпурный": "#c368dd", "Розовый": "#f492c9", "Малиновый": "#e6539b",
  "Лиловый": "#ca9ae9"
};

const scenes: Record<string, string> = {
  "Рассвет": "linear-gradient(135deg,#ffbf6d,#f77087,#8f74d4)",
  "Закат": "linear-gradient(135deg,#ffd17a,#f08350,#a54872)",
  "Циркадный": "linear-gradient(135deg,#f4d1a0,#f7f8fa,#b8d8ff)",
  "Вечеринка": "linear-gradient(135deg,#f146a3,#794cff,#23c7ec)",
  "Гирлянда": "linear-gradient(135deg,#e7565d 25%,#edc84e 25% 50%,#5acfa0 50% 75%,#6b8fe8 75%)",
  "Джунгли": "linear-gradient(135deg,#164d54,#44aa6e,#c6d454)",
  "Неон": "linear-gradient(135deg,#ff44c2,#6160fa,#34ded3)",
  "Ночь": "linear-gradient(135deg,#192d67,#4658a4,#9d8bc6)",
  "Океан": "linear-gradient(135deg,#153d8c,#2676bd,#4fd8d1)",
  "Отдых": "linear-gradient(135deg,#e5a9b8,#bcb0e5,#89bccc)",
  "Романтика": "linear-gradient(135deg,#f66a85,#b64f97,#803e8d)",
  "Свеча": "linear-gradient(135deg,#f5c674,#f08c3f,#d85b38)",
  "Сирена": "linear-gradient(135deg,#e2394a 50%,#3361d8 50%)",
  "Тревога": "linear-gradient(135deg,#f14842,#a42630)",
  "Ужин": "linear-gradient(135deg,#f6b567,#da7b5f,#b15d6c)",
  "Фантазия": "linear-gradient(135deg,#7c52db,#dd62ae,#57caca)",
  "Чтение": "linear-gradient(135deg,#f7e2af,#e8c17a)"
};

function effectSwatch(name: string): string {
  return palette[name] ?? scenes[name] ?? "linear-gradient(135deg,#91a2af,#c2b2d4)";
}

function temperatureSwatch(kelvin: number): string {
  const fraction = Math.max(0, Math.min(1, (kelvin - 2700) / 3800));
  return `color-mix(in srgb, #ffd19a ${(1 - fraction) * 100}%, #dbeaff)`;
}

function favoriteSwatch(favorite: Favorite): string {
  if (favorite.effect) return effectSwatch(favorite.effect);
  if (favorite.hsColor) return `hsl(${favorite.hsColor[0]} ${favorite.hsColor[1]}% 55%)`;
  if (favorite.colorTempKelvin) return temperatureSwatch(favorite.colorTempKelvin);
  return "#aaa";
}

function favoriteLabel(favorite: Favorite): string {
  if (favorite.effect) return favorite.effect;
  if (favorite.colorTempKelvin) return `${favorite.colorTempKelvin} K`;
  if (favorite.hsColor) return `Цвет ${favorite.hsColor[0]}°, ${favorite.hsColor[1]}%`;
  return "Цвет";
}

function hexToHs(hex: string): [number, number] {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(...channels), min = Math.min(...channels), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === channels[0]) hue = ((channels[1] - channels[2]) / delta) % 6;
    else if (max === channels[1]) hue = (channels[2] - channels[0]) / delta + 2;
    else hue = (channels[0] - channels[1]) / delta + 4;
  }
  return [Math.round((hue * 60 + 360) % 360), Math.round(max ? delta / max * 100 : 0)];
}

export function LightStripControl({ service, variant = "home", interactive = true }: {
  service: ServiceSnapshot;
  variant?: "home" | "overview";
  interactive?: boolean;
}) {
  const data = service.data as LightData;
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation, locked } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<HomeAssistantActionAvailability | null>(null);
  const [pending, setPending] = useState<LightStripActionId | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftBrightness, setDraftBrightness] = useState(data.brightness ?? 255);
  const [customColor, setCustomColor] = useState("#ff6e54");
  const [draftKelvin, setDraftKelvin] = useState(data.colorTempKelvin ?? 4000);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const live = service.source === "live" && service.health === "healthy" && data.available !== false && !data.stale;
  const enabled = interactive && !locked && live && !pending;
  const effects = data.effects ?? [];
  const colors = effects.filter((effect) => Object.prototype.hasOwnProperty.call(palette, effect));
  const modes = effects.filter((effect) => !Object.prototype.hasOwnProperty.call(palette, effect));
  const favorites = (data.favorites ?? []).slice(0, 4);
  const minimumKelvin = data.minColorTempKelvin ?? 2700;
  const maximumKelvin = data.maxColorTempKelvin ?? 6500;

  const refresh = useCallback(async () => {
    try { setAvailability(await fetchHomeAssistantActionAvailability()); }
    catch { setAvailability(null); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => setDraftBrightness(data.brightness ?? 255), [data.brightness]);
  useEffect(() => setDraftKelvin(data.colorTempKelvin ?? 4000), [data.colorTempKelvin]);
  useEffect(() => {
    if (!pickerOpen) return;
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
    };
    window.addEventListener("keydown", closeOnEscape);
    const opener = pickerButton.current;
    return () => { window.removeEventListener("keydown", closeOnEscape); opener?.focus(); };
  }, [pickerOpen]);

  const run = useCallback(async (actionId: LightStripActionId, values: { brightness?: number; hsColor?: [number, number]; kelvin?: number; effect?: string } = {}) => {
    if (!enabled || !guardMutation()) return;
    let decision = availability?.actions[actionId];
    if (!decision) {
      try { decision = (await fetchHomeAssistantActionAvailability()).actions[actionId]; }
      catch { /* The notice below explains unavailable control. */ }
    }
    if (decision?.availability === "elevation_required") {
      if (await ensureCapability(actionId, "Лента в зале")) {
        try { decision = (await fetchHomeAssistantActionAvailability()).actions[actionId]; }
        catch { decision = undefined; }
      }
    }
    if (!decision?.allowed) {
      showNotice({ id: "home.light_strip.action", severity: "warning", title: "Лента в зале", detail: decision ? explainAvailability(decision.availability) : "Управление сейчас недоступно.", timeoutMs: 6000 });
      return;
    }
    if (!guardMutation()) return;
    setPending(actionId);
    showNotice({ id: "home.light_strip.action", severity: "progress", title: "Лента в зале", detail: "Отправляем команду и ждём подтверждения…" });
    try {
      await executeHomeAssistantAction({ actionId, requestId: newHomeAssistantRequestId(), ...values });
      showNotice({ id: "home.light_strip.action", severity: "success", title: "Лента в зале", detail: "Home Assistant подтвердил изменение.", timeoutMs: 4000 });
      await refresh();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      showNotice({ id: "home.light_strip.action", severity: "error", title: "Лента в зале", detail: code === "ha_verification_timeout" ? "Не удалось подтвердить изменение состояния." : "Не удалось изменить состояние ленты.", timeoutMs: 8000 });
    } finally { setPending(null); }
  }, [availability, enabled, ensureCapability, explainAvailability, guardMutation, refresh, showNotice]);

  const canUse = (actionId: LightStripActionId) => {
    const decision = availability?.actions[actionId];
    return Boolean(enabled && decision && (decision.allowed || decision.availability === "elevation_required"));
  };

  const chooseFavorite = (favorite: Favorite) => {
    if (favorite.effect) void run(LIGHT_STRIP_SET_EFFECT, { effect: favorite.effect });
    else if (favorite.hsColor) void run(LIGHT_STRIP_SET_COLOR, { hsColor: favorite.hsColor });
    else if (favorite.colorTempKelvin) void run(LIGHT_STRIP_SET_TEMPERATURE, { kelvin: favorite.colorTempKelvin });
  };
  const currentSwatch = data.effect ? effectSwatch(data.effect)
    : data.rgbColor ? `rgb(${data.rgbColor.join(" ")})`
    : data.colorTempKelvin ? temperatureSwatch(data.colorTempKelvin) : "#879399";
  const status = !live ? (data.stale ? "Данные устарели" : "Недоступна") : data.state === "on" ? "Включена" : "Выключена";

  return <section className={`light-strip light-strip--${variant}`} data-testid={`light-strip-${variant}`} aria-label="Лента в зале">
    <header className="light-strip__header">
      <span className="light-strip__identity"><span className="light-strip__lamp" style={{ background: currentSwatch }} aria-hidden="true" /><span><strong>Лента в зале</strong><small>{status}</small></span></span>
      <button className="light-strip__power" type="button" aria-label={data.state === "on" ? "Выключить ленту" : "Включить ленту"} aria-pressed={data.state === "on"} disabled={!canUse(data.state === "on" ? LIGHT_STRIP_POWER_OFF : LIGHT_STRIP_POWER_ON)} onClick={() => void run(data.state === "on" ? LIGHT_STRIP_POWER_OFF : LIGHT_STRIP_POWER_ON)}>{data.state === "on" ? "Выкл" : "Вкл"}</button>
    </header>
    <div className="light-strip__brightness">
      <label htmlFor={`light-brightness-${variant}`}>Яркость <output>{Math.round(draftBrightness / 255 * 100)}%</output></label>
      <input id={`light-brightness-${variant}`} type="range" min="1" max="255" value={draftBrightness} disabled={!canUse(LIGHT_STRIP_SET_BRIGHTNESS) || data.state !== "on"} onChange={(event) => setDraftBrightness(Number(event.target.value))} onPointerUp={(event) => { const value = Number(event.currentTarget.value); if (value !== data.brightness) void run(LIGHT_STRIP_SET_BRIGHTNESS, { brightness: value }); }} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void run(LIGHT_STRIP_SET_BRIGHTNESS, { brightness: Number(event.currentTarget.value) }); }} />
    </div>
    <div className="light-strip__favorites"><span className="light-strip__caption">Часто выбираете</span><div className="light-strip__swatches">
      {favorites.length ? favorites.map((favorite) => {
        const mode = Boolean(favorite.effect && !Object.prototype.hasOwnProperty.call(palette, favorite.effect));
        return <button key={favorite.key} type="button" className={mode ? "light-strip__favorite-mode" : "light-strip__swatch"} style={mode ? undefined : { background: favoriteSwatch(favorite) }} title={`${favoriteLabel(favorite)} · ${favorite.count} раз`} aria-label={`${favoriteLabel(favorite)}, выбран ${favorite.count} раз`} disabled={!canUse(favorite.effect ? LIGHT_STRIP_SET_EFFECT : favorite.hsColor ? LIGHT_STRIP_SET_COLOR : LIGHT_STRIP_SET_TEMPERATURE) || data.state !== "on"} onClick={() => chooseFavorite(favorite)}>{mode && <><span className="light-strip__mode-mark" style={{ background: favoriteSwatch(favorite) }} aria-hidden="true" />{favorite.effect}</>}</button>;
      }) : <span className="light-strip__empty">Появятся после первых переключений</span>}
    </div><button ref={pickerButton} type="button" className="light-strip__more" disabled={!interactive || locked} onClick={() => setPickerOpen(true)} aria-label="Открыть выбор цвета и режима">Цвета и режимы</button></div>
    {pickerOpen && createPortal(<div className="light-strip__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}><div className="light-strip__dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="light-picker-title" tabIndex={-1}>
      <header><div><strong id="light-picker-title">Цвета и режимы</strong><small>Возможности ленты из Home Assistant</small></div><button type="button" className="light-strip__close" onClick={() => setPickerOpen(false)} aria-label="Закрыть выбор цвета и режима">×</button></header>
      <div className="light-strip__dialog-body">{data.state !== "on" && <p>Сначала включите ленту, затем выберите цвет.</p>}
      <div className="light-strip__choices">
        <section className="light-strip__choice-column" aria-labelledby="light-picker-colors"><h3 id="light-picker-colors">Цвета</h3><div className="light-strip__palette">{colors.map((effect) => <button key={effect} type="button" className={`light-strip__swatch light-strip__swatch--picker${data.effect === effect ? " is-active" : ""}`} style={{ background: effectSwatch(effect) }} title={effect} aria-label={effect} disabled={!canUse(LIGHT_STRIP_SET_EFFECT) || data.state !== "on"} onClick={() => { void run(LIGHT_STRIP_SET_EFFECT, { effect }); setPickerOpen(false); }} />)}</div></section>
        <section className="light-strip__choice-column" aria-labelledby="light-picker-modes"><h3 id="light-picker-modes">Режимы</h3><div className="light-strip__modes">{modes.map((effect) => <button key={effect} type="button" className={`light-strip__mode${data.effect === effect ? " is-active" : ""}`} disabled={!canUse(LIGHT_STRIP_SET_EFFECT) || data.state !== "on"} onClick={() => { void run(LIGHT_STRIP_SET_EFFECT, { effect }); setPickerOpen(false); }}><span className="light-strip__mode-mark" style={{ background: effectSwatch(effect) }} aria-hidden="true" />{effect}</button>)}</div></section>
      </div>
      {data.supportedColorModes?.includes("hs") && <div className="light-strip__custom"><label htmlFor="light-custom-color">Свой цвет</label><input id="light-custom-color" type="color" value={customColor} disabled={!canUse(LIGHT_STRIP_SET_COLOR) || data.state !== "on"} onChange={(event) => setCustomColor(event.target.value)} /><button type="button" disabled={!canUse(LIGHT_STRIP_SET_COLOR) || data.state !== "on"} onClick={() => { void run(LIGHT_STRIP_SET_COLOR, { hsColor: hexToHs(customColor) }); setPickerOpen(false); }}>Применить</button></div>}
      {data.supportedColorModes?.includes("color_temp") && <div className="light-strip__temperature"><label htmlFor="light-temperature">Белый свет <output>{draftKelvin} K</output></label><input id="light-temperature" type="range" min={minimumKelvin} max={maximumKelvin} step="100" value={draftKelvin} disabled={!canUse(LIGHT_STRIP_SET_TEMPERATURE) || data.state !== "on"} onChange={(event) => setDraftKelvin(Number(event.target.value))} /><button type="button" disabled={!canUse(LIGHT_STRIP_SET_TEMPERATURE) || data.state !== "on"} onClick={() => { void run(LIGHT_STRIP_SET_TEMPERATURE, { kelvin: draftKelvin }); setPickerOpen(false); }}>Применить</button></div>}
      </div></div></div>, document.body)}
  </section>;
}
