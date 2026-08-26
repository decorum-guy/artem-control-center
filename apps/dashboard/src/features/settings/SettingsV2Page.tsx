import { useState } from "react";
import type { PlanningCalendarSource } from "@artem/contracts";
import type { AccessStatus } from "../../accessApi";
import {
  AccessSettingsPanel,
  useAccess
} from "../../AccessControls";
import {
  CoffeeNotificationEditor,
  CoffeeTimingEditor,
  useCoffeeSettings,
  type CoffeeSettingsController
} from "../../CoffeeSettings";
import { RuntimeControls, useRuntimeStatus } from "../../RuntimeControls";
import { Sheet } from "../../Sheet";
import { useInteractionLock } from "../../InteractionLock";
import { useCalendarDisplayPreferences } from "../../CalendarDisplayPreferences";
import { calendarDisplayPalette, calendarDisplayOverrideColor, calendarSourceDisplayColor, normalizedCalendarColor } from "../../calendarDisplayColors";
import { RouteHeader } from "../../ShellPrimitives";
import { SettingsSummaryColumn, SettingsSummaryRow } from "./SettingsSummaryRow";
import { CapabilitySettingsSheet, capabilityStateLabel, capabilitySummary, useCapabilities, type CapabilitiesController } from "./CapabilitySettings";
import "./settingsV2.css";

type Theme = "day" | "night";
type MotionMode = "full" | "reduced" | "low-performance" | "battery-saving";
type SettingsSheet = "coffee" | "notifications" | "access" | "runtime" | "calendars" | "capabilities";

const motionLabels: Record<MotionMode, string> = {
  full: "Полное",
  reduced: "Уменьшенное",
  "low-performance": "Низкая производительность",
  "battery-saving": "Экономия батареи"
};

const accessLabels: Record<AccessStatus["effectiveProfile"], string> = {
  read_only: "Только чтение",
  standard: "Обычный доступ",
  full: "Полный доступ"
};

