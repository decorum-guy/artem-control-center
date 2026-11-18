export const HA_RESTART = "system.home_assistant.restart" as const;
export const HA_UPDATE_CORE = "system.home_assistant.update_core" as const;
export const HOME_SERVER_CADDY_RESTART = "system.home_server.caddy.restart" as const;
export const HOME_SERVER_BOT_RESTART = "system.home_server.bot.restart" as const;
export type HomeAssistantMaintenanceActionId = typeof HA_RESTART | typeof HA_UPDATE_CORE | typeof HOME_SERVER_CADDY_RESTART | typeof HOME_SERVER_BOT_RESTART;

export interface MaintenanceDecision {
  allowed: boolean;
  availability: string;
}

export interface HomeAssistantMaintenanceStatus {
  configured: boolean;
  reachable: boolean;
  statusReason?: string | null;
  maintenanceGateEnabled: boolean;
  busy: boolean;
  activeOperation?: MaintenanceOperation | null;
  services: Partial<Record<"homeAssistant" | "caddy" | "bot", { running: boolean; healthy: boolean | null; installedVersion?: string; configuredImage?: string }>>;
  actions: Record<HomeAssistantMaintenanceActionId, MaintenanceDecision>;
}

export interface MaintenanceOperation {
  requestId: string;
  actionId: HomeAssistantMaintenanceActionId;
  status: "requested" | "dispatching" | "waiting_for_disconnect" | "waiting_for_recovery" | "verifying" | "success" | "failed";
  failureCode: string | null;
  result?: "up_to_date" | "success" | null;
}

export interface HomeAssistantUpdateCheck {
  installedVersion: string;
  latestVersion: string;
  state: "available" | "up_to_date" | "ahead";
  checkedAt: string;
}

const safeCodes = new Set([
  "busy", "maintenance_busy", "maintenance_disabled", "configuration_missing", "compose_failed",
  "update_failed", "helper_failed", "ssh_timeout", "ssh_transport_failed", "ssh_invalid_response",
  "restart_recovery_timeout", "update_recovery_timeout", "update_not_applied", "request_id_conflict",
  "profile_blocked", "pin_not_configured", "elevation_required", "gate_disabled", "integration_unavailable",
  "home_server_not_configured", "installed_version_unknown", "unsupported_release_channel", "release_feed_unavailable",
  "ssh_client_unavailable", "ssh_identity_file_missing", "ssh_known_hosts_file_missing", "ssh_output_too_large"
]);

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

export async function checkHomeAssistantUpdate(): Promise<HomeAssistantUpdateCheck> {
  return parse(await fetch("/api/v1/actions/home-assistant/maintenance/update-check", { cache: "no-store" }));
}

export async function startHomeAssistantMaintenance(actionId: HomeAssistantMaintenanceActionId, requestId: string): Promise<MaintenanceOperation> {
  return parse(await fetch("/api/v1/actions/home-assistant/maintenance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId, requestId }) }));
}

export async function fetchHomeAssistantMaintenanceOperation(requestId: string): Promise<MaintenanceOperation> {
  return parse(await fetch(`/api/v1/actions/home-assistant/maintenance/${encodeURIComponent(requestId)}`, { cache: "no-store" }));
}
