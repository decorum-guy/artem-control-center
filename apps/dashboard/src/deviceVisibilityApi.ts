import type { DeviceVisibilitySettings, OverviewLightStripId, OwnerFacingDeviceKey } from "@artem/contracts";

export type DevicePresentationPatch =
  | { deviceKey: OwnerFacingDeviceKey; visible: boolean }
  | { overviewLightStripId: OverviewLightStripId | null };

export const overviewLightStripLabels: Record<OverviewLightStripId, string> = {
  "living-room-light-strip": "Лента в зале",
  "bedroom-ble-light-strip": "Лента в спальне"
};

export function isOverviewLightStripId(value: unknown): value is OverviewLightStripId {
  return typeof value === "string" && Object.hasOwn(overviewLightStripLabels, value);
}

export class DeviceVisibilityApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown): DeviceVisibilitySettings {
  const revision = isRecord(value) ? value.revision : undefined;
  if (!isRecord(value) || value.schemaVersion !== "device.visibility.v1" || typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 || typeof value.updatedAt !== "string" || typeof value.available !== "boolean" || typeof value.writesEnabled !== "boolean" || !Array.isArray(value.devices) || !Array.isArray(value.warnings)) {
    throw new DeviceVisibilityApiError("contract_invalid", 200);
  }
  const devices = value.devices.map((entry): DeviceVisibilitySettings["devices"][number] => {
    if (!isRecord(entry) || entry.key !== "kettle" || typeof entry.label !== "string" || entry.label.length === 0 || typeof entry.defaultVisible !== "boolean" || typeof entry.visible !== "boolean") {
      throw new DeviceVisibilityApiError("contract_invalid", 200);
    }
    return { key: "kettle", label: entry.label, defaultVisible: entry.defaultVisible, visible: entry.visible };
  });
  if (devices.length !== 1 || devices[0].key !== "kettle" || value.warnings.some((warning) => warning !== "stored_device_visibility_unavailable")) {
    throw new DeviceVisibilityApiError("contract_invalid", 200);
  }
  const overviewLightStripId = value.overviewLightStripId ?? null;
  if (overviewLightStripId !== null && !isOverviewLightStripId(overviewLightStripId)) {
    throw new DeviceVisibilityApiError("contract_invalid", 200);
  }
  return { schemaVersion: "device.visibility.v1", revision, updatedAt: value.updatedAt, devices, overviewLightStripId, available: value.available, warnings: value.warnings as DeviceVisibilitySettings["warnings"], writesEnabled: value.writesEnabled };
}

async function request(path: string, init?: RequestInit): Promise<DeviceVisibilitySettings> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new DeviceVisibilityApiError("network", 0);
  }
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === "string") code = body.detail;
    } catch { /* retain HTTP status */ }
    throw new DeviceVisibilityApiError(code, response.status);
  }
  return parseSettings(await response.json());
}

export function getDeviceVisibility(signal?: AbortSignal): Promise<DeviceVisibilitySettings> {
  return request("/api/v1/settings/device-visibility", { signal });
}

export function patchDeviceVisibility(entry: DevicePresentationPatch & { expectedRevision: number }): Promise<DeviceVisibilitySettings> {
  return request("/api/v1/settings/device-visibility", { method: "PATCH", body: JSON.stringify(entry) });
}
