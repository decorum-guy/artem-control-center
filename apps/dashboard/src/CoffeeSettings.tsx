import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CoffeeNotificationSettings,
  CoffeeTimingSettings
} from "@artem/contracts";
import {
  CoffeeApiError,
  getCoffeeNotifications,
  getCoffeeTiming,
  patchCoffeeNotifications,
  patchCoffeeTiming
} from "./coffeeApi";

export function CoffeeSettingsPanel() {
  const [timing, setTiming] = useState<CoffeeTimingSettings | null>(null);
  const [notifications, setNotifications] =
    useState<CoffeeNotificationSettings | null>(null);
  const [warmup, setWarmup] = useState("");
  const [longRunning, setLongRunning] = useState("");
  const [timingDirty, setTimingDirty] = useState(false);
  const [serverTimingChanged, setServerTimingChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timingRef = useRef<CoffeeTimingSettings | null>(null);
  const timingDirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [nextTiming, nextNotifications] = await Promise.all([
        getCoffeeTiming(),
        getCoffeeNotifications()
      ]);
      const previous = timingRef.current;
      timingRef.current = nextTiming;
      setTiming(nextTiming);
      setNotifications(nextNotifications);
      if (!timingDirtyRef.current) {
        setWarmup(String(nextTiming.warmupMinutes));
        setLongRunning(String(nextTiming.longRunningMinutes));
        setServerTimingChanged(false);
      } else if (previous && previous.revision !== nextTiming.revision) {
        setServerTimingChanged(true);
      }
    } catch {
      setNotice("Настройки кофемашины временно недоступны.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  async function saveTiming() {
    if (!timing) return;
    if (serverTimingChanged) {
      setNotice("Значения изменились в Telegram. Сначала загрузите актуальные значения.");
      return;
    }
    const warmupMinutes = Number(warmup);
    const longRunningMinutes = Number(longRunning);
    if (!Number.isInteger(warmupMinutes) || !Number.isInteger(longRunningMinutes)) {
      setNotice("Введите целое количество минут.");
      return;
    }
    setPending(true);
    try {
      const updated = await patchCoffeeTiming({
        expectedRevision: timing.revision,
        warmupMinutes,
        longRunningMinutes
      });
      timingRef.current = updated;
      setTiming(updated);
      setWarmup(String(updated.warmupMinutes));
      setLongRunning(String(updated.longRunningMinutes));
      timingDirtyRef.current = false;
      setTimingDirty(false);
      setServerTimingChanged(false);
      setNotice("Сохранено и подтверждено Home Assistant.");
    } catch (error) {
      if (error instanceof CoffeeApiError && error.status === 409) {
        await refresh();
        setServerTimingChanged(true);
      }
      setNotice(settingsError(error));
    } finally {
      setPending(false);
    }
  }

  async function toggleNotification(
    event: "warmup" | "longRunning",
    field: "enabled" | "telegram" | "iphone",
    value: boolean
  ) {
    if (!notifications) return;
    const eventPatch =
      field === "enabled"
        ? { enabled: value }
        : { channels: { [field]: value } };
    setPending(true);
    try {
      const updated = await patchCoffeeNotifications({
        expectedRevision: notifications.revision,
        [event]: eventPatch
      });
      setNotifications(updated);
      setNotice("Настройки уведомлений сохранены.");
    } catch (error) {
      if (error instanceof CoffeeApiError && error.status === 409) {
        await refresh();
      }
      setNotice(settingsError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="coffee-settings" data-testid="coffee-settings">
      <header>
        <div>
          <p className="section-kicker">Дом</p>
          <h2>Кофемашина</h2>
        </div>
        {timing && (
          <span className={`source-chip source-chip--${timing.sourceMode}`}>
            {timing.sourceMode === "live" || timing.sourceMode === "fixture"
              ? "Данные актуальны"
              : "Данные устарели"}
          </span>
        )}
      </header>

      <div className="coffee-settings__timing">
        <div>
          <h3>Время</h3>
          <p>
            Эти значения общие для панели и Telegram-бота и хранятся в Home Assistant.
          </p>
        </div>
        {timing ? (
          <div className="timing-form">
            <label>
              <span>Время разогрева</span>
              <span className="number-control">
                <input
                  aria-label="Время разогрева"
                  inputMode="numeric"
                  type="number"
                  step="1"
                value={warmup}
                  onChange={(event) => {
                    setWarmup(event.target.value);
                    timingDirtyRef.current = true;
                    setTimingDirty(true);
                  }}
                  disabled={pending || !timing.writesEnabled}
                />
                <i>мин</i>
              </span>
            </label>
            <label>
              <span>Предупредить о долгой работе через</span>
              <span className="number-control">
                <input
                  aria-label="Предупредить о долгой работе через"
                  inputMode="numeric"
                  type="number"
                  step="1"
                  value={longRunning}
                  onChange={(event) => {
                    setLongRunning(event.target.value);
                    timingDirtyRef.current = true;
                    setTimingDirty(true);
                  }}
                  disabled={pending || !timing.writesEnabled}
                />
                <i>мин</i>
              </span>
            </label>
            <button
              type="button"
              onClick={() => void saveTiming()}
              disabled={pending || !timing.writesEnabled}
            >
              {pending ? "Сохраняем…" : "Сохранить"}
            </button>
            {serverTimingChanged && (
              <div className="timing-conflict" data-testid="timing-conflict">
                <span>Значения изменились в Telegram.</span>
                <button
                  type="button"
                  onClick={() => {
                    if (!timingRef.current) return;
                    setWarmup(String(timingRef.current.warmupMinutes));
                    setLongRunning(String(timingRef.current.longRunningMinutes));
                    timingDirtyRef.current = false;
                    setTimingDirty(false);
                    setServerTimingChanged(false);
                    setNotice("Загружены актуальные значения.");
                  }}
                  disabled={pending}
                >
                  Загрузить актуальные
                </button>
              </div>
            )}
            {timingDirty && !serverTimingChanged && (
              <span className="muted">Есть несохранённые изменения.</span>
            )}
          </div>
        ) : (
          <p className="muted">Получаем значения из Home Assistant…</p>
        )}
      </div>

      {notifications && (
        <div className="coffee-settings__notifications">
          <div>
            <h3>Уведомления</h3>
            <p>Каналы отключаются намеренно и не считаются ошибкой доставки.</p>
          </div>
          {([
            ["warmup", "Разогрев завершён"],
            ["longRunning", "Работает слишком долго"]
          ] as const).map(([event, title]) => {
            const settings = notifications[event];
            return (
              <fieldset key={event} disabled={pending || !notifications.writesEnabled}>
                <legend>{title}</legend>
                <Toggle
                  label="Уведомление включено"
                  checked={settings.enabled}
                  onChange={(value) => void toggleNotification(event, "enabled", value)}
                />
                <Toggle
                  label="Telegram"
                  checked={settings.channels.telegram}
                  onChange={(value) => void toggleNotification(event, "telegram", value)}
                />
                <Toggle
                  label="iPhone"
                  checked={settings.channels.iphone}
                  onChange={(value) => void toggleNotification(event, "iphone", value)}
                />
              </fieldset>
            );
          })}
        </div>
      )}

      {timing && !timing.writesEnabled && (
        <p className="settings-disabled">Изменения отключены политикой Panel Agent.</p>
      )}
      {notice && <p className="settings-notice" role="status">{notice}</p>}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="setting-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function settingsError(error: unknown): string {
  if (error instanceof CoffeeApiError) {
    if (error.status === 409) {
      return "Настройки изменились в Telegram. Обновите значения и повторите.";
    }
    if (error.status === 403) return "Изменения отключены политикой Panel Agent.";
    if (error.status === 400) return "Home Assistant не принимает такое значение.";
  }
  return "Не удалось подтвердить изменение. Текущее состояние не изменено в интерфейсе.";
}
