import { useCallback, useEffect, useRef, useState } from "react";
import { useAccess } from "../../AccessControls";
import { useInteractionLock } from "../../InteractionLock";
import { Sheet } from "../../Sheet";

type SpokenEndpoint = "alice" | "jarvis";
type PhoneChannel = "telegram" | "home_assistant";
type ChannelStatus = "available" | "not_configured" | "unavailable";

interface ChannelHealth { status: ChannelStatus; code: string | null; }
interface DeliveryInventory {
  schemaVersion: "reminder.delivery-settings.v1";
  revision: number;
  updatedAt: string;
  spokenEndpoint: SpokenEndpoint;
  phoneChannels: PhoneChannel[];
  channelHealth: {
    spoken: Record<SpokenEndpoint, ChannelHealth>;
    phone: Record<PhoneChannel, ChannelHealth>;
  };
  sourceMode: "live" | "cached" | "fixture" | "stale" | "unavailable";
  writesEnabled: boolean;
}

const endpointLabels: Record<SpokenEndpoint, string> = { alice: "Alice", jarvis: "Jarvis" };
const phoneLabels: Record<PhoneChannel, string> = { telegram: "Telegram", home_assistant: "Home Assistant" };

async function request(path: string, init?: RequestInit): Promise<DeliveryInventory> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json", ...init?.headers }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string"
      ? (body as { detail: string }).detail
      : `http_${response.status}`;
    throw new Error(detail);
  }
  return body as DeliveryInventory;
}

export function useReminderDeliverySettings() {
  const [inventory, setInventory] = useState<DeliveryInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await request("/api/v1/settings/reminders/delivery");
      setInventory(next);
      setError(null);
      return next;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "network");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { inventory, loading, error, refresh, setInventory };
}

export type ReminderDeliverySettingsController = ReturnType<typeof useReminderDeliverySettings>;

function statusLabel(status: ChannelStatus): string {
  if (status === "available") return "Доступен";
  if (status === "not_configured") return "Не настроен";
  return "Недоступен";
}

export function reminderDeliverySummary(controller: ReminderDeliverySettingsController): string {
  if (controller.loading) return "Проверяем доставку напоминаний…";
  if (!controller.inventory) return "Доставка напоминаний временно недоступна";
  const phones = controller.inventory.phoneChannels.map((channel) => phoneLabels[channel]).join(", ");
  return `${endpointLabels[controller.inventory.spokenEndpoint]} · ${phones}`;
}

export function reminderDeliveryStateLabel(controller: ReminderDeliverySettingsController): string {
  if (controller.loading) return "Проверяем";
  if (!controller.inventory) return "Недоступно";
  if (controller.inventory.channelHealth.spoken[controller.inventory.spokenEndpoint].status !== "available") return "Проверить канал";
  return controller.inventory.writesEnabled ? "Доступно" : "Только чтение";
}

