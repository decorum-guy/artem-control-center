import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStationAction } from "./stationActionsApi";

afterEach(() => vi.unstubAllGlobals());

describe("Station frontend action contract", () => {
  it("sends only the fixed action ID and generated UUID", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as { actionId: string; requestId: string };
      expect(Object.keys(body).sort()).toEqual(["actionId", "requestId"]);
      expect(body.actionId).toBe("media.alice.next");
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      return new Response(JSON.stringify({ schemaVersion: 1, ...body, status: "dispatched" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await executeStationAction("media.alice.next");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/actions/station");
  });
});
