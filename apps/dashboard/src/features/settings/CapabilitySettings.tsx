import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccess } from "../../AccessControls";
import { useInteractionLock } from "../../InteractionLock";
import { Sheet } from "../../Sheet";
import { SettingSwitchRow } from "./SettingSwitchRow";

type Behavior = "immediate" | "delayed";
type ApplyStatus = "idle" | "queued" | "building" | "restarting" | "success" | "failed";

interface CapabilityEntry {
  id: string;
  label: string;
  description: string;
  group: string;
  technicalFlag: string;
  activeEnabled: boolean;
  desiredEnabled: boolean;
  pending: boolean;
  mutable: boolean;
  behavior: Behavior;
  requiredApplyAction: "none" | "restart" | "rebuild";
  operationalBlockedReason: string | null;
  configuredEnabled?: boolean;
  overrideEnabled?: boolean | null;
}

interface Inventory {
  schemaVersion: "capabilities.v1";
  revision: number;
  available: boolean;
  writesEnabled: boolean;
  warnings: string[];
  entries: CapabilityEntry[];
}

function stateCopy(enabled: boolean) { return enabled ? "Включено" : "Выключено"; }
function behaviorCopy(behavior: Behavior) { return behavior === "immediate" ? "Сразу" : "После применения"; }
function applyCopy(status: ApplyStatus, writesEnabled: boolean) {
  if (!writesEnabled) return "Применение недоступно: запись панели отключена.";
  if (status === "queued") return "Изменение поставлено в очередь…";
  if (status === "building") return "Собираем новую версию панели…";
  if (status === "restarting") return "Перезапускаем и проверяем панель…";
  return "Будет выполнена пересборка и перезапуск панели";
}

function parseInventory(value: unknown): Inventory {
  if (!value || typeof value !== "object") throw new Error("contract");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== "capabilities.v1" || !Number.isInteger(raw.revision) || !Array.isArray(raw.entries) || typeof raw.writesEnabled !== "boolean" || typeof raw.available !== "boolean") throw new Error("contract");
  return raw as unknown as Inventory;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...init?.headers } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string" ? (body as { detail: string }).detail : `http_${response.status}`);
  return body;
}

export function useCapabilities() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = parseInventory(await request("/api/v1/settings/capabilities"));
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

export type CapabilitiesController = ReturnType<typeof useCapabilities>;

export function capabilitySummary(inventory: Inventory | null, loading: boolean) {
  if (loading) return "Проверяем доступные возможности…";
  if (!inventory) return "Настройки возможностей временно недоступны";
  const pending = inventory.entries.filter((entry) => entry.pending).length;
  return pending ? `${pending} ожидают применения` : "Управление возможностями панели";
}

export function capabilityStateLabel(inventory: Inventory | null, loading: boolean) {
  if (loading) return "Проверяем";
  if (!inventory) return "Недоступно";
  const pending = inventory.entries.filter((entry) => entry.pending).length;
  return pending ? "Есть изменения" : "Доступно";
}

