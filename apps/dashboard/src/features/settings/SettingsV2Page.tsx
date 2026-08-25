import { useState } from "react";
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
import { RouteHeader } from "../../ShellPrimitives";
import { SettingsSummaryColumn, SettingsSummaryRow } from "./SettingsSummaryRow";
import "./settingsV2.css";

type Theme = "day" | "night";
type MotionMode = "full" | "reduced" | "low-performance" | "battery-saving";
type SettingsSheet = "coffee" | "notifications" | "access" | "runtime";

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
  onThemeChange,
  onMotionChange
}: {
  theme: Theme;
  motion: MotionMode;
  onThemeChange: (theme: Theme) => void;
  onMotionChange: (motion: MotionMode) => void;
}) {
  const coffee = useCoffeeSettings();
  const { status: accessStatus, available: accessAvailable } = useAccess();
  const runtime = useRuntimeStatus();
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
          onClose={() => setOpenSheet(null)}
        />
      )}
    </div>
  );
}

function SettingsSheet({
  kind,
  coffee,
  onClose
}: {
  kind: SettingsSheet;
  coffee: CoffeeSettingsController;
  onClose: () => void;
}) {
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
