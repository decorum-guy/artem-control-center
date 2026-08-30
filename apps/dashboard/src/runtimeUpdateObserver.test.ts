import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observePanelUpdate,
  updateActivityCopy,
  updateProgressPercent,
  type UpdateOwnerState,
  type UpdateObserverEvent
} from "./runtimeUpdateObserver";

const CURRENT = "a".repeat(40);
const TARGET = "b".repeat(40);

function updating(): UpdateOwnerState {
  return {
    schemaVersion: 1,
    status: "updating",
    currentHead: CURRENT,
    targetHead: TARGET,
    phase: "building"
  };
}

function success(): UpdateOwnerState {
  return {
    ...updating(),
    status: "success",
    result: "updated",
    phase: "verifying",
    servedRevision: TARGET
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("server-owned panel update observer", () => {
  it("uses bounded server progress and fixed activity copy", () => {
    expect(updateProgressPercent({ schemaVersion: 1, status: "updating", phase: "building", progressPercent: 66 })).toBe(66);
    expect(updateProgressPercent({ schemaVersion: 1, status: "updating", phase: "building", progressPercent: 101 })).toBe(66);
    expect(updateProgressPercent({ schemaVersion: 1, status: "updating", phase: "rollback" })).toBe(60);
    expect(updateActivityCopy("building")).toBe("Собираем панель");
    expect(updateActivityCopy("C:\\private\\repo")).toBeNull();
    expect(updateActivityCopy("constructor")).toBeNull();
  });

  it("keeps an active update alive beyond the old 60-second browser window", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    let statusCalls = 0;
    const stop = observePanelUpdate({
      fetchStatus: async () => {
        statusCalls += 1;
        return updating();
      },
      fetchBuild: async () => ({
        schemaVersion: "dashboard-build.v1",
        revision: TARGET,
        profile: "accepted-v2",
        buildId: `${TARGET}:accepted-v2`
      }),
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250 + (750 * 81));

    expect(statusCalls).toBeGreaterThan(80);
    expect(events.every((event) => event.type === "active")).toBe(true);
    expect(events.some((event) => event.type === "failure")).toBe(false);
    stop();
  });

  it("enters reconnecting on a temporary runtime disappearance and succeeds after the target returns", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    let statusCalls = 0;
    const stop = observePanelUpdate({
      fetchStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("runtime disappeared");
        if (statusCalls === 2) return updating();
        return success();
      },
      fetchBuild: async () => ({
        schemaVersion: "dashboard-build.v1",
        revision: TARGET,
        profile: "accepted-v2",
        buildId: `${TARGET}:accepted-v2`
      }),
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250 + 750 + 750);

    expect(events.map((event) => event.type)).toEqual(["reconnecting", "active", "success"]);
    stop();
  });

  it("does not claim success when the returned runtime serves the wrong revision", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    const stop = observePanelUpdate({
      fetchStatus: async () => success(),
      fetchBuild: async () => ({
        schemaVersion: "dashboard-build.v1",
        revision: CURRENT,
        profile: "accepted-v2",
        buildId: `${CURRENT}:accepted-v2`
      }),
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([{ type: "failure", state: success(), reason: "served_mismatch" }]);
    stop();
  });

  it("does not claim an updated terminal result without a target revision", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    const state: UpdateOwnerState = {
      schemaVersion: 1,
      status: "success",
      result: "updated"
    };
    const stop = observePanelUpdate({
      fetchStatus: async () => state,
      fetchBuild: async () => {
        throw new Error("must not infer the missing target");
      },
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([{ type: "failure", state, reason: "served_unverified" }]);
    stop();
  });

  it("returns a neutral idle event and terminates the active observer", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    let statusCalls = 0;
    const state: UpdateOwnerState = { schemaVersion: 1, status: "idle" };
    const stop = observePanelUpdate({
      fetchStatus: async () => {
        statusCalls += 1;
        return state;
      },
      fetchBuild: async () => {
        throw new Error("must not verify an idle state");
      },
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([{ type: "idle", state }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusCalls).toBe(1);
    stop();
  });

  it("keeps an authoritative terminal failure visible", async () => {
    vi.useFakeTimers();
    const events: UpdateObserverEvent[] = [];
    const failed: UpdateOwnerState = {
      ...updating(),
      status: "failed",
      result: "rollback_restored"
    };
    const stop = observePanelUpdate({
      fetchStatus: async () => failed,
      fetchBuild: async () => {
        throw new Error("must not verify a failed update");
      },
      onEvent: (event) => events.push(event)
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([{ type: "failure", state: failed, reason: "authoritative" }]);
    stop();
  });
});
