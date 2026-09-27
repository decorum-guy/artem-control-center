export const STATION_ACTIONS = [
  "media.alice.play", "media.alice.pause", "media.alice.volume_down",
  "media.alice.volume_up", "media.alice.previous", "media.alice.next", "media.alice.like"
] as const;
export type StationActionId = typeof STATION_ACTIONS[number];
export type StationAvailability = "allowed" | "elevation_required" | "profile_blocked" |
  "pin_not_configured" | "gate_disabled" | "integration_unavailable" | "busy" |
  "cooldown" | "precondition_failed";
export interface StationDecision {
  allowed: boolean;
  availability: StationAvailability;
  gateEnabled: boolean;
  integrationAvailable: boolean;
  busy: boolean;
}
export interface StationActionAvailability {
  schemaVersion: 1;
  actions: Record<StationActionId, StationDecision>;
}
export interface StationActionResponse {
  schemaVersion: 1;
  actionId: StationActionId;
  requestId: string;
  status: "dispatched";
}

export async function fetchStationAvailability(): Promise<StationActionAvailability> {
  const response = await fetch("/api/v1/actions/station/availability", { cache: "no-store" });
  if (!response.ok) throw new Error("availability_unavailable");
  return response.json() as Promise<StationActionAvailability>;
}

export async function executeStationAction(actionId: StationActionId): Promise<StationActionResponse> {
  const requestId = crypto.randomUUID();
  const response = await fetch("/api/v1/actions/station", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId, requestId })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(body?.detail === "station_dispatch_uncertain" ? "station_dispatch_uncertain" : "station_dispatch_failed");
  }
  const payload = await response.json() as StationActionResponse;
  if (payload.status !== "dispatched" || payload.requestId !== requestId || payload.actionId !== actionId) {
    throw new Error("station_invalid_response");
  }
  return payload;
}
