import { describe, expect, it } from "vitest";
import { applyNumericKey, normalizeNumericInput, numericInputValue } from "./coffeeDiaryNumeric";

describe("coffee diary numeric input", () => {
  it("normalizes comma decimals and keeps one separator", () => {
    expect(normalizeNumericInput("1,25.7.9")).toBe("1.2579");
    expect(normalizeNumericInput(",5")).toBe("0.5");
  });

  it("supports integer-only fields without decimal punctuation", () => {
    expect(normalizeNumericInput("1.5", false)).toBe("15");
    expect(applyNumericKey("9", ".", false)).toBe("9");
  });

  it("handles keypad utility keys and bounded values", () => {
    expect(applyNumericKey("12", "backspace")).toBe("1");
    expect(applyNumericKey("12", "clear")).toBe("");
    expect(applyNumericKey("123", "4", true, 3)).toBe("123");
  });

  it("does not turn an incomplete decimal into a submitted number", () => {
    expect(numericInputValue("")).toBeNull();
    expect(numericInputValue("12.")).toBeNull();
    expect(numericInputValue("12.5")).toBe(12.5);
  });
});
