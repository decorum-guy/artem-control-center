import { describe, expect, it } from "vitest";
import { syncTimeLabel } from "./PlanningRoutePrimitives";

describe("Planning route freshness presentation", () => {
  it("formats freshness in the canonical Moscow display timezone", () => {
    expect(syncTimeLabel("2026-08-12T09:00:00Z")).toBe("12:00");
  });
});
