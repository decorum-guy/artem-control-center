import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeHomeAssistantAction,
  fetchHomeAssistantActionAvailability,
  HOME_CLIMATE_POWER_ON,
  HOME_CLIMATE_POWER_OFF,
  HOME_CLIMATE_SET_FAN_MODE,
  HOME_CLIMATE_SET_MODE,
  HOME_CLIMATE_SET_TEMPERATURE,
  ROG_PSU_BP1_OFF,
  ROG_PSU_BP1_ON,
  ROG_PSU_BP2_OFF,
  ROG_PSU_BP2_ON,
  ROG_PSU_MODE_FULL,
  ROG_PSU_MODE_NORMAL
} from "./homeAssistantControlApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Home Assistant typed action API", () => {
  it("keeps the exact eleven action identifiers", () => {
    expect([
      HOME_CLIMATE_POWER_ON,
      HOME_CLIMATE_POWER_OFF,
      HOME_CLIMATE_SET_TEMPERATURE,
      HOME_CLIMATE_SET_MODE,
      HOME_CLIMATE_SET_FAN_MODE,
      ROG_PSU_MODE_NORMAL,
      ROG_PSU_MODE_FULL,
      ROG_PSU_BP1_ON,
      ROG_PSU_BP1_OFF,
      ROG_PSU_BP2_ON,
      ROG_PSU_BP2_OFF
    ]).toHaveLength(11);
  });

  it("posts only the fixed typed request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "confirmed" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await executeHomeAssistantAction({
      actionId: HOME_CLIMATE_SET_TEMPERATURE,
      requestId: "00000000-0000-4000-8000-000000000001",
      temperature: 32,
      mode: null,
      fanMode: null
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/actions/home-assistant", expect.objectContaining({ method: "POST" }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      actionId: HOME_CLIMATE_SET_TEMPERATURE,
      requestId: "00000000-0000-4000-8000-000000000001",
      temperature: 32,
      mode: null,
      fanMode: null
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("entityId");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("service");
  });

  it("uses no-store availability and preserves bounded error codes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, actions: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "unknown_internal_detail" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchHomeAssistantActionAvailability();
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store" });
    await expect(executeHomeAssistantAction({
      actionId: HOME_CLIMATE_POWER_ON,
      requestId: "00000000-0000-4000-8000-000000000002"
    })).rejects.toThrow("request_failed_500");
  });
});
