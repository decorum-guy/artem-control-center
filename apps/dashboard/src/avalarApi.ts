import type { CapabilityDecision } from "./accessApi";

export type AvalarActionId =
  | "avalar.main.smoke"
  | "avalar.stage.smoke"
  | "avalar.main.restart"
  | "avalar.stage.restart"
  | "avalar.stage.deploy"
  | "avalar.main.deploy";

export type AvalarActionStatus =
  | "requested"
  | "prechecking"
  | "accepted"
  | "running"
  | "verifying"
  | "success"
  | "failed";

export interface AvalarActionExecution {
  schemaVersion: 1;
  correlationId: string;
  actionId: AvalarActionId;
  environment: "production" | "stage";
  status: AvalarActionStatus;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface AvalarActionAvailability extends CapabilityDecision {
  cooldownUntil: string | null;
}

export const avalarActionTitles: Record<AvalarActionId, string> = {
  "avalar.main.smoke": "Проверить Main",
  "avalar.stage.smoke": "Проверить Stage",
  "avalar.main.restart": "Перезапустить Main",
  "avalar.stage.restart": "Перезапустить Stage",
  "avalar.stage.deploy": "Обновить Stage",
  "avalar.main.deploy": "Обновить Main"
};

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-based error.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchAvalarAvailability(): Promise<Record<AvalarActionId, AvalarActionAvailability>> {
  const payload = await parse<{
    schemaVersion: 1;
    actions: Record<AvalarActionId, AvalarActionAvailability>;
  }>(await fetch("/api/v1/actions/avalar/availability", { cache: "no-store" }));
  return payload.actions;
}

export async function startAvalarAction(
  actionId: AvalarActionId,
  options: { expectedRevision?: string; confirmation?: string } = {}
): Promise<AvalarActionExecution> {
  return parse<AvalarActionExecution>(await fetch("/api/v1/actions/avalar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId, ...options })
  }));
}

export async function fetchAvalarExecution(correlationId: string): Promise<AvalarActionExecution> {
  return parse<AvalarActionExecution>(await fetch(
    `/api/v1/actions/avalar/${encodeURIComponent(correlationId)}`,
    { cache: "no-store" }
  ));
}

export async function waitForAvalarExecution(
  correlationId: string,
  onProgress?: (execution: AvalarActionExecution) => void
): Promise<AvalarActionExecution> {
  const deadline = Date.now() + 190_000;
  while (Date.now() < deadline) {
    const execution = await fetchAvalarExecution(correlationId);
    onProgress?.(execution);
    if (execution.status === "success" || execution.status === "failed") return execution;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("action_status_timeout");
}
