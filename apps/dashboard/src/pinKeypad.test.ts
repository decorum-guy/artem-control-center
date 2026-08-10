import { describe, expect, it } from "vitest";
import {
  PIN_MAX_LENGTH,
  applyPinKey,
  isValidPin,
  normalizePin
} from "./pinKeypad";

describe("pin keypad helpers", () => {
  it("accepts only four to twelve digits", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456789012")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567890123")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });

  it("normalizes pasted or keyboard input without exposing non-digits", () => {
    expect(normalizePin("12-34 abc 56")).toBe("123456");
    expect(normalizePin("1234567890123456")).toHaveLength(PIN_MAX_LENGTH);
  });

  it("supports digit, backspace and clear keypad actions", () => {
    let pin = "";
    pin = applyPinKey(pin, "1");
    pin = applyPinKey(pin, "2");
    pin = applyPinKey(pin, "3");
    expect(pin).toBe("123");

    pin = applyPinKey(pin, "backspace");
    expect(pin).toBe("12");

    pin = applyPinKey(pin, "clear");
    expect(pin).toBe("");
  });

  it("does not append digits beyond the maximum PIN length", () => {
    const full = "123456789012";
    expect(applyPinKey(full, "3")).toBe(full);
  });
});
