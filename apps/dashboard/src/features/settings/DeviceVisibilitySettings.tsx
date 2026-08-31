import { useState } from "react";
import { DeviceVisibilityApiError } from "../../deviceVisibilityApi";
import { useDeviceVisibility } from "../../DeviceVisibility";
import { useInteractionLock } from "../../InteractionLock";
import { useAccess } from "../../AccessControls";
import type { DeviceVisibilitySettings } from "@artem/contracts";
import { Sheet } from "../../Sheet";

export function deviceVisibilitySummary(loading: boolean, settings: DeviceVisibilitySettings | null): string {
  if (loading && !settings) return "Проверяем сохранённое состояние…";
  if (!settings || !settings.available) return "Настройки временно недоступны";
  const kettle = settings.devices.find((device) => device.key === "kettle");
  return kettle?.visible ? "Чайник показывается в Доме и Обзоре" : "Чайник скрыт в Доме и Обзоре";
}

export function deviceVisibilityStateLabel(loading: boolean, settings: DeviceVisibilitySettings | null): string {
  if (loading && !settings) return "Проверяем";
  if (!settings || !settings.available) return "Недоступно";
  return settings.writesEnabled ? "Доступно" : "Только чтение";
}

export function DeviceVisibilitySettingsSheet({ onClose }: { onClose: () => void }) {
  const { settings, loading, save, refresh } = useDeviceVisibility();
  const { guardMutation } = useInteractionLock();
  const { ensureCapability } = useAccess();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const kettle = settings?.devices.find((device) => device.key === "kettle");

  async function changeVisibility(visible: boolean) {
    if (!guardMutation()) {
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!settings?.available || !settings.writesEnabled || !kettle || pending) {
      setNotice("Изменение видимости сейчас недоступно.");
      return;
    }
    if (!(await ensureCapability("settings.device_visibility", "Изменить видимость устройств"))) {
      setNotice("Изменение видимости доступно владельцу панели.");
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      const saved = await save({ deviceKey: kettle.key, visible });
      setNotice(saved.devices[0]?.visible ? "Сохранено: чайник снова показывается." : "Сохранено: чайник скрыт в Доме и Обзоре.");
    } catch (error) {
      if (error instanceof DeviceVisibilityApiError && error.code === "revision_conflict") {
        await refresh();
        setNotice("Настройки изменились. Показано последнее подтверждённое состояние.");
      } else {
        setNotice("Не удалось сохранить. Показано подтверждённое состояние.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet
      testId="settings-device-visibility-sheet"
      eyebrow="Панель"
      title="Устройства"
      description="Управляйте только отображением устройств в Control Center. Интеграции и их действия не меняются."
      onClose={onClose}
    >
      <div className="settings-v2-sheet-content device-visibility-settings" data-testid="device-visibility-settings">
        {loading && <p className="settings-notice" role="status">Проверяем сохранённое состояние…</p>}
        {!loading && !settings && <p className="settings-notice" role="status">Настройки видимости временно недоступны.</p>}
        {settings && !settings.available && <p className="settings-notice" role="status">Сохранённые настройки недоступны. Используется безопасное состояние: устройство показывается.</p>}
        {kettle && (
          <label className="setting-switch-row">
            <span className="setting-switch-row__copy">
              <strong>{kettle.label}</strong>
              <small>Показывать чайник в Доме и Обзоре. Home Assistant и действия устройства не изменяются.</small>
            </span>
            <span className="setting-switch-row__control">
              <input
                type="checkbox"
                data-testid="device-visibility-kettle"
                checked={kettle.visible}
                disabled={pending || settings?.available !== true || settings?.writesEnabled !== true}
                onChange={(event) => void changeVisibility(event.target.checked)}
              />
              <span className="setting-switch-row__visual" aria-hidden="true">
                <span className="setting-switch-row__thumb" />
                <span className="setting-switch-row__state">{kettle.visible ? "Да" : "Нет"}</span>
              </span>
            </span>
          </label>
        )}
        {notice && <p className="settings-notice" role="status" aria-live="polite">{notice}</p>}
      </div>
    </Sheet>
  );
}