export function CapabilitySettingsSheet({ onClose, capabilities }: { onClose: () => void; capabilities: CapabilitiesController }) {
  const { inventory, loading, error, refresh, setInventory } = capabilities;
  const { guardMutation } = useInteractionLock();
  const { ensureCapability } = useAccess();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<ApplyStatus>("idle");

  const pending = useMemo(() => inventory?.entries.filter((entry) => entry.pending) ?? [], [inventory]);
  const groups = useMemo(() => {
    const grouped = new Map<string, CapabilityEntry[]>();
    for (const entry of inventory?.entries ?? []) grouped.set(entry.group, [...(grouped.get(entry.group) ?? []), entry]);
    return [...grouped.entries()];
  }, [inventory]);

  const save = useCallback(async (entry: CapabilityEntry, enabled: boolean | null) => {
    const unlocked = guardMutation();
    if (!inventory || savingId || !unlocked) {
      if (!unlocked) setNotice("Панель заблокирована. Удерживайте замок для разблокировки.");
      return;
    }
    if (!await ensureCapability("settings.capabilities.manage", "Изменить возможности панели")) {
      setNotice("Для изменения возможностей нужен полный доступ.");
      return;
    }
    setSavingId(entry.id);
    setNotice(null);
    try {
      const next = parseInventory(await request("/api/v1/settings/capabilities", { method: "PATCH", body: JSON.stringify({ expectedRevision: inventory.revision, capabilityId: entry.id, enabled }) }));
      setInventory(next);
      if (entry.behavior === "immediate") window.dispatchEvent(new Event("artem-capabilities-changed"));
    } catch (saveError) {
      if (saveError instanceof Error && saveError.message === "revision_conflict") {
        await refresh();
        setNotice("Настройки изменились в другом сеансе. Показано актуальное состояние.");
      } else {
        setNotice("Не удалось сохранить изменение. Показано подтверждённое состояние.");
      }
    } finally {
      setSavingId(null);
    }
  }, [ensureCapability, guardMutation, inventory, refresh, savingId, setInventory]);

  const apply = useCallback(async () => {
    const unlocked = guardMutation();
    if (!inventory || !pending.length || !unlocked) {
      if (!unlocked) setNotice("Панель заблокирована. Сначала разблокируйте её.");
      return;
    }
    if (!await ensureCapability("settings.capabilities.manage", "Применить изменения возможностей")) {
      setNotice("Для применения изменений нужен полный доступ.");
      return;
    }
    setApplyStatus("queued");
    setNotice("Применяем изменения…");
    try {
      await request("/api/v1/system/runtime/apply-capabilities", { method: "POST", headers: { "x-panel-intent": "capability-apply" }, body: JSON.stringify({ expectedRevision: inventory.revision }) });
      // A Samsung production build can take several minutes. Persisted
      // supervisor status makes queued/building/restarting honest progress;
      // the hard bound only protects against a missing supervisor forever.
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        try {
          const runtime = await request("/api/v1/system/runtime") as { capabilityApply?: { status?: ApplyStatus } };
          const status = runtime.capabilityApply?.status ?? "queued";
          setApplyStatus(status);
          if (status === "success") {
            window.location.reload();
            return;
          }
          if (status === "failed") throw new Error("apply_failed");
        } catch (pollError) {
          // The Agent is expected to disappear briefly while the supervisor
          // restarts. Keep polling until the bounded deadline unless it gave a
          // confirmed apply failure.
          if (pollError instanceof Error && pollError.message === "apply_failed") throw pollError;
        }
      }
      throw new Error("apply_timeout");
    } catch {
      setApplyStatus("failed");
      setNotice("Не удалось применить изменения. Панель продолжает работать с предыдущими настройками.");
      await refresh();
    }
  }, [ensureCapability, guardMutation, inventory, pending.length, refresh]);

  return (
    <Sheet testId="settings-capabilities-sheet" eyebrow="Панель" title="Флаги / Возможности" description="Безопасные возможности панели. Технические настройки и секреты здесь не изменяются." onClose={onClose}>
      <div className="settings-v2-sheet-content capability-settings" data-testid="capability-settings">
        {loading && <p className="settings-notice" role="status">Проверяем возможности…</p>}
        {error && !inventory && <p className="settings-notice" role="status">Настройки возможностей временно недоступны.</p>}
        {inventory && !inventory.available && <p className="settings-notice" role="status">Часть сохранённого состояния временно недоступна. Используются безопасные исходные значения.</p>}
        {groups.map(([group, entries]) => (
          <section className="capability-settings__group" key={group} aria-labelledby={`capability-group-${group}`}>
            <h2 id={`capability-group-${group}`}>{group}</h2>
            {entries.map((entry) => (
              <article className={`capability-row${entry.pending ? " capability-row--pending" : ""}`} key={entry.id} data-testid={`capability-${entry.id}`}>
                <div className="capability-row__details">
                  <strong>{entry.label}</strong>
                  {entry.behavior === "delayed" ? <span>Сейчас: {stateCopy(entry.activeEnabled)}</span> : <span>{stateCopy(entry.activeEnabled)}</span>}
                  {entry.behavior === "delayed" && <span>После применения: {stateCopy(entry.desiredEnabled)}</span>}
                  {entry.pending && <span className="capability-row__pending">Ожидает применения</span>}
                  <small>{entry.mutable ? behaviorCopy(entry.behavior) : "Управляется конфигурацией"} · {entry.description}</small>
                  <small className="capability-row__technical">{entry.technicalFlag}</small>
                  {entry.operationalBlockedReason === "panel_writes_disabled" && <small className="capability-row__blocked">Включено, но запись панели отключена</small>}
                </div>
                {entry.mutable && <div className="capability-row__actions">
                  <SettingSwitchRow label={entry.label} checked={entry.desiredEnabled} onChange={(enabled) => void save(entry, enabled)} disabled={savingId !== null || inventory?.writesEnabled !== true} testId={`capability-switch-${entry.id}`} />
                  {entry.overrideEnabled !== null && entry.overrideEnabled !== undefined && <button type="button" className="planning-secondary-button capability-row__reset" disabled={savingId !== null || inventory?.writesEnabled !== true} onClick={() => void save(entry, null)}>Использовать конфигурацию</button>}
                </div>}
              </article>
            ))}
          </section>
        ))}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
        {pending.length > 0 && (
          <div className="capability-settings__apply" data-testid="capability-apply-area">
            <span>{pending.length} {pending.length === 1 ? "изменение ожидает применения" : "изменения ожидают применения"}</span>
            <small>{applyCopy(applyStatus, inventory?.writesEnabled === true)}</small>
            <button type="button" className="primary-action" disabled={inventory?.writesEnabled !== true || (applyStatus !== "idle" && applyStatus !== "failed")} onClick={() => void apply()}>Применить изменения</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
