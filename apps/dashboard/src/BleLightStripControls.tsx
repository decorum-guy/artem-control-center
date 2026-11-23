import { useId, useRef, useState } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";

const COLORS = [
  ["red", "Красный", "#ff312d"], ["green", "Зелёный", "#12ca54"], ["blue", "Синий", "#2556fa"],
  ["yellow", "Жёлтый", "#ffdc00"], ["purple", "Фиолетовый", "#a229dd"], ["pink", "Розовый", "#ff357d"],
  ["sky", "Голубой", "#3c9cff"], ["sea", "Светлый морской", "#64ffde"], ["white", "Белый", "#f8f4f3"],
  ["lime", "Салатовый", "#96ff00"],
] as const;

type Command =
  | { operation: "on" | "off" }
  | { operation: "color"; color: typeof COLORS[number][0] }
  | { operation: "brightness"; percent: number };

const ERRORS: Record<string, string> = {
  delivery_uncertain: "Результат отправки неизвестен. Проверьте ленту.",
  ble_unavailable: "Нет связи с лентой.",
  gate_disabled: "Управление лентой отключено.",
  busy: "Bluetooth занят. После проверки связи можно отправить новую команду.",
};

export function BleLightStripControls({ service, variant, interactive }: {
  service: ServiceSnapshot;
  variant: "home" | "overview";
  interactive: boolean;
}) {
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation, locked } = useInteractionLock();
  const [percent, setPercent] = useState("");
  const [receipt, setReceipt] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const brightnessId = useId();
  const data = service.data as Record<string, unknown>;
  const live = data.available === true;
  const checked = typeof data.observedAt === "string" ? new Date(data.observedAt) : null;
  const disabled = !interactive || locked || !live || pending;

  async function send(command: Command, requested: string) {
    if (disabled || inFlight.current || !guardMutation()) return;
    inFlight.current = true;
    setPending(true);
    setReceipt("Отправка…");
    const suffix = command.operation === "on" || command.operation === "off"
      ? `power_${command.operation}` : `set_${command.operation}`;
    try {
      if (!await ensureCapability(`home.light_strip.${suffix}`, "Лента в зале") || !guardMutation()) {
        setReceipt("Управление недоступно в текущем профиле.");
        return;
      }
      const response = await fetch("/api/v1/ble-strip/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Panel-Intent": "ble-strip" },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (response.ok && result.outcome === "write_completed") {
        setReceipt(`Команда отправлена · ${requested}`);
      } else {
        const detail = typeof result.detail === "string" ? result.detail : "integration_unavailable";
        setReceipt(ERRORS[detail] ?? explainAvailability(detail));
      }
    } catch {
      setReceipt("Результат отправки неизвестен. Проверьте ленту.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <section className={`light-strip light-strip--${variant} light-strip--ble`} data-testid={`light-strip-${variant}`} aria-label="Лента в зале">
    <header className="light-strip__header">
      <span className="light-strip__identity">
        <span className="light-strip__lamp" aria-hidden="true" />
        <span><strong>Лента в зале</strong><small>{live ? "Bluetooth на связи" : "Поиск ленты по Bluetooth"}</small></span>
      </span>
      <div className="light-strip__ble-controls">
        <button className="light-strip__power" type="button" disabled={disabled} onClick={() => void send({ operation: "on" }, "включить")}>Вкл</button>
        <button className="light-strip__power" type="button" disabled={disabled} onClick={() => void send({ operation: "off" }, "выключить")}>Выкл</button>
      </div>
    </header>
    <div className="light-strip__swatches" aria-label="Цвета">{COLORS.map(([color, label, swatch]) =>
      <button key={color} className="light-strip__swatch" type="button" style={{ background: swatch }}
        aria-label={label} title={label} disabled={disabled}
        onClick={() => void send({ operation: "color", color }, label)} />
    )}</div>
    <form className="light-strip__ble-controls" onSubmit={(event) => {
      event.preventDefault();
      if (percent) void send({ operation: "brightness", percent: Number(percent) }, `яркость ${percent}%`);
    }}>
      <label htmlFor={brightnessId}>Яркость</label>
      <select id={brightnessId} value={percent} disabled={disabled} onChange={(event) => setPercent(event.currentTarget.value)}>
        <option value="" disabled>Выбрать</option>
        {[20, 40, 60, 80, 100].map((value) => <option key={value} value={value}>{value}%</option>)}
      </select>
      <button className="light-strip__more" type="submit" disabled={disabled || !percent}>Отправить</button>
    </form>
    <small className="light-strip__caption">Состояние ленты неизвестно{checked && Number.isFinite(checked.getTime()) && <>
      {" · Связь проверена в "}<time dateTime={checked.toISOString()}>{checked.toLocaleTimeString()}</time>
    </>}</small>
    <div className="light-strip__ble-receipt" role="status">{receipt}</div>
  </section>;
}
