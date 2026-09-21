import { afterEach, describe, expect, it, vi } from "vitest";
import { HA_RESTART, HA_UPDATE_CORE, fetchHomeAssistantMaintenance, startHomeAssistantMaintenance } from "./homeAssistantMaintenanceApi";

describe("Home Assistant maintenance API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the narrow status endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ actions: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchHomeAssistantMaintenance();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/actions/home-assistant/maintenance", { cache: "no-store" });
  });

  it("posts only the fixed action id and request id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requestId: "request", actionId: HA_UPDATE_CORE, status: "requested", failureCode: null }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await startHomeAssistantMaintenance(HA_UPDATE_CORE, "request");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/actions/home-assistant/maintenance", expect.objectContaining({ method: "POST", body: JSON.stringify({ actionId: HA_UPDATE_CORE, requestId: "request" }) }));
    expect(HA_RESTART).toBe("system.home_assistant.restart");
  });
});
