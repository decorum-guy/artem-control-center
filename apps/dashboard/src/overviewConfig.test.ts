import { describe, expect, it } from "vitest";
import { isOverviewV2Enabled } from "./overviewConfig";

describe("Overview V2 rollout gate", () => {
  it("is opt-in and accepts only the explicit true value", () => {
    expect(isOverviewV2Enabled(undefined)).toBe(false);
    expect(isOverviewV2Enabled("false")).toBe(false);
    expect(isOverviewV2Enabled("1")).toBe(false);
    expect(isOverviewV2Enabled(true)).toBe(false);
    expect(isOverviewV2Enabled("true")).toBe(true);
  });
});
