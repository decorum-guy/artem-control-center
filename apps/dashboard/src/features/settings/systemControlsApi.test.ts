import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSystemControls, setSystemControl } from "./systemControlsApi";

const payload = {
  schemaVersion: 1,
  platform: "windows",
  controls: {
    volume: {
      available: true,
      value: 37,
      reason: null,
      writable: true,
      writeAvailability: "allowed"
    },
    brightness: {
      available: true,
      value: 62,
      reason: null,
      writable: true,
      writeAvailability: "allowed"
    }
  }
};

describe("system controls API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads only the fixed system-controls endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSystemControls();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/settings/system-controls",
      { cache: "no-store" }
    );
  });

  it("writes only a fixed control path and bounded numeric value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await setSystemControl("volume", 55);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/settings/system-controls/volume",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 55 })
      }
    );
  });

  it("rejects invalid values before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(setSystemControl("brightness", 101)).rejects.toThrow(
      "system_control_value_out_of_range"
    );
    await expect(setSystemControl("brightness", 12.5)).rejects.toThrow(
      "system_control_value_out_of_range"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
