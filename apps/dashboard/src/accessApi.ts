export type AccessProfile = "read_only" | "standard" | "full";
export type ActionAvailability =
  | "allowed"
  | "elevation_required"
  | "profile_blocked"
  | "pin_not_configured"
  | "gate_disabled"
  | "integration_unavailable"
  | "busy"
  | "cooldown"
  | "precondition_failed";

export interface CapabilityDecision {
  capability: string;
  minimumProfile: AccessProfile;
  effectiveProfile: AccessProfile;
  allowed: boolean;
  availability: ActionAvailability;
  cooldownUntil?: string | null;
}

export interface AccessStatus {
  schemaVersion: 1;
  revision: number;
  baseProfile: AccessProfile;
  effectiveProfile: AccessProfile;
  temporaryFull: boolean;
  temporaryFullExpiresAt: string | null;
  pinConfigured: boolean;
  lockoutUntil: string | null;
  capabilities: Record<string, CapabilityDecision>;
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-based error when the body is not JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchAccessStatus(): Promise<AccessStatus> {
  return parse<AccessStatus>(await fetch("/api/v1/access", { cache: "no-store" }));
}

export async function unlockTemporaryFull(pin: string): Promise<AccessStatus> {
  return parse<AccessStatus>(await fetch("/api/v1/access/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  }));
}

export async function setAccessProfile(
  profile: AccessProfile,
  pin?: string
): Promise<AccessStatus> {
  return parse<AccessStatus>(await fetch("/api/v1/access/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, ...(pin ? { pin } : {}) })
  }));
}

export async function clearTemporaryFull(): Promise<AccessStatus> {
  return parse<AccessStatus>(await fetch("/api/v1/access/lock", {
    method: "POST"
  }));
}
