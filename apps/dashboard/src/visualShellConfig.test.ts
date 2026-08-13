import { describe, expect, it } from "vitest";
import { isVisualShellEnabled } from "./visualShellConfig";

describe("V2 visual shell rollout gate", () => {
  it("is opt-in and only accepts the explicit true value", () => {
    expect(isVisualShellEnabled(undefined)).toBe(false);
    expect(isVisualShellEnabled("false")).toBe(false);
    expect(isVisualShellEnabled("1")).toBe(false);
    expect(isVisualShellEnabled(true)).toBe(false);
    expect(isVisualShellEnabled("true")).toBe(true);
  });
});
