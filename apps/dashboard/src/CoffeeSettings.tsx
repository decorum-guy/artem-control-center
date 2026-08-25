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
import { SettingSwitchRow } from "./features/settings/SettingSwitchRow";
import { useInteractionLock } from "./InteractionLock";

export type CoffeeNotificationEvent = "warmup" | "longRunning";
export type CoffeeNotificationField = "enabled" | "telegram" | "iphone";

export interface CoffeeSettingsController {
  timing: CoffeeTimingSettings | null;
  notifications: CoffeeNotificationSettings | null;
  warmup: string;
  longRunning: string;
  timingDirty: boolean;
  serverTimingChanged: boolean;
  pending: boolean;
  notice: string | null;
  loading: boolean;
  available: boolean;
  refresh: () => Promise<void>;
  saveTiming: () => Promise<void>;
  stepTiming: (field: "warmup" | "longRunning", delta: -1 | 1) => void;
  loadLatestTiming: () => void;
  toggleNotification: (
    event: CoffeeNotificationEvent,
    field: CoffeeNotificationField,
    value: boolean
  ) => Promise<void>;
}

/**
 * Shared coffee settings state for the legacy panel and the V2 sheets.
 * The API calls and revision handling intentionally stay in this one place.
 */
export function useCoffeeSettings(): CoffeeSettingsController {
  const { guardMutation } = useInteractionLock();
  const [timing, setTiming] = useState<CoffeeTimingSettings | null>(null);
  const [notifications, setNotifications] =
    useState<CoffeeNotificationSettings | null>(null);
  const [warmup, setWarmup] = useState("");
  const [longRunning, setLongRunning] = useState("");
  const [timingDirty, setTimingDirty] = useState(false);
  const [serverTimingChanged, setServerTimingChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const timingRef = useRef<CoffeeTimingSettings | null>(null);
  const timingDirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextTiming, nextNotifications] = await Promise.all([
        getCoffeeTiming(),
        getCoffeeNotifications()
      ]);
      const previous = timingRef.current;
      timingRef.current = nextTiming;
      setTiming(nextTiming);
      setNotifications(nextNotifications);
      setAvailable(true);
      if (!timingDirtyRef.current) {
        setWarmup(String(nextTiming.warmupMinutes));
        setLongRunning(String(nextTiming.longRunningMinutes));
        setServerTimingChanged(false);
      } else if (previous && previous.revision !== nextTiming.revision) {
        setServerTimingChanged(true);
      }
    } catch {
      setAvailable(false);
      setNotice("Настройки кофемашины временно недоступны.");
    } finally {
      setLoading(false);
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

  const saveTiming = useCallback(async () => {
    if (!guardMutation()) {
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!timing) return;
    if (!timing.writesEnabled) {
      setNotice("Изменения сейчас недоступны.");
      return;
    }
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
      if (!guardMutation()) {
        setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
        return;
      }
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
      setAvailable(true);
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
  }, [guardMutation, longRunning, refresh, serverTimingChanged, timing, warmup]);

  const stepTiming = useCallback((field: "warmup" | "longRunning", delta: -1 | 1) => {
    const current = field === "warmup" ? warmup : longRunning;
    const parsed = Number(current);
    const next = Number.isInteger(parsed) ? parsed + delta : 1;
    const value = String(Math.max(1, next));
    if (field === "warmup") setWarmup(value);
    else setLongRunning(value);
    timingDirtyRef.current = true;
    setTimingDirty(true);
  }, [longRunning, warmup]);

  const loadLatestTiming = useCallback(() => {
    if (!timingRef.current) return;
    setWarmup(String(timingRef.current.warmupMinutes));
    setLongRunning(String(timingRef.current.longRunningMinutes));
    timingDirtyRef.current = false;
    setTimingDirty(false);
    setServerTimingChanged(false);
    setNotice("Загружены актуальные значения.");
  }, []);

  const toggleNotification = useCallback(async (
    event: CoffeeNotificationEvent,
    field: CoffeeNotificationField,
    value: boolean
  ) => {
    if (!guardMutation()) {
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!notifications) return;
    if (!notifications.writesEnabled) {
      setNotice("Изменения сейчас недоступны.");
      return;
    }
    const eventPatch =
      field === "enabled"
        ? { enabled: value }
        : { channels: { [field]: value } };
    setPending(true);
    try {
      if (!guardMutation()) {
        setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
        return;
      }
      const updated = await patchCoffeeNotifications({
        expectedRevision: notifications.revision,
        [event]: eventPatch
      });
      setNotifications(updated);
      setAvailable(true);
      setNotice("Настройки уведомлений сохранены.");
    } catch (error) {
      if (error instanceof CoffeeApiError && error.status === 409) {
        await refresh();
      }
      setNotice(settingsError(error));
    } finally {
      setPending(false);
    }
  }, [guardMutation, notifications, refresh]);

  return {
    timing,
    notifications,
    warmup,
    longRunning,
    timingDirty,
    serverTimingChanged,
    pending,
    notice,
    loading,
    available,
    refresh,
    saveTiming,
    stepTiming,
    loadLatestTiming,
    toggleNotification
  };
}

