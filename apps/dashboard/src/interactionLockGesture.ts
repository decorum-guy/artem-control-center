export const HOLD_DURATION_MS = 1_000;

export interface HoldState {
  owner: string | null;
  holdStartedAt: number | null;
  progress: number;
  completed: boolean;
}

export const initialHoldState: HoldState = {
  owner: null,
  holdStartedAt: null,
  progress: 0,
  completed: false
};

export function startHold(state: HoldState, owner: string, now: number): HoldState {
  if (state.owner !== null) return state;
  return { owner, holdStartedAt: now, progress: 0, completed: false };
}

export function advanceHold(
  state: HoldState,
  now: number
): { state: HoldState; toggled: boolean } {
  if (state.owner === null || state.holdStartedAt === null || state.completed) {
    return { state, toggled: false };
  }
  const progress = Math.min(1, Math.max(0, (now - state.holdStartedAt) / HOLD_DURATION_MS));
  if (progress >= 1) {
    return { state: { ...state, progress: 1, completed: true }, toggled: true };
  }
  return { state: { ...state, progress }, toggled: false };
}

export function endHold(state: HoldState, owner: string): HoldState {
  if (state.owner !== owner) return state;
  return initialHoldState;
}
