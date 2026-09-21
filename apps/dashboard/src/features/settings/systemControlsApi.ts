export type SystemControlName = "volume" | "brightness";

export interface SystemControlStatus {
  available: boolean;
  value: number | null;
  reason: "unsupported" | "unavailable" | null;
  writable: boolean;
  writeAvailability: string;
}

export interface SystemControlsStatus {
  schemaVersion: 1;
  platform: "windows" | "unsupported";
  controls: Record<SystemControlName, SystemControlStatus>;
}

const controlPaths: Record<SystemControlName, string> = {
  volume: "/api/v1/settings/system-controls/volume",
  brightness: "/api/v1/settings/system-controls/brightness"
};

async function parse(response: Response): Promise<SystemControlsStatus> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-derived failure when the response has no JSON body.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<SystemControlsStatus>;
}

export async function fetchSystemControls(): Promise<SystemControlsStatus> {
  return parse(await fetch("/api/v1/settings/system-controls", { cache: "no-store" }));
}

export async function setSystemControl(
  control: SystemControlName,
  value: number
): Promise<SystemControlsStatus> {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("system_control_value_out_of_range");
  }
  return parse(await fetch(controlPaths[control], {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value })
  }));
}
