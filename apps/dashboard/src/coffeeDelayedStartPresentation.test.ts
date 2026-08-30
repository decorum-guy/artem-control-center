import { describe, expect, it, vi } from "vitest";
import { applyNumericKey } from "./coffeeDiaryNumeric";
import { COFFEE_DELAY_MAX_MINUTES, COFFEE_DELAY_MIN_MINUTES, createCoffeeDelayedStart, isCoffeeDelayMinutes } from "./coffeeApi";
import { coffeeDelayCountdownLabel, coffeeDelayRemainingMinutes } from "./coffeeDelayedStartPresentation";
import { numericKeyLabel, numericKeyOrder } from "./numericKeypadShared";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, applyPinKey, isValidPin } from "./pinKeypad";

describe("Coffee delayed-start presentation and bounded keypad", () => {
  it("uses the server-compatible positive minute bounds", () => {
    expect(COFFEE_DELAY_MIN_MINUTES).toBe(1);
    expect(COFFEE_DELAY_MAX_MINUTES).toBe(120);
    expect(Number.isInteger(COFFEE_DELAY_MIN_MINUTES)).toBe(true);
    expect(Number.isInteger(COFFEE_DELAY_MAX_MINUTES)).toBe(true);
    expect([1, 5, 120].every(isCoffeeDelayMinutes)).toBe(true);
    expect([0, -1, 121, 1.5, Number.NaN, "5"].some((value) => isCoffeeDelayMinutes(value))).toBe(false);
  });

  it("keeps the accepted 3x4 keypad order and Coffee plain-number semantics", () => {
    expect(numericKeyOrder(false)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "backspace", "0", "clear"]);
    expect(numericKeyOrder(true)).toContain(".");
    expect(numericKeyLabel("backspace", "C")).toBe("←");
    expect(numericKeyLabel("clear", "C")).toBe("C");
    expect(applyNumericKey("", "1", false, 3, 0)).toBe("1");
    expect(applyNumericKey("12", "0", false, 3, 0)).toBe("120");
    expect(applyNumericKey("120", "1", false, 3, 0)).toBe("120");
    expect(applyNumericKey("12", ".", false, 3, 0)).toBe("12");
  });

  it("keeps PIN length, masking state, and validation semantics separate", () => {
    expect(PIN_MIN_LENGTH).toBe(4);
    expect(PIN_MAX_LENGTH).toBe(12);
    expect(applyPinKey("12", "3")).toBe("123");
    expect(applyPinKey("123", "backspace")).toBe("12");
    expect(applyPinKey("123", "clear")).toBe("");
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("12.4")).toBe(false);
  });

  it("reconstructs the countdown only from the server dueAt", () => {
    const dueAt = "2026-08-30T12:10:00Z";
    const before = Date.parse("2026-08-30T12:00:01Z");
    expect(coffeeDelayRemainingMinutes(dueAt, before)).toBe(10);
    expect(coffeeDelayCountdownLabel(dueAt, before)).toBe("10 мин");
    expect(coffeeDelayRemainingMinutes(dueAt, Date.parse("2026-08-30T12:10:00Z"))).toBe(0);
    expect(coffeeDelayCountdownLabel(dueAt, Date.parse("2026-08-30T12:10:00Z"))).toBe("время наступило");
    expect(coffeeDelayCountdownLabel("bad", before)).toBe("время уточняется");
  });

  it("submits a fixed typed delay payload through the Coffee API client", async () => {
    const response = new Response(JSON.stringify({ schedule: null, available: true, writesEnabled: true }), { status: 200 });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createCoffeeDelayedStart(10, "request-dashboard");
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/actions/home/coffee/delayed-start", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ delayMinutes: 10, requestId: "request-dashboard" })
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
