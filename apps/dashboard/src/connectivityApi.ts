import type { CapabilityDecision } from "./accessApi";

export const CONNECTIVITY_ACTION_ID = "system.connectivity.restart" as const;
export type ConnectivityActionId = typeof CONNECTIVITY_ACTION_ID;

export type ConnectivityActionStatus =
  | "requested"
  | "restarting"
  | "waiting_for_forwards"
  | "verifying"
  | "connected"
  | "degraded"
  | "failed";

export interface ConnectivityActionAvailability extends CapabilityDecision {
  activeCorrelationId: string | null;
}

export interface ConnectivityActionExecution {
  schemaVersion: 1;
  correlationId: string;
  actionId: ConnectivityActionId;
  status: ConnectivityActionStatus;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result: {
    homeAssistantForwardReady?: boolean;
    aliceForwardReady?: boolean;
    homeAssistantLive?: boolean;
    homeAssistantWebSocket?: boolean;
    homeAssistantSnapshotConfirmed?: boolean;
    aliceLive?: boolean;
    aliceHealthy?: boolean;
  } | null;
  error: string | null;
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-based fallback.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchConnectivityAvailability(): Promise<ConnectivityActionAvailability> {
  const payload = await parse<{
    schemaVersion: 1;
    action: ConnectivityActionAvailability;
  }>(await fetch("/api/v1/actions/system/connectivity/availability", { cache: "no-store" }));
  return payload.action;
}

export async function startConnectivityRestart(): Promise<ConnectivityActionExecution> {
  return parse<ConnectivityActionExecution>(await fetch("/api/v1/actions/system/connectivity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId: CONNECTIVITY_ACTION_ID })
  }));
}

export async function fetchConnectivityExecution(
  correlationId: string
): Promise<ConnectivityActionExecution> {
  return parse<ConnectivityActionExecution>(await fetch(
    `/api/v1/actions/system/connectivity/${encodeURIComponent(correlationId)}`,
    { cache: "no-store" }
  ));
}

export async function waitForConnectivityExecution(
  correlationId: string,
  onProgress?: (execution: ConnectivityActionExecution) => void
): Promise<ConnectivityActionExecution> {
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    const execution = await fetchConnectivityExecution(correlationId);
    onProgress?.(execution);
    if (["connected", "degraded", "failed"].includes(execution.status)) return execution;
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  throw new Error("connectivity_status_timeout");
}
