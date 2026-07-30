import { useEffect, useState } from "react";
import {
  clearRuntimeShutdownPending,
  markRuntimeShutdownPending
} from "./runtimeLifecycle";
import "./RuntimeControls.css";

type RuntimeAction = "hide" | "shutdown";
type Availability = "loading" | "available" | "unavailable";

interface RuntimeStatus {
  enabled: boolean;
  platform: string;
}

async function runtimeIsStillReachable() {
  await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  try {
    const response = await fetch("/health/live", { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export function RuntimeControls() {
  const [availability, setAvailability] = useState<Availability>("loading");
  const [pending, setPending] = useState<RuntimeAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetch("/api/v1/system/runtime", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Runtime status failed: ${response.status}`);
        return response.json() as Promise<RuntimeStatus>;
      })
      .then((status) => {
        if (active) setAvailability(status.enabled ? "available" : "unavailable");
      })
      .catch(() => {
        if (active) setAvailability("unavailable");
      });

    return () => {
      active = false;
    };
  }, []);

  async function runAction(action: RuntimeAction) {
    if (pending || availability !== "available") return;

    if (
      action === "shutdown" &&
      !window.confirm(
        "Полностью закрыть Artem Control Center? Окно панели и локальные серверы будут остановлены."
      )
    ) {
      return;
    }

    setPending(action);
    setNotice(action === "hide" ? "Скрываем панель…" : "Завершаем работу платформы…");

    if (action === "shutdown") {
      markRuntimeShutdownPending();
    }

    let responseReceived = false;
    try {
      const response = await fetch(`/api/v1/system/runtime/${action}`, {
        method: "POST",
        headers: { "x-panel-intent": "kiosk-control" },
        keepalive: action === "shutdown"
      });
      responseReceived = true;
      if (!response.ok) throw new Error(`Runtime action failed: ${response.status}`);
    } catch {
      if (action === "shutdown" && !responseReceived && !(await runtimeIsStillReachable())) {
        return;
      }
      if (action === "shutdown") {
        clearRuntimeShutdownPending();
      }
      setPending(null);
      setNotice("Действие не выполнено. Проверьте локальный runtime и повторите попытку.");
    }
  }

  const disabled = availability !== "available" || pending !== null;

  return (
    <section className="settings-section runtime-controls" aria-labelledby="runtime-controls-title">
      <div className="runtime-controls-copy">
        <h2 id="runtime-controls-title">Управление панелью</h2>
        <p>
          Скрытие закрывает только полноэкранное окно: локальные сервисы продолжают работать,
          а панель можно вернуть обычным ярлыком запуска.
        </p>
        {availability === "unavailable" && (
          <span className="runtime-controls-status">
            Системные действия доступны только в настроенном Windows kiosk-runtime.
          </span>
        )}
        {notice && <span className="runtime-controls-status" role="status">{notice}</span>}
      </div>
      <div className="runtime-control-actions">
        <button
          className="runtime-hide-button"
          type="button"
          disabled={disabled}
          onClick={() => void runAction("hide")}
        >
          {pending === "hide" ? "Скрываем…" : "Скрыть панель"}
        </button>
        <button
          className="runtime-shutdown-button"
          type="button"
          disabled={disabled}
          onClick={() => void runAction("shutdown")}
        >
          {pending === "shutdown" ? "Закрываем…" : "Полностью закрыть"}
        </button>
      </div>
    </section>
  );
}