export function CoffeeSettingsPanel() {
  const settings = useCoffeeSettings();
  const writesDisabled = settings.timing?.writesEnabled === false ||
    settings.notifications?.writesEnabled === false;

  return (
    <section className="coffee-settings" data-testid="coffee-settings">
      <header>
        <div>
          <p className="section-kicker">Дом</p>
          <h2>Кофемашина</h2>
        </div>
        {settings.timing && (
          <span className={`source-chip source-chip--${settings.timing.sourceMode}`}>
            {settings.timing.sourceMode === "live" || settings.timing.sourceMode === "fixture"
              ? "Данные актуальны"
              : "Данные устарели"}
          </span>
        )}
      </header>

      <CoffeeTimingEditor settings={settings} />
      <CoffeeNotificationEditor settings={settings} />

      {writesDisabled && (
        <p className="settings-disabled">Изменения сейчас недоступны.</p>
      )}
      {settings.notice && <p className="settings-notice" role="status">{settings.notice}</p>}
    </section>
  );
}

export function CoffeeTimingEditor({
  settings,
  showHeading = true
}: {
  settings: CoffeeSettingsController;
  showHeading?: boolean;
}) {
  const { timing } = settings;
  return (
    <div className="coffee-settings__timing" data-testid="coffee-timing-editor">
      {showHeading && (
        <div>
          <h3>Время</h3>
          <p>
            Эти значения общие для панели и Telegram-бота.
          </p>
        </div>
      )}
      {timing ? (
        <div className="timing-form">
          <TimingStepper
            label="Время разогрева"
            value={settings.warmup}
            onStep={(delta) => settings.stepTiming("warmup", delta)}
            disabled={settings.pending || !timing.writesEnabled}
            testId="warmup"
          />
          <TimingStepper
            label="Предупредить о долгой работе через"
            value={settings.longRunning}
            onStep={(delta) => settings.stepTiming("longRunning", delta)}
            disabled={settings.pending || !timing.writesEnabled}
            testId="long-running"
          />
          <button
            type="button"
            onClick={() => void settings.saveTiming()}
            disabled={settings.pending || !timing.writesEnabled}
          >
            {settings.pending ? "Сохраняем…" : "Сохранить"}
          </button>
          {settings.serverTimingChanged && (
            <div className="timing-conflict" data-testid="timing-conflict">
              <span>Значения изменились в Telegram.</span>
              <button
                type="button"
                onClick={settings.loadLatestTiming}
                disabled={settings.pending}
              >
                Загрузить актуальные
              </button>
            </div>
          )}
          {settings.timingDirty && !settings.serverTimingChanged && (
            <span className="muted">Есть несохранённые изменения.</span>
          )}
          {!timing.writesEnabled && (
            <p className="settings-disabled">Изменения сейчас недоступны.</p>
          )}
        </div>
      ) : (
        <p className="muted">
          {settings.loading
            ? "Получаем значения из Home Assistant…"
            : settings.available
              ? "Значения пока не получены."
              : "Настройки кофемашины временно недоступны."}
        </p>
      )}
    </div>
  );
}

