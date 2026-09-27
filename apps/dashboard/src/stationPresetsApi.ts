export interface StationPreset { id: string; title: string }
export interface StationPresetInventory {
  schemaVersion: 1;
  revision: string;
  updatedAt: string;
  presets: StationPreset[];
}

async function readInventory(response: Response): Promise<StationPresetInventory> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(body?.detail === "station_presets_revision_conflict" ? "revision_conflict" : "station_presets_unavailable");
  }
  return response.json() as Promise<StationPresetInventory>;
}

export async function fetchStationPresets(): Promise<StationPresetInventory> {
  return readInventory(await fetch("/api/v1/actions/station/presets", { cache: "no-store" }));
}

export async function addStationPreset(expectedRevision: string, title: string,
                                       command: string): Promise<StationPresetInventory> {
  return readInventory(await fetch("/api/v1/actions/station/presets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision, title, command })
  }));
}

export async function deleteStationPreset(expectedRevision: string,
                                          presetId: string): Promise<StationPresetInventory> {
  return readInventory(await fetch(`/api/v1/actions/station/presets/${encodeURIComponent(presetId)}`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision })
  }));
}

export async function executeStationPreset(presetId: string): Promise<void> {
  const requestId = crypto.randomUUID();
  const response = await fetch("/api/v1/actions/station/presets/execute", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ presetId, requestId })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(body?.detail === "station_dispatch_uncertain" ? "station_dispatch_uncertain" :
      body?.detail === "unknown_station_preset" ? "unknown_station_preset" : "station_dispatch_failed");
  }
  const body = await response.json() as { status?: string; requestId?: string; presetId?: string };
  if (body.status !== "dispatched" || body.requestId !== requestId || body.presetId !== presetId) {
    throw new Error("station_invalid_response");
  }
}
