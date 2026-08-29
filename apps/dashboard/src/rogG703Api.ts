import type { CapabilityDecision } from "./accessApi";

export const ROG_G703_TARGET_ID = "rog_g703gi" as const;
export const ROG_G703_WAKE_ACTION = "system.rog_g703.wake" as const;
export const ROG_G703_HIBERNATE_ACTION = "system.rog_g703.hibernate" as const;
export const ROG_G703_SLEEP_ACTION = "system.rog_g703.sleep" as const;

export type RogG703ActionId =
  | typeof ROG_G703_WAKE_ACTION
  | typeof ROG_G703_HIBERNATE_ACTION
  | typeof ROG_G703_SLEEP_ACTION;

export type RogG703DeviceStatus =
  | "online"
  | "offline"
  | "waking"
  | "sleeping"
  | "hibernating"
  | "unavailable";

export type RogG703ActionStatus =
  | "requested"
  | "waking"
  | "verifying"
  | "online"
  | "wake_timeout"
  | "sleeping"
  | "hibernating"
  | "offline"
  | "failed";

export interface RogG703ActionAvailability extends CapabilityDecision {
  cooldownUntil: string | null;
  targetId: typeof ROG_G703_TARGET_ID;
  status: RogG703DeviceStatus;
}

export interface RogG703PublicStatus {
  targetId: typeof ROG_G703_TARGET_ID;
  status: RogG703DeviceStatus;
  observedAt: string;
  lastTransitionAt: string;
  lastError: string | null;
}

export interface RogG703ActionExecution {
  schemaVersion: 1;
  correlationId: string;
  targetId: typeof ROG_G703_TARGET_ID;
  actionId: RogG703ActionId;
  status: RogG703ActionStatus;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result: {
    packetsSent?: number;
    onlineConfirmed?: boolean;
    offlineConfirmed?: boolean;
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
      // Keep the status-based fallback without exposing response bodies.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchRogG703Availability(): Promise<{
  targetId: typeof ROG_G703_TARGET_ID;
  status: RogG703PublicStatus;
  actions: Record<RogG703ActionId, RogG703ActionAvailability>;
}> {
  return parse(await fetch(
    "/api/v1/actions/system/rog-g703/availability",
    { cache: "no-store" }
  ));
}

export async function startRogG703Action(
  actionId: RogG703ActionId
): Promise<RogG703ActionExecution> {
  return parse(await fetch("/api/v1/actions/system/rog-g703", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId })
  }));
}

export async function fetchRogG703Execution(
  correlationId: string
): Promise<RogG703ActionExecution> {
  return parse(await fetch(
    `/api/v1/actions/system/rog-g703/${encodeURIComponent(correlationId)}`,
    { cache: "no-store" }
  ));
}

export async function waitForRogG703Execution(
  correlationId: string,
  onProgress?: (execution: RogG703ActionExecution) => void
): Promise<RogG703ActionExecution> {
  // The Panel Agent owns the bounded verification window and publishes the
  // terminal result. The browser only observes that server-owned state.
  while (true) {
    const execution = await fetchRogG703Execution(correlationId);
    onProgress?.(execution);
    if (["online", "offline", "wake_timeout", "failed"].includes(execution.status)) {
      return execution;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}
