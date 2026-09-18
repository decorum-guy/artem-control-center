import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { isCoffeeDelayMinutes, getCoffeeTiming, CoffeeApiError, patchCoffeeTiming, executeCoffeeAction } from "./coffeeApi";

describe("coffeeApi", () => {
  describe("isCoffeeDelayMinutes", () => {
    test("valid cases", () => {
      expect(isCoffeeDelayMinutes(1)).toBe(true);
      expect(isCoffeeDelayMinutes(120)).toBe(true);
      expect(isCoffeeDelayMinutes(60)).toBe(true);
    });

    test("invalid cases", () => {
      expect(isCoffeeDelayMinutes(0)).toBe(false);
      expect(isCoffeeDelayMinutes(121)).toBe(false);
      expect(isCoffeeDelayMinutes(-1)).toBe(false);
      expect(isCoffeeDelayMinutes(1.5)).toBe(false);
      expect(isCoffeeDelayMinutes(NaN)).toBe(false);
      expect(isCoffeeDelayMinutes(Infinity)).toBe(false);
      expect(isCoffeeDelayMinutes("10")).toBe(false);
      expect(isCoffeeDelayMinutes(null)).toBe(false);
      expect(isCoffeeDelayMinutes(undefined)).toBe(false);
      expect(isCoffeeDelayMinutes({})).toBe(false);
    });
  });

  describe("fetch contracts", () => {
    let globalFetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      globalFetchMock = vi.fn();
      global.fetch = globalFetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test("successful JSON response", async () => {
      const mockResponse = { warmupMinutes: 15, longRunningMinutes: 60 };
      globalFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const result = await getCoffeeTiming();
      expect(result).toEqual(mockResponse);
      expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/settings/coffee/timing", {
        headers: { "content-type": "application/json" }
      });
    });

    test("non-2xx JSON { detail: \"...\" } becomes the bounded CoffeeApiError", async () => {
      globalFetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: "validation_error" })
      });

      await expect(getCoffeeTiming()).rejects.toThrow(CoffeeApiError);

      try {
        await getCoffeeTiming();
      } catch(e) {
        expect(e).toBeInstanceOf(CoffeeApiError);
        expect((e as CoffeeApiError).status).toBe(400);
        expect((e as CoffeeApiError).code).toBe("validation_error");
      }
    });

    test("non-JSON error body falls back to http_<status>", async () => {
      globalFetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => { throw new Error("Not a JSON"); }
      });

      await expect(getCoffeeTiming()).rejects.toThrow(CoffeeApiError);

      try {
        await getCoffeeTiming();
      } catch(e) {
        expect(e).toBeInstanceOf(CoffeeApiError);
        expect((e as CoffeeApiError).status).toBe(503);
        expect((e as CoffeeApiError).code).toBe("http_503");
      }
    });

    test("representative fixed endpoint/method/body - patchCoffeeTiming", async () => {
      globalFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ warmupMinutes: 15, longRunningMinutes: 60 })
      });

      await patchCoffeeTiming({ expectedRevision: "123", warmupMinutes: 15 });

      expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/settings/coffee/timing", {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: "123", warmupMinutes: 15 }),
        headers: { "content-type": "application/json" }
      });
    });

    test("no accidental request-shape drift - executeCoffeeAction", async () => {
      globalFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "accepted" })
      });

      await executeCoffeeAction("turn_on", "req-123");

      expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/actions/home/coffee", {
        method: "POST",
        body: JSON.stringify({ action: "turn_on", requestId: "req-123" }),
        headers: { "content-type": "application/json" }
      });
    });

  });
});
