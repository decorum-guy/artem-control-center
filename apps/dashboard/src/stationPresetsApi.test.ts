import { afterEach, describe, expect, it, vi } from "vitest";
import { addStationPreset, deleteStationPreset, executeStationPreset, fetchStationPresets } from "./stationPresetsApi";

afterEach(() => vi.unstubAllGlobals());

describe("Station preset browser contract", () => {
  it("keeps execution ID-only and command in create configuration", async () => {
    const calls: Array<{ url: string; body?: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, string> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/execute")) {
        return new Response(JSON.stringify({ status: "dispatched", ...body }), { status: 200 });
      }
      return new Response(JSON.stringify({ schemaVersion: 1, revision: "r2", updatedAt: "now", presets: [] }), { status: 200 });
    }));
    await fetchStationPresets();
    await executeStationPreset("a1b2c3d4e5f6");
    await addStationPreset("r1", "Тест", "Включи тест");
    await deleteStationPreset("r2", "a1b2c3d4e5f6");
    expect(calls[1].body && Object.keys(calls[1].body).sort()).toEqual(["presetId", "requestId"]);
    expect(calls[1].body?.presetId).toBe("a1b2c3d4e5f6");
    expect(calls[2].body).toEqual({ expectedRevision: "r1", title: "Тест", command: "Включи тест" });
    expect(calls[3].body).toEqual({ expectedRevision: "r2" });
  });

  it("maps revision conflict without leaking configuration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "station_presets_revision_conflict" }), { status: 409 })));
    await expect(addStationPreset("stale", "Тест", "Команда")).rejects.toThrow("revision_conflict");
  });
});
