import { describe, expect, it } from "vitest";
import type { CoffeeData } from "@artem/contracts";
import { coffeePresentation } from "./coffee";

const base: CoffeeData = {
  machine: {
    state: "on",
    entityId: "switch.kofemashina",
    authority: "home-assistant",
    available: true,
    turnedOnAt: "2026-07-29T11:54:09Z",
    entityLastChangedAt: "2026-07-29T11:54:09Z",
    observedAt: "2026-07-29T12:00:00Z",
    stale: false
  },
  timingPolicy: {
    source: "alice-tg-bot",
    warmupDurationSeconds: null,
    longRunningThresholdSeconds: null,
    fetchedAt: null,
    stale: false,
    sourceAvailable: false,
    sourceRevision: null
  }
};

describe("coffee presentation", () => {
  it("does not invent progress when HA timing is absent", () => {
    const view = coffeePresentation(base, "2026-07-29T12:00:00Z");
    expect(view.progressText).toBeNull();
    expect(view.runningSeconds).toBe(351);
  });

  it("derives progress from current policy without frontend constants", () => {
    const thirteenMinutes = {
      ...base,
      timingPolicy: {
        ...base.timingPolicy,
        warmupDurationSeconds: 780,
        longRunningThresholdSeconds: 3600,
        sourceAvailable: true
      }
    };
    const twentyMinutes = {
      ...thirteenMinutes,
      timingPolicy: { ...thirteenMinutes.timingPolicy, warmupDurationSeconds: 1200 }
    };
    expect(coffeePresentation(thirteenMinutes, "2026-07-29T12:00:00Z").progressText)
      .toBe("45%");
    expect(coffeePresentation(twentyMinutes, "2026-07-29T12:00:00Z").progressText)
      .toBe("29%");
  });

  it("uses policy long-running threshold without calling it physical overheating", () => {
    const view = coffeePresentation({
      ...base,
      timingPolicy: {
        ...base.timingPolicy,
        warmupDurationSeconds: 300,
        longRunningThresholdSeconds: 300,
        sourceAvailable: true
      }
    }, "2026-07-29T12:00:00Z");
    expect(view.stage).toBe("running_too_long");
    expect(view.label).toBe("Работает слишком долго");
    expect(view.label.toLowerCase()).not.toContain("перегрев");
  });

  it("never lets bot timing override unavailable HA state", () => {
    const view = coffeePresentation({
      ...base,
      machine: { ...base.machine, state: "unavailable", available: false },
      timingPolicy: {
        ...base.timingPolicy,
        warmupDurationSeconds: 780,
        longRunningThresholdSeconds: 3600,
        sourceAvailable: true
      }
    }, "2026-07-29T12:00:00Z");
    expect(view.stage).toBe("unavailable");
    expect(view.progress).toBeNull();
  });
});
