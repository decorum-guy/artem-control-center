import { describe, expect, it } from "vitest";
import {
  advanceHold,
  endHold,
  HOLD_DURATION_MS,
  initialHoldState,
  startHold
} from "./interactionLockGesture";

describe("interaction lock hold gesture", () => {
  it("cancels a short pointer tap and a 999ms hold", () => {
    let state = startHold(initialHoldState, "pointer:1", 10_000);
    expect(advanceHold(state, 10_999).toggled).toBe(false);
    state = endHold(state, "pointer:1");
    expect(state).toEqual(initialHoldState);
  });

  it("toggles exactly once at the 1000ms threshold", () => {
    const state = startHold(initialHoldState, "pointer:1", 10_000);
    const completed = advanceHold(state, 10_000 + HOLD_DURATION_MS);
    expect(completed.toggled).toBe(true);
    expect(advanceHold(completed.state, 12_000).toggled).toBe(false);
    expect(endHold(completed.state, "pointer:1")).toEqual(initialHoldState);
  });

  it("requires the same owner and rejects a second pointer", () => {
    const first = startHold(initialHoldState, "pointer:1", 10_000);
    expect(startHold(first, "pointer:2", 10_010)).toEqual(first);
    expect(endHold(first, "pointer:2")).toEqual(first);
    expect(endHold(first, "pointer:1")).toEqual(initialHoldState);
  });

  it("uses the same deliberate gesture for keyboard holds", () => {
    const keyboard = startHold(initialHoldState, "keyboard: ", 10_000);
    expect(advanceHold(keyboard, 10_500).state.progress).toBeCloseTo(0.5);
    expect(advanceHold(keyboard, 11_000).toggled).toBe(true);
  });
});
