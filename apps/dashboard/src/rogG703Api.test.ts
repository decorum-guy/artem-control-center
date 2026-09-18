// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchRogG703Availability, startRogG703Action, fetchRogG703Execution, waitForRogG703Execution, ROG_G703_WAKE_ACTION } from "./rogG703Api";

describe("rogG703Api", () => {
  let globalFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalFetchMock = vi.fn();
    global.fetch = globalFetchMock;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockResponse = { some: "data" };

  test("availability uses fixed endpoint", async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: true, json: async () => mockResponse });

    const result = await fetchRogG703Availability();
    expect(result).toEqual(mockResponse);
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/actions/system/rog-g703/availability", { cache: "no-store" });
  });

  test("action start uses fixed POST endpoint and body", async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: true, json: async () => mockResponse });

    await startRogG703Action(ROG_G703_WAKE_ACTION);
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/actions/system/rog-g703", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: ROG_G703_WAKE_ACTION })
    });
  });

  test("execution lookup URL-encodes correlationId", async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: true, json: async () => mockResponse });

    await fetchRogG703Execution("my id/?");
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/actions/system/rog-g703/my%20id%2F%3F", { cache: "no-store" });
  });

  test("JSON detail error fallback", async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ detail: "action_conflict" }) });

    await expect(fetchRogG703Availability()).rejects.toThrow("action_conflict");
  });

  test("non-JSON HTTP fallback", async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: false, status: 504, json: async () => { throw new Error("not JSON"); } });

    await expect(fetchRogG703Availability()).rejects.toThrow("request_failed_504");
  });

  test("polling helper terminal status", async () => {
    globalFetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "waking" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "verifying" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "online" }) });

    const onProgress = vi.fn();
    const promise = waitForRogG703Execution("req-1", onProgress);

    // Initial fetch happens immediately
    // Wait for microtasks to process the first fetch
    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith({ status: "waking" });
    });

    // Advance first timer
    await vi.advanceTimersToNextTimerAsync();

    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith({ status: "verifying" });
    });

    // Advance second timer
    await vi.advanceTimersToNextTimerAsync();

    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith({ status: "online" });
    });

    const result = await promise;
    expect(result).toEqual({ status: "online" });
    expect(globalFetchMock).toHaveBeenCalledTimes(3);
  });
});
