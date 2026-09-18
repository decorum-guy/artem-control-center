import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAccessStatus, unlockTemporaryFull, setAccessProfile, clearTemporaryFull } from "./accessApi";

describe("accessApi", () => {
  let globalFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalFetchMock = vi.fn();
    global.fetch = globalFetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockResponse = {
    schemaVersion: 1,
    revision: 1,
    baseProfile: "standard",
    effectiveProfile: "standard",
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    confirmationPolicy: {
      actionConfirmationRequired: true,
      mode: "profile_default"
    },
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {}
  };

  test("fetchAccessStatus uses GET /api/v1/access", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    });

    const result = await fetchAccessStatus();
    expect(result).toEqual(mockResponse);
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/access", { cache: "no-store" });
  });

  test("unlockTemporaryFull uses POST /api/v1/access/unlock and correct JSON body", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    });

    await unlockTemporaryFull("1234");
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/access/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1234" })
    });
  });

  test("setAccessProfile uses PATCH /api/v1/access/profile and correct profile/PIN body behavior", async () => {
    globalFetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    });

    await setAccessProfile("full", "1234");
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/access/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "full", pin: "1234" })
    });

    await setAccessProfile("read_only");
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/access/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "read_only" })
    });
  });

  test("clearTemporaryFull uses POST /api/v1/access/lock", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    });

    await clearTemporaryFull();
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/access/lock", {
      method: "POST"
    });
  });

  test("bounded JSON detail error", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ detail: "invalid_pin" })
    });

    await expect(fetchAccessStatus()).rejects.toThrow("invalid_pin");
  });

  test("non-JSON HTTP fallback", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error("Not JSON"); }
    });

    await expect(fetchAccessStatus()).rejects.toThrow("request_failed_502");
  });
});
