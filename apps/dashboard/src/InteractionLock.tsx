/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import {
  advanceHold,
  endHold,
  initialHoldState,
  startHold,
  type HoldState
} from "./interactionLockGesture";
import { interactionLockEnabled, interactionLockStartsLocked } from "./touchInputLockConfig";
import "./InteractionLock.css";

interface InteractionLockContextValue {
  enabled: boolean;
  locked: boolean;
  holding: boolean;
  holdProgress: number;
  holdStartedAt: number | null;
  lock: () => void;
  unlock: () => void;
  guardMutation: () => boolean;
  beginHold: (owner: string) => boolean;
  endHold: (owner: string) => void;
  cancelHold: (owner?: string) => void;
}

const InteractionLockContext = createContext<InteractionLockContextValue | null>(null);

export function InteractionLockProvider({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(interactionLockStartsLocked);
  const [holdState, setHoldState] = useState<HoldState>(initialHoldState);
  const lockedRef = useRef(locked);
  const holdRef = useRef(holdState);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setCurrentHold = useCallback((next: HoldState) => {
    holdRef.current = next;
    setHoldState(next);
  }, []);

  const toggle = useCallback(() => {
    setLocked((current) => {
      lockedRef.current = !current;
      return !current;
    });
  }, []);

  const beginHold = useCallback((owner: string) => {
    if (!interactionLockEnabled || holdRef.current.owner !== null) return false;
    const next = startHold(holdRef.current, owner, performance.now());
    setCurrentHold(next);
    stopTimer();
    timerRef.current = window.setInterval(() => {
      const advanced = advanceHold(holdRef.current, performance.now());
      setCurrentHold(advanced.state);
      if (advanced.toggled) {
        stopTimer();
        toggle();
      }
    }, 40);
    return true;
  }, [setCurrentHold, stopTimer, toggle]);

  const finishHold = useCallback((owner: string) => {
    if (holdRef.current.owner !== owner) return;
    stopTimer();
    setCurrentHold(endHold(holdRef.current, owner));
  }, [setCurrentHold, stopTimer]);

  const cancelHold = useCallback((owner?: string) => {
    const currentOwner = holdRef.current.owner;
    if (currentOwner !== null && (owner === undefined || currentOwner === owner)) {
      finishHold(currentOwner);
    }
  }, [finishHold]);

  useEffect(() => () => {
    stopTimer();
  }, [stopTimer]);

  const lock = useCallback(() => setLocked(true), []);
  const unlock = useCallback(() => setLocked(false), []);
  const guardMutation = useCallback(() => !lockedRef.current, []);

  const value = useMemo<InteractionLockContextValue>(() => ({
    enabled: interactionLockEnabled,
    locked,
    holding: holdState.owner !== null && !holdState.completed,
    holdProgress: holdState.progress,
    holdStartedAt: holdState.holdStartedAt,
    lock,
    unlock,
    guardMutation,
    beginHold,
    endHold: finishHold,
    cancelHold
  }), [beginHold, cancelHold, finishHold, guardMutation, holdState, lock, locked, unlock]);

  return (
    <InteractionLockContext.Provider value={value}>
      {children}
      {interactionLockEnabled && locked && (
        <div className="interaction-lock-overlay" aria-hidden="true" data-testid="interaction-lock-overlay" />
      )}
    </InteractionLockContext.Provider>
  );
}

export function useInteractionLock() {
  const value = useContext(InteractionLockContext);
  if (!value) throw new Error("useInteractionLock must be used inside InteractionLockProvider");
  return value;
}

function holdProgressCopy(progress: number): string {
  if (progress >= 1) return "Готово";
  if (progress >= 0.5) return "Почти готово…";
  return "Удерживайте…";
}

export function InteractionLockControl() {
  const {
    locked,
    holding,
    holdProgress,
    beginHold,
    endHold,
    cancelHold
  } = useInteractionLock();
  const [announcement, setAnnouncement] = useState(locked ? "Панель заблокирована" : "Панель разблокирована");
  const [reducedMotion, setReducedMotion] = useState(false);
  const previousLocked = useRef(locked);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (previousLocked.current !== locked) {
      previousLocked.current = locked;
      setAnnouncement(locked ? "Панель заблокирована" : "Панель разблокирована");
    }
  }, [locked]);

  if (!interactionLockEnabled) return null;

  const ownerForPointer = (pointerId: number) => `pointer:${pointerId}`;
  const ownerForKey = (key: string) => `keyboard:${key}`;

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary) return;
    event.preventDefault();
    const owner = ownerForPointer(event.pointerId);
    if (!beginHold(owner)) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      cancelHold(owner);
    }
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    endHold(ownerForPointer(event.pointerId));
  }

  function onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
    cancelHold(ownerForPointer(event.pointerId));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) beginHold(ownerForKey(event.key));
  }

  function onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    endHold(ownerForKey(event.key));
  }

  const label = locked ? "Удерживайте, чтобы разблокировать панель" : "Удерживайте, чтобы заблокировать панель";
  return (
    <div
      className={`interaction-lock-control${holding ? " interaction-lock-control--holding" : ""}${locked ? " interaction-lock-control--locked" : ""}`}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <button
        type="button"
        className="interaction-lock-button"
        aria-label={label}
        aria-pressed={locked}
        data-reduced-motion={reducedMotion ? "true" : "false"}
        data-testid="interaction-lock-control"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => cancelHold()}
        onClick={(event) => event.preventDefault()}
      >
        <span className="interaction-lock-icon" aria-hidden="true">{locked ? "🔒" : "🔓"}</span>
        {holding && (
          <span
            className="interaction-lock-progress"
            role="progressbar"
            aria-label={holdProgressCopy(holdProgress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(holdProgress * 100)}
          >
            <span data-testid="interaction-lock-progress-fill" style={{ transform: `scaleX(${holdProgress})` }} />
          </span>
        )}
      </button>
      {holding && <span className="interaction-lock-hint" aria-live="polite">{holdProgressCopy(holdProgress)}</span>}
      <span className="interaction-lock-sr-status" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}

export function InteractionLockStatus() {
  const { locked } = useInteractionLock();
  if (!interactionLockEnabled || !locked) return null;
  return <span className="interaction-lock-status" role="status" data-testid="interaction-lock-status">Панель заблокирована</span>;
}
