import { describe, expect, it } from "vitest";
import type { CoffeeData } from "@artem/contracts";
import { coffeePresentation, coffeeProgressColor, coffeeProgressTone } from "./coffee";

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
    source: "home-assistant",
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

  it("changes the semantic progress color across early, middle, late, and ready bands", () => {
    const samples = [
      [0.1, "cool-blue"],
      [0.5, "transition-teal"],
      [0.9, "ready-green"],
      [1, "ready-green"]
    ] as const;
    const colors = samples.map(([progress, tone]) => {
      expect(coffeeProgressTone(progress)).toBe(tone);
      return coffeeProgressColor(progress);
    });
    expect(new Set(colors).size).toBe(4);
    expect(colors[0]).toContain("79 146 192");
    expect(colors[2]).toContain("93 167 132");
    expect(colors[3]).toBe("rgb(95 170 125)");
  });

  it("keeps the canonical lifecycle truthful for pending, warming, ready, and unavailable states", () => {
    const timed = {
      ...base,
      timingPolicy: {
        ...base.timingPolicy,
        warmupDurationSeconds: 1000,
        longRunningThresholdSeconds: 3600,
        sourceAvailable: true
      }
    };
    expect(coffeePresentation({ ...timed, machine: { ...timed.machine, state: "off" } }, "2026-07-29T12:00:00Z").stage).toBe("off");
    expect(coffeePresentation({ ...timed, machine: { ...timed.machine, state: "turning_on" } }, "2026-07-29T12:00:00Z").stage).toBe("turning_on");
    expect(coffeePresentation(timed, "2026-07-29T12:08:00Z").stage).toBe("warming");
    expect(coffeePresentation(timed, "2026-07-29T12:15:00Z").stage).toBe("ready");
    expect(coffeePresentation({ ...timed, machine: { ...timed.machine, state: "turning_off" } }, "2026-07-29T12:00:00Z").stage).toBe("turning_off");
    expect(coffeePresentation({ ...timed, machine: { ...timed.machine, state: "unavailable", available: false } }, "2026-07-29T12:08:00Z").progress).toBeNull();
    expect(coffeePresentation({ ...timed, machine: { ...timed.machine, state: "on", stale: true } }, "2026-07-29T12:08:00Z").stage).toBe("stale");
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

  it("advances warming to ready and running-too-long from a presentation clock", () => {
    const timed = {
      ...base,
      machine: {
        ...base.machine,
        turnedOnAt: "2026-07-29T12:00:00Z"
      },
      timingPolicy: {
        ...base.timingPolicy,
        warmupDurationSeconds: 120,
        longRunningThresholdSeconds: 300,
        sourceAvailable: true
      }
    };
    expect(coffeePresentation(timed, "2026-07-29T12:01:00Z").stage).toBe("warming");
    expect(coffeePresentation(timed, "2026-07-29T12:02:00Z").stage).toBe("ready");
    expect(coffeePresentation(timed, "2026-07-29T12:05:00Z").stage)
      .toBe("running_too_long");
  });
});
