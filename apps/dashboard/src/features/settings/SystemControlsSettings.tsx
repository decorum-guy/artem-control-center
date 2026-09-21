import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useInteractionLock } from "../../InteractionLock";
import {
  fetchSystemControls,
  setSystemControl,
  type SystemControlName,
  type SystemControlStatus,
  type SystemControlsStatus
} from "./systemControlsApi";

const labels: Record<SystemControlName, { title: string; description: string }> = {
  volume: {
    title: "Громкость",
    description: "Основной выход Windows"
  },
  brightness: {
    title: "Яркость",
    description: "Встроенный экран Samsung"
  }
};

function initialDraft(): Record<SystemControlName, number> {
  return { volume: 0, brightness: 0 };
}

function availabilityCopy(control: SystemControlStatus, locked: boolean): string {
  if (locked) return "Панель заблокирована";
  if (!control.available) {
    return control.reason === "unsupported"
      ? "Не поддерживается этим устройством"
      : "Сейчас недоступно";
  }
  if (control.writable) return "Изменение применится после отпускания";
  if (control.writeAvailability === "gate_disabled") return "Изменения отключены";
  if (control.writeAvailability === "profile_blocked") return "Недоступно в текущем профиле";
  if (control.writeAvailability === "elevation_required") return "Требуется полный доступ";
  return "Изменение сейчас недоступно";
}

export function SystemControlsSettings() {
  const { locked, guardMutation } = useInteractionLock();
  const [status, setStatus] = useState<SystemControlsStatus | null>(null);
  const [draft, setDraft] = useState<Record<SystemControlName, number>>(initialDraft);
  const [pending, setPending] = useState<SystemControlName | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const acceptStatus = useCallback((next: SystemControlsStatus) => {
    setStatus(next);
    setDraft((current) => ({
      volume: next.controls.volume.value ?? current.volume,
      brightness: next.controls.brightness.value ?? current.brightness
    }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchSystemControls();
      acceptStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  }, [acceptStatus]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function commit(control: SystemControlName) {
    if (pending !== null) return;
    const current = status?.controls[control];
    if (!current || !current.available || current.value === null) return;
    if (draft[control] === current.value) return;
    if (!guardMutation()) {
      setDraft((value) => ({ ...value, [control]: current.value as number }));
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!current.writable) {
      setDraft((value) => ({ ...value, [control]: current.value as number }));
      setNotice(availabilityCopy(current, false));
      return;
    }

    setPending(control);
    setNotice(null);
    try {
      const next = await setSystemControl(control, draft[control]);
      acceptStatus(next);
      const applied = next.controls[control].value;
      setNotice(
        applied === null
          ? "Не удалось подтвердить новое значение."
          : `${labels[control].title}: ${applied}%`
      );
    } catch {
      await refresh();
      setNotice("Не удалось применить изменение. Показано подтверждённое значение Windows.");
    } finally {
      setPending(null);
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>, control: SystemControlName) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      void commit(control);
    }
  }

  return (
    <section className="settings-system-controls" aria-labelledby="settings-system-controls-title" data-testid="settings-system-controls">
      <div className="settings-system-controls__heading">
        <div>
          <h2 id="settings-system-controls-title">Звук и экран</h2>
          <p>Текущие значения Windows. Панель не хранит отдельную копию.</p>
        </div>
        {!status && <span className="settings-system-controls__state">Нет данных</span>}
      </div>

      <div className="settings-system-controls__rows">
        {(["volume", "brightness"] as const).map((control) => {
          const current = status?.controls[control] ?? null;
          const confirmed = current?.value ?? null;
          const value = current?.available ? draft[control] : 0;
          const disabled = (
            current === null
            || !current.available
            || !current.writable
            || locked
            || pending !== null
          );
          return (
            <label
              key={control}
              className={`settings-system-control-row${disabled ? " settings-system-control-row--disabled" : ""}`}
            >
              <span className="settings-system-control-row__copy">
                <strong>{labels[control].title}</strong>
                <small>{labels[control].description}</small>
              </span>
              <span className="settings-system-control-row__value" aria-hidden="true">
                {current?.available && confirmed !== null ? `${value}%` : "—"}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value}
                aria-label={labels[control].title}
                disabled={disabled}
                data-testid={`settings-system-${control}`}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setDraft((existing) => ({ ...existing, [control]: next }));
                }}
                onPointerUp={() => void commit(control)}
                onPointerCancel={() => {
                  if (confirmed !== null) {
                    setDraft((existing) => ({ ...existing, [control]: confirmed }));
                  }
                }}
                onKeyUp={(event) => handleKeyUp(event, control)}
                onBlur={() => void commit(control)}
              />
              <span className="settings-system-control-row__hint">
                {pending === control
                  ? "Применяем и проверяем…"
                  : current
                    ? availabilityCopy(current, locked)
                    : "Загружаем…"}
              </span>
            </label>
          );
        })}
      </div>

      {notice && <p className="settings-system-controls__notice" role="status">{notice}</p>}
    </section>
  );
}
