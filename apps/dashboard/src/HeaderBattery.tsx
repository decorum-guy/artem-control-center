import { useEffect, useState, type CSSProperties } from "react";
import { Icon } from "./icons";
import "./HeaderBattery.css";

type BatteryStatus = {
  percentage: number | null;
  charging: boolean | null;
  pluggedIn: boolean | null;
};

export function HeaderBattery() {
  const [battery, setBattery] = useState<BatteryStatus | null>(null);

  useEffect(() => {
    let request: AbortController | undefined;
    async function refresh() {
      request?.abort();
      if (document.hidden) return;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch("/api/v1/system/battery", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])
        });
        const status: BatteryStatus | null = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setBattery(status);
      } catch {
        if (!controller.signal.aborted) setBattery(null);
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);

  if (!battery) return null;

  const { percentage, charging, pluggedIn } = battery;
  const source = pluggedIn === null ? "" : pluggedIn ? "От сети" : "От батареи";
  const charge = charging === null ? "Статус зарядки неизвестен" : charging ? "Заряжается" : "Не заряжается";
  const level = percentage === null ? "—" : `${percentage}%`;
  const label = [percentage === null ? "Уровень заряда неизвестен" : `Заряд аккумулятора ${level}`, source, charge]
    .filter(Boolean).join(". ");

  return <span className="cc-header-battery" role="img" aria-label={label} title={label}
    data-charging={charging === true || undefined} data-low={percentage !== null && percentage <= 20 || undefined}
    style={{ "--cc-battery-level": `${percentage ?? 0}%` } as CSSProperties}>
    <span className="cc-header-battery-body" aria-hidden="true">
      {level}{charging === true && <Icon name="lightning" size={11} />}
    </span>
  </span>;
}