export function ReminderDeliverySettingsSheet({
  controller,
  onClose
}: {
  controller: ReminderDeliverySettingsController;
  onClose: () => void;
}) {
  const { inventory, loading, error, refresh, setInventory } = controller;
  const { guardMutation } = useInteractionLock();
  const { ensureCapability } = useAccess();
  const [endpoint, setEndpoint] = useState<SpokenEndpoint>("alice");
  const [phoneChannels, setPhoneChannels] = useState<PhoneChannel[]>(["telegram"]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!inventory) return;
    setEndpoint(inventory.spokenEndpoint);
    setPhoneChannels(inventory.phoneChannels);
  }, [inventory]);

  const togglePhone = (channel: PhoneChannel) => {
    setPhoneChannels((current) => {
      if (current.includes(channel)) {
        if (current.length === 1) {
          setNotice("Выберите хотя бы один телефонный канал.");
          return current;
        }
        return current.filter((item) => item !== channel);
      }
      return [...current, channel].sort((left, right) => (left === "telegram" ? -1 : right === "telegram" ? 1 : 0));
    });
  };

  const save = useCallback(async () => {
    if (!inventory || busyRef.current) return;
    if (!guardMutation()) {
      setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!await ensureCapability("settings.reminder_delivery", "Изменить доставку напоминаний")) {
      setNotice("Для изменения доставки нужен обычный доступ.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const next = await request("/api/v1/settings/reminders/delivery", {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: inventory.revision, spokenEndpoint: endpoint, phoneChannels })
      });
      setInventory(next);
      const selectedUnavailable = next.channelHealth.spoken[next.spokenEndpoint].status !== "available"
        || next.phoneChannels.some((channel) => next.channelHealth.phone[channel].status !== "available");
      setNotice(selectedUnavailable ? "Сохранено, но один или несколько выбранных каналов сейчас недоступны." : "Сохранено.");
    } catch (saveError) {
      if (saveError instanceof Error && saveError.message === "revision_conflict") {
        await refresh();
        setNotice("Настройки изменились в другом сеансе. Показано актуальное состояние.");
      } else {
        setNotice("Не удалось сохранить доставку. Показано подтверждённое состояние.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [endpoint, ensureCapability, guardMutation, inventory, phoneChannels, refresh, setInventory]);

  return (
    <Sheet testId="settings-reminder-delivery-sheet" eyebrow="Напоминания" title="Доставка" description="Речевой endpoint и телефонные каналы настраиваются независимо. Секреты и адреса сервисов остаются на сервере." onClose={onClose}>
      <div className="settings-v2-sheet-content reminder-delivery-settings" data-testid="reminder-delivery-settings">
        {loading && <p className="settings-notice" role="status">Проверяем каналы доставки…</p>}
        {error && !inventory && <p className="settings-notice" role="status">Настройки доставки временно недоступны.</p>}
        {inventory && <>
          <section className="reminder-delivery-settings__section" aria-labelledby="reminder-spoken-title">
            <div className="reminder-delivery-settings__heading"><h2 id="reminder-spoken-title">Голос</h2><span>Один endpoint</span></div>
            <div className="reminder-delivery-settings__options" role="radiogroup" aria-label="Речевой endpoint">
              {(Object.keys(endpointLabels) as SpokenEndpoint[]).map((value) => {
                const health = inventory.channelHealth.spoken[value];
                return <label className="reminder-delivery-option" key={value}>
                  <input type="radio" name="reminder-spoken-endpoint" value={value} checked={endpoint === value} disabled={busy || !inventory.writesEnabled} onChange={() => setEndpoint(value)} />
                  <span><strong>{endpointLabels[value]}</strong><small>{statusLabel(health.status)}</small></span>
                </label>;
              })}
            </div>
            {inventory.channelHealth.spoken[endpoint].status !== "available" && <p className="settings-notice" role="status">Выбранный речевой канал сейчас недоступен. Alice не будет использована вместо Jarvis автоматически.</p>}
          </section>
          <section className="reminder-delivery-settings__section" aria-labelledby="reminder-phone-title">
            <div className="reminder-delivery-settings__heading"><h2 id="reminder-phone-title">Телефон</h2><span>Можно выбрать оба</span></div>
            <div className="reminder-delivery-settings__options" role="group" aria-label="Телефонные каналы">
              {(Object.keys(phoneLabels) as PhoneChannel[]).map((value) => {
                const health = inventory.channelHealth.phone[value];
                return <label className="reminder-delivery-option" key={value}>
                  <input type="checkbox" checked={phoneChannels.includes(value)} disabled={busy || !inventory.writesEnabled} onChange={() => togglePhone(value)} />
                  <span><strong>{phoneLabels[value]}</strong><small>{statusLabel(health.status)}</small></span>
                </label>;
              })}
            </div>
            {phoneChannels.some((channel) => inventory.channelHealth.phone[channel].status !== "available") && <p className="settings-notice" role="status">Один или несколько выбранных телефонных каналов сейчас недоступны. Автоматического перенаправления нет.</p>}
          </section>
          <div className="reminder-delivery-settings__actions">
            <button type="button" className="primary-action" disabled={busy || !inventory.writesEnabled} aria-busy={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить"}</button>
            <small>Изменения применяются к новым попыткам доставки; уже начатая доставка сохраняет свой снимок политики.</small>
          </div>
          {notice && <p className="settings-notice" role="status" aria-live="polite">{notice}</p>}
        </>}
      </div>
    </Sheet>
  );
}