export function CoffeeNotificationEditor({
  settings,
  showHeading = true
}: {
  settings: CoffeeSettingsController;
  showHeading?: boolean;
}) {
  const { notifications } = settings;
  if (!notifications) {
    return (
      <div className="coffee-settings__notifications" data-testid="coffee-notifications-editor">
        {showHeading && (
          <div>
            <h3>Уведомления</h3>
            <p>Каналы отключаются намеренно и не считаются ошибкой доставки.</p>
          </div>
        )}
        <p className="muted">
          {settings.loading
            ? "Получаем настройки уведомлений…"
            : settings.available
              ? "Значения пока не получены."
              : "Настройки уведомлений временно недоступны."}
        </p>
      </div>
    );
  }

  return (
    <div className="coffee-settings__notifications" data-testid="coffee-notifications-editor">
      {showHeading && (
        <div>
          <h3>Уведомления</h3>
          <p>Каналы отключаются намеренно и не считаются ошибкой доставки.</p>
        </div>
      )}
      {([
        ["warmup", "Разогрев завершён"],
        ["longRunning", "Работает слишком долго"]
      ] as const).map(([event, title]) => {
        const eventSettings = notifications[event];
        return (
          <fieldset key={event} disabled={settings.pending || !notifications.writesEnabled}>
            <legend>{title}</legend>
            <SettingSwitchRow
              label="Уведомление включено"
              checked={eventSettings.enabled}
              disabled={settings.pending || !notifications.writesEnabled}
              onChange={(value) => void settings.toggleNotification(event, "enabled", value)}
            />
            <SettingSwitchRow
              label="Telegram"
              checked={eventSettings.channels.telegram}
              disabled={settings.pending || !notifications.writesEnabled}
              onChange={(value) => void settings.toggleNotification(event, "telegram", value)}
            />
            <SettingSwitchRow
              label="iPhone"
              checked={eventSettings.channels.iphone}
              disabled={settings.pending || !notifications.writesEnabled}
              onChange={(value) => void settings.toggleNotification(event, "iphone", value)}
            />
          </fieldset>
        );
      })}
      {!notifications.writesEnabled && (
        <p className="settings-disabled">Изменения сейчас недоступны.</p>
      )}
    </div>
  );
}

function TimingStepper({
  label,
  value,
  onStep,
  disabled,
  testId
}: {
  label: string;
  value: string;
  onStep: (delta: -1 | 1) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <div className="timing-stepper-field">
      <span>{label}</span>
      <div className="timing-stepper" data-testid={`coffee-timing-${testId}`}>
        <button type="button" aria-label={`${label}: уменьшить`} onClick={() => onStep(-1)} disabled={disabled}>−</button>
        <output aria-live="polite" aria-label={label}>{value || "—"} <span>мин</span></output>
        <button type="button" aria-label={`${label}: увеличить`} onClick={() => onStep(1)} disabled={disabled}>+</button>
      </div>
    </div>
  );
}

function settingsError(error: unknown): string {
  if (error instanceof CoffeeApiError) {
    if (error.status === 409) {
      return "Настройки изменились в Telegram. Обновите значения и повторите.";
    }
    if (error.status === 403) return "Изменения сейчас недоступны.";
    if (error.status === 400) return "Home Assistant не принимает такое значение.";
  }
  return "Не удалось подтвердить изменение. Текущее состояние не изменено в интерфейсе.";
}
