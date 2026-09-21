export const HA_RESTART = "system.home_assistant.restart" as const;
export const HA_UPDATE_CORE = "system.home_assistant.update_core" as const;
export type HomeAssistantMaintenanceActionId = typeof HA_RESTART | typeof HA_UPDATE_CORE;

export interface MaintenanceDecision {
  allowed: boolean;
  availability: string;
}

export interface HomeAssistantMaintenanceStatus {
  configured: boolean;
  reachable: boolean;
  adminAuthorized: boolean;
  maintenanceGateEnabled: boolean;
  busy: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateInProgress: boolean;
  installSupported: boolean;
  backupSupported: boolean;
  actions: Record<HomeAssistantMaintenanceActionId, MaintenanceDecision>;
}

export interface MaintenanceOperation {
  requestId: string;
  actionId: HomeAssistantMaintenanceActionId;
  status: "requested" | "dispatching" | "waiting_for_disconnect" | "waiting_for_recovery" | "verifying" | "success" | "failed";
  failureCode: string | null;
}

const safeCodes = new Set(["admin_required", "maintenance_busy", "maintenance_disabled", "core_update_unavailable", "update_not_available", "update_in_progress", "install_unsupported", "restart_recovery_timeout", "update_recovery_timeout", "update_not_applied", "profile_blocked", "elevation_required", "gate_disabled"]);

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try { const body = await response.json() as { detail?: unknown }; if (typeof body.detail === "string" && safeCodes.has(body.detail)) detail = body.detail; } catch { /* bounded fallback */ }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchHomeAssistantMaintenance(): Promise<HomeAssistantMaintenanceStatus> {
  return parse(await fetch("/api/v1/actions/home-assistant/maintenance", { cache: "no-store" }));
}

export async function startHomeAssistantMaintenance(actionId: HomeAssistantMaintenanceActionId, requestId: string): Promise<MaintenanceOperation> {
  return parse(await fetch("/api/v1/actions/home-assistant/maintenance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId, requestId }) }));
}

export async function fetchHomeAssistantMaintenanceOperation(requestId: string): Promise<MaintenanceOperation> {
  return parse(await fetch(`/api/v1/actions/home-assistant/maintenance/${encodeURIComponent(requestId)}`, { cache: "no-store" }));
}