export function SettingsV2Page({
  theme,
  motion,
  calendarSources,
  onThemeChange,
  onMotionChange
}: {
  theme: Theme;
  motion: MotionMode;
  calendarSources: PlanningCalendarSource[];
  onThemeChange: (theme: Theme) => void;
  onMotionChange: (motion: MotionMode) => void;
}) {
  const coffee = useCoffeeSettings();
  const { status: accessStatus, available: accessAvailable } = useAccess();
  const runtime = useRuntimeStatus();
  const calendarPreferences = useCalendarDisplayPreferences();
  const capabilities = useCapabilities();
  const [openSheet, setOpenSheet] = useState<SettingsSheet | null>(null);

  return (
    <div className="settings-v2-page" data-testid="route-settings">
      <RouteHeader
        eyebrow="Панель"
        title="Настройки"
        description="Внешний вид и доступные возможности панели."
      />

      <section className="settings-v2-appearance" aria-labelledby="settings-v2-appearance-title">
        <div className="settings-v2-appearance__copy">
          <h2 id="settings-v2-appearance-title">Внешний вид</h2>
          <p>Спокойная тема и предсказуемое движение для этого экрана.</p>
        </div>
        <div className="settings-v2-appearance__controls">
          <div className="settings-v2-control" role="group" aria-label="Тема">
            <span className="settings-v2-control__label">Тема</span>
            <div className="settings-v2-segmented">
              {(["day", "night"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`settings-theme-${value}`}
                  aria-pressed={theme === value}
                  onClick={() => onThemeChange(value)}
                >
                  {value === "day" ? "День" : "Ночь"}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-v2-control" role="group" aria-label="Движение">
            <span className="settings-v2-control__label">Движение</span>
            <div className="settings-v2-motion-grid">
              {(Object.keys(motionLabels) as MotionMode[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`settings-motion-${value}`}
                  aria-pressed={motion === value}
                  onClick={() => onMotionChange(value)}
                >
                  {motionLabels[value]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="settings-v2-summary-grid">
        <SettingsSummaryColumn>
          <SettingsSummaryRow
            title="Календари"
            summary={calendarSummary(calendarSources, calendarPreferences.loading, calendarPreferences.preferences)}
            stateLabel={calendarStateLabel(calendarPreferences.loading, calendarPreferences.preferences)}
            stateTone={calendarPreferences.preferences?.available === false ? "unavailable" : "neutral"}
            testId="settings-summary-calendars"
            onClick={() => setOpenSheet("calendars")}
          />
          <SettingsSummaryRow
            title="Кофемашина"
            summary={coffeeSummary(coffee)}
            stateLabel={coffeeStateLabel(coffee)}
            stateTone={coffee.available ? "neutral" : "unavailable"}
            testId="settings-summary-coffee"
            onClick={() => setOpenSheet("coffee")}
          />
          <SettingsSummaryRow
            title="Уведомления"
            summary={notificationsSummary(coffee)}
            stateLabel={notificationsStateLabel(coffee)}
            stateTone={coffee.available ? "neutral" : "unavailable"}
            testId="settings-summary-notifications"
            onClick={() => setOpenSheet("notifications")}
          />
          <SettingsSummaryRow
            title="Флаги / Возможности"
            summary={capabilitySummary(capabilities.inventory, capabilities.loading)}
            stateLabel={capabilityStateLabel(capabilities.inventory, capabilities.loading)}
            stateTone={capabilities.inventory ? "neutral" : "unavailable"}
            testId="settings-summary-capabilities"
            onClick={() => setOpenSheet("capabilities")}
          />
        </SettingsSummaryColumn>
        <SettingsSummaryColumn>
          <SettingsSummaryRow
            title="Доступ"
            summary={accessSummary(accessStatus, accessAvailable)}
            stateLabel={accessStateLabel(accessStatus, accessAvailable)}
            stateTone={accessAvailable ? "neutral" : "unavailable"}
            testId="settings-summary-access"
            onClick={() => setOpenSheet("access")}
          />
          <SettingsSummaryRow
            title="Управление панелью"
            summary={runtimeSummary(runtime.availability)}
            stateLabel={runtimeStateLabel(runtime.availability)}
            stateTone={runtime.availability === "unavailable" ? "unavailable" : "neutral"}
            testId="settings-summary-runtime"
            onClick={() => setOpenSheet("runtime")}
          />
        </SettingsSummaryColumn>
      </div>

      {openSheet && (
        <SettingsSheet
          kind={openSheet}
          coffee={coffee}
          calendarSources={calendarSources}
          capabilities={capabilities}
          onClose={() => setOpenSheet(null)}
        />
      )}
    </div>
  );
}

function SettingsSheet({
  kind,
  coffee,
  calendarSources,
  capabilities,
  onClose
}: {
  kind: SettingsSheet;
  coffee: CoffeeSettingsController;
  calendarSources: PlanningCalendarSource[];
  capabilities: CapabilitiesController;
  onClose: () => void;
}) {
  if (kind === "calendars") return <CalendarSettingsSheet sources={calendarSources} onClose={onClose} />;
  if (kind === "capabilities") return <CapabilitySettingsSheet onClose={onClose} capabilities={capabilities} />;
  if (kind === "coffee") {
    return (
      <Sheet
        testId="settings-coffee-sheet"
        eyebrow="Кофемашина"
        title="Время"
        description="Общие значения для панели и Telegram-бота."
        onClose={onClose}
      >
        <div className="settings-v2-sheet-content" data-testid="coffee-settings">
          <CoffeeTimingEditor settings={coffee} showHeading={false} />
          {coffee.notice && <p className="settings-notice" role="status">{coffee.notice}</p>}
        </div>
      </Sheet>
    );
  }

  if (kind === "notifications") {
    return (
      <Sheet
        testId="settings-notifications-sheet"
        eyebrow="Кофемашина"
        title="Уведомления"
        description="События и каналы остаются раздельными: разогрев, долгая работа, Telegram и iPhone."
        onClose={onClose}
      >
        <div className="settings-v2-sheet-content">
          <CoffeeNotificationEditor settings={coffee} showHeading={false} />
          {coffee.notice && <p className="settings-notice" role="status">{coffee.notice}</p>}
        </div>
      </Sheet>
    );
  }

  if (kind === "access") {
    return (
      <Sheet
        testId="settings-access-sheet"
        eyebrow="Безопасность"
        title="Доступ"
        description="Профиль определяет доступные операции."
        onClose={onClose}
      >
        <div className="settings-v2-sheet-content settings-v2-access-content">
          <AccessSettingsPanel />
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      testId="settings-runtime-sheet"
      eyebrow="Панель"
      title="Управление панелью"
      description="Фиксированные действия панели. Произвольные команды недоступны."
      onClose={onClose}
    >
      <div className="settings-v2-sheet-content settings-v2-runtime-content">
        <RuntimeControls variant="system-v2" />
      </div>
    </Sheet>
  );
}

function CalendarSettingsSheet({ sources, onClose }: { sources: PlanningCalendarSource[]; onClose: () => void }) {
  const { preferences, loading, save } = useCalendarDisplayPreferences();
  const { guardMutation } = useInteractionLock();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const calendars = sources.flatMap((source) => source.calendars.map((calendar) => ({ source, calendar })));

  async function setColor(source: PlanningCalendarSource, calendar: PlanningCalendarSource["calendars"][number], color: string | null) {
    if (!guardMutation()) {
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!preferences?.writesEnabled) {
      setNotice("Изменения цветов сейчас недоступны.");
      return;
    }
    const key = `${source.id}:${calendar.id}`;
    setPending(key);
    setNotice(null);
    try {
      await save({ providerId: source.id, calendarId: calendar.id, color });
      setEditing(null);
    } catch {
      setNotice("Не удалось сохранить цвет. Показан подтверждённый цвет.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Sheet testId="settings-calendars-sheet" eyebrow="Расписание" title="Календари" description="Цвета действуют только внутри Control Center и не меняют источник." onClose={onClose}>
      <div className="settings-v2-sheet-content settings-calendar-settings" data-testid="settings-calendar-list">
        {loading && <p className="settings-notice" role="status">Проверяем сохранённые цвета…</p>}
        {!loading && !preferences && <p className="settings-notice" role="status">Настройки цветов временно недоступны. В календаре используются цвета источника.</p>}
        {preferences && !preferences.available && <p className="settings-notice" role="status">Сохранённые настройки цветов временно недоступны. В календаре используются цвета источника.</p>}
        {!loading && calendars.length === 0 && <p className="settings-notice">Календари пока не получены. Обновление списка источников выполняется отдельно.</p>}
        {calendars.map(({ source, calendar }) => {
          const key = `${source.id}:${calendar.id}`;
          const override = preferences ? calendarDisplayOverrideColor(source.id, calendar.id, preferences.overrides) : null;
          const effective = calendarSourceDisplayColor(source, calendar, preferences?.overrides ?? []);
          const provider = normalizedCalendarColor(calendar.color);
          const canWrite = preferences?.writesEnabled === true && pending === null;
          return (
            <article className="settings-calendar-row" key={key} data-testid="settings-calendar-row" data-calendar-label={calendar.label}>
              <button type="button" className="settings-calendar-row__main" aria-expanded={editing === key} onClick={() => setEditing(editing === key ? null : key)} disabled={pending === key}>
                <span className="settings-calendar-row__swatch" data-testid="settings-calendar-effective-swatch" style={{ backgroundColor: effective }} aria-label={`Цвет панели ${effective}`} />
                <span className="settings-calendar-row__copy">
                  <strong>{calendar.label}</strong>
                  <small>{source.label}{calendar.status !== "current" ? " · сохранённые данные" : ""}</small>
                  <small>Источник: {provider ?? "цвет по умолчанию"}{override ? " · цвет панели задан" : ""}</small>
                </span>
                <span className="settings-calendar-row__action">{pending === key ? "Сохраняем…" : "Цвет"}</span>
              </button>
              {editing === key && (
                <div className="settings-calendar-palette" role="group" aria-label={`Цвет для ${calendar.label}`}>
                  {calendarDisplayPalette.map((color) => <button key={color} type="button" className="settings-calendar-palette__color" aria-label={`Выбрать ${color}`} aria-pressed={effective === color} disabled={!canWrite} style={{ backgroundColor: color }} onClick={() => void setColor(source, calendar, color)} />)}
                  <button type="button" className="planning-secondary-button settings-calendar-palette__reset" disabled={!canWrite || !override} onClick={() => void setColor(source, calendar, null)}>Цвет источника</button>
                </div>
              )}
            </article>
          );
        })}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
      </div>
    </Sheet>
  );
}

function calendarSummary(sources: PlanningCalendarSource[], loading: boolean, preferences: ReturnType<typeof useCalendarDisplayPreferences>["preferences"]): string {
  const count = sources.reduce((total, source) => total + source.calendars.length, 0);
  if (loading && !preferences) return "Проверяем цвета панели…";
  if (!preferences) return count ? `${count} календарей · цвета источника` : "Календари временно недоступны";
  return `${count} ${count === 1 ? "календарь" : "календарей"} · цвета панели`;
}

function calendarStateLabel(loading: boolean, preferences: ReturnType<typeof useCalendarDisplayPreferences>["preferences"]): string {
  if (loading && !preferences) return "Проверяем";
  if (!preferences || !preferences.available) return "Недоступно";
  return preferences.writesEnabled ? "Доступно" : "Только чтение";
}

function coffeeSummary(settings: CoffeeSettingsController): string {
  if (settings.timing) {
    return `Разогрев ${settings.timing.warmupMinutes} мин · долго работает после ${settings.timing.longRunningMinutes} мин`;
  }
  if (settings.loading) return "Загружаем значения…";
  return settings.available ? "Значения пока не получены" : "Настройки недоступны";
}

function coffeeStateLabel(settings: CoffeeSettingsController): string {
  if (!settings.available) return "Недоступно";
  if (settings.loading && !settings.timing) return "Проверяем";
  if (settings.timing && !settings.timing.writesEnabled) return "Только чтение";
  if (settings.timing?.sourceMode === "stale") return "Устарело";
  return "Доступно";
}

function notificationsSummary(settings: CoffeeSettingsController): string {
  const notifications = settings.notifications;
  if (!notifications) {
    if (settings.loading) return "Загружаем каналы и события…";
    return settings.available ? "Значения пока не получены" : "Настройки недоступны";
  }

  return ([
    ["Разогрев", notifications.warmup],
    ["Долгая работа", notifications.longRunning]
  ] as const).map(([title, event]) => {
    if (!event.enabled) return `${title}: выкл.`;
    const channels = [
      event.channels.telegram ? "Telegram" : null,
      event.channels.iphone ? "iPhone" : null
    ].filter(Boolean);
    return `${title}: ${channels.length ? channels.join(", ") : "каналы выкл."}`;
  }).join(" · ");
}

function notificationsStateLabel(settings: CoffeeSettingsController): string {
  if (!settings.available) return "Недоступно";
  if (settings.loading && !settings.notifications) return "Проверяем";
  if (settings.notifications && !settings.notifications.writesEnabled) return "Только чтение";
  return "Доступно";
}

function accessSummary(status: AccessStatus | null, available: boolean): string {
  if (status) return `${accessLabels[status.effectiveProfile]}${status.temporaryFull ? " · временно" : ""}`;
  return available ? "Проверяем фактический профиль" : "Статус недоступен";
}

function accessStateLabel(status: AccessStatus | null, available: boolean): string {
  if (!available) return "Недоступно";
  if (!status) return "Проверяем";
  return status.temporaryFull ? "Временно" : "Активен";
}

function runtimeSummary(availability: "loading" | "available" | "unavailable"): string {
  if (availability === "available") return "Фиксированные действия панели";
  if (availability === "loading") return "Проверяем состояние панели";
  return "Панель недоступна";
}

function runtimeStateLabel(availability: "loading" | "available" | "unavailable"): string {
  if (availability === "available") return "Доступен";
  if (availability === "loading") return "Проверяем";
  return "Недоступен";
}
