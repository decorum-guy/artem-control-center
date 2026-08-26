import { useCallback, useEffect, useState } from "react";
import { useAccess } from "../../AccessControls";
import { useInteractionLock } from "../../InteractionLock";
import { Sheet } from "../../Sheet";

type ProviderId = "gigachat" | "yandex" | "deepseek" | "local";
type ProviderState = "configured" | "not_configured" | "disabled" | "unavailable" | "error";
interface Provider { id: ProviderId; model: string; models: string[]; credentialPresent: boolean; configured: boolean; state: ProviderState; }
interface Inventory { schemaVersion: "ai.provider-settings.v1"; revision: number; available: boolean; enabled: boolean; writesEnabled: boolean; selectedProvider: ProviderId; providers: Provider[]; warnings: string[]; }

function copyState(value: ProviderState) { return ({ configured: "Настроен", not_configured: "Не настроен", disabled: "Отключён", unavailable: "Недоступен", error: "Ошибка" })[value]; }
function copyProvider(value: ProviderId) { return ({ gigachat: "GigaChat", yandex: "Yandex", deepseek: "DeepSeek", local: "Локальная модель" })[value]; }
async function request(path: string, init?: RequestInit): Promise<Inventory> {
  const response = await fetch(path, { cache: "no-store", headers: { "content-type": "application/json", ...init?.headers }, ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string" ? (body as { detail: string }).detail : "request_failed");
  return body as Inventory;
}
export function useAIProviderSettings() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => { try { const value = await request("/api/v1/settings/ai"); setInventory(value); return value; } catch { return null; } finally { setLoading(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { inventory, loading, refresh, setInventory };
}
export type AIProviderSettingsController = ReturnType<typeof useAIProviderSettings>;
export function aiSummary(controller: AIProviderSettingsController) {
  const provider = controller.inventory?.providers.find((item) => item.id === controller.inventory?.selectedProvider);
  if (controller.loading) return "Проверяем текстовый AI";
  return provider ? `${copyProvider(provider.id)} · ${copyState(provider.state)}` : "Настройки AI временно недоступны";
}
export function aiStateLabel(controller: AIProviderSettingsController) {
  if (controller.loading) return "Проверяем";
  const provider = controller.inventory?.providers.find((item) => item.id === controller.inventory?.selectedProvider);
  return provider ? copyState(provider.state) : "Недоступно";
}
export function AIProviderSettingsSheet({ controller, onClose }: { controller: AIProviderSettingsController; onClose: () => void }) {
  const { inventory, loading, refresh, setInventory } = controller;
  const { guardMutation } = useInteractionLock(); const { ensureCapability } = useAccess();
  const [credential, setCredential] = useState(""); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null);
  const selected = inventory?.providers.find((item) => item.id === inventory.selectedProvider);
  const mutate = useCallback(async (operation: () => Promise<Inventory>) => {
    if (!inventory || busy || !guardMutation()) { setNotice("Панель заблокирована. Сначала разблокируйте её."); return; }
    if (!await ensureCapability("settings.ai.providers", "Изменить настройки текстового AI")) { setNotice("Для изменения нужен обычный доступ."); return; }
    setBusy(true); setNotice(null);
    try { setInventory(await operation()); setCredential(""); setNotice("Сохранено. Секрет больше не отображается."); }
    catch (error) { if (error instanceof Error && error.message === "revision_conflict") { await refresh(); setNotice("Настройки изменились в другом сеансе. Показано актуальное состояние."); } else setNotice("Не удалось сохранить настройки. Секрет не отображается."); }
    finally { setBusy(false); }
  }, [busy, ensureCapability, guardMutation, inventory, refresh, setInventory]);
  return <Sheet testId="settings-ai-sheet" eyebrow="Текстовый AI" title="Провайдеры" description="Для кратких ответов по данным панели. Секреты хранятся только на Panel Agent." onClose={onClose}>
    <div className="settings-v2-sheet-content ai-provider-settings" data-testid="ai-provider-settings">
      {loading && <p className="settings-notice" role="status">Проверяем провайдеры…</p>}
      {!loading && !inventory && <p className="settings-notice" role="status">Настройки текстового AI временно недоступны.</p>}
      {inventory && <>
        {!inventory.enabled && <p className="settings-notice" role="status">Текстовый AI выключен в производственной конфигурации. Настройки показаны без активации провайдера.</p>}
        <label className="ai-provider-settings__field">Провайдер<select aria-label="Провайдер текстового AI" value={inventory.selectedProvider} disabled={busy || !inventory.writesEnabled} onChange={(event) => { const provider = event.target.value as ProviderId; const model = inventory.providers.find((item) => item.id === provider)?.model ?? ""; void mutate(() => request("/api/v1/settings/ai/selection", { method: "PATCH", body: JSON.stringify({ expectedRevision: inventory.revision, providerId: provider, modelId: model }) })); }}>{inventory.providers.map((provider) => <option key={provider.id} value={provider.id}>{copyProvider(provider.id)} · {copyState(provider.state)}</option>)}</select></label>
        {selected && selected.id !== "local" && <label className="ai-provider-settings__field">Модель<select aria-label="Модель текстового AI" value={selected.model} disabled={busy || !inventory.writesEnabled} onChange={(event) => void mutate(() => request("/api/v1/settings/ai/selection", { method: "PATCH", body: JSON.stringify({ expectedRevision: inventory.revision, providerId: selected.id, modelId: event.target.value }) }))}>{selected.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}
        {selected && selected.id === "local" && <p className="settings-notice">Модель на сервере: {selected.model || "не задана"}</p>}
        {selected && selected.id !== "local" && <section className="ai-provider-settings__credential"><strong>{copyProvider(selected.id)}: {selected.credentialPresent ? "секрет сохранён" : "секрет не добавлен"}</strong><label className="ai-provider-settings__field">Ключ доступа<input data-testid="ai-credential-input" type="password" autoComplete="new-password" value={credential} placeholder={selected.credentialPresent ? "Введите новый ключ для замены" : "Введите ключ"} onChange={(event) => setCredential(event.target.value)} disabled={busy || !inventory.writesEnabled} /></label><div className="ai-provider-settings__actions"><button type="button" className="primary-action" disabled={!credential || busy || !inventory.writesEnabled} onClick={() => void mutate(() => request(`/api/v1/settings/ai/providers/${selected.id}/credential`, { method: "PATCH", body: JSON.stringify({ expectedRevision: inventory.revision, credential }) }))}>{selected.credentialPresent ? "Заменить ключ" : "Сохранить ключ"}</button>{selected.credentialPresent && <button type="button" className="planning-secondary-button" disabled={busy || !inventory.writesEnabled} onClick={() => void mutate(() => request(`/api/v1/settings/ai/providers/${selected.id}/credential`, { method: "PATCH", body: JSON.stringify({ expectedRevision: inventory.revision, credential: null }) }))}>Удалить ключ</button>}</div></section>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
      </>}
    </div>
  </Sheet>;
}
