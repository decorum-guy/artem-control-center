import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import {
  actionConfirmationCatalog,
  type ActionConfirmationId,
  type ActionConfirmationSpec
} from "./actionConfirmationCatalog";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";

export interface ActionConfirmationResult {
  confirmed: boolean;
  confirmation?: string;
}

interface ActionConfirmationOptions {
  revision?: string;
  target?: string;
}

interface PendingConfirmation {
  spec: ActionConfirmationSpec;
  revision?: string;
  target?: string;
  resolve: (result: ActionConfirmationResult) => void;
}

interface ActionConfirmationContextValue {
  confirmAction: (
    actionId: ActionConfirmationId,
    options?: ActionConfirmationOptions
  ) => Promise<ActionConfirmationResult>;
  confirmationOpen: boolean;
}

const ActionConfirmationContext = createContext<ActionConfirmationContextValue | null>(null);

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export function ActionConfirmationProvider({ children }: { children: ReactNode }) {
  const { status, refresh } = useAccess();
  const { locked, guardMutation } = useInteractionLock();
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [phrase, setPhrase] = useState("");
  const [settling, setSettling] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const activeRef = useRef(false);
  const settlingRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const confirmAction = useCallback(async (
    actionId: ActionConfirmationId,
    options: ActionConfirmationOptions = {}
  ): Promise<ActionConfirmationResult> => {
    if (!guardMutation()) return Promise.resolve({ confirmed: false });
    if (activeRef.current) return { confirmed: false };
    const spec = actionConfirmationCatalog[actionId];
    if (!spec) return { confirmed: false };

    activeRef.current = true;
    const currentStatus = status ?? await refresh();
    if (!guardMutation()) {
      activeRef.current = false;
      return { confirmed: false };
    }

    // Only the server-owned policy can waive the ceremony. Missing metadata
    // fails closed so old fixtures cannot accidentally broaden access.
    if (currentStatus?.confirmationPolicy?.actionConfirmationRequired === false) {
      activeRef.current = false;
      return { confirmed: true };
    }

    settlingRef.current = false;
    setPhrase("");
    setSettling(false);
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    return new Promise<ActionConfirmationResult>((resolve) => {
      const next = { spec, revision: options.revision, target: options.target, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, [guardMutation, refresh, status]);

  const finish = useCallback((result: ActionConfirmationResult) => {
    if (!pending || settlingRef.current) return;
    settlingRef.current = true;
    setSettling(true);
    const resolve = pending.resolve;
    activeRef.current = false;
    pendingRef.current = null;
    setPending(null);
    setPhrase("");
    setSettling(false);
    resolve(result);
    window.requestAnimationFrame(() => previouslyFocusedRef.current?.focus());
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [pending]);

  useEffect(() => {
    if (!locked || !pendingRef.current) return;
    const current = pendingRef.current;
    pendingRef.current = null;
    activeRef.current = false;
    setPending(null);
    setPhrase("");
    setSettling(false);
    current.resolve({ confirmed: false });
  }, [locked]);

  useEffect(() => () => {
    pendingRef.current?.resolve({ confirmed: false });
    pendingRef.current = null;
    activeRef.current = false;
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!pending || settling) return;
    if (event.key === "Escape") {
      event.preventDefault();
      finish({ confirmed: false });
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusables = focusableElements(dialogRef.current);
    if (!focusables.length) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const atDialogBoundary = active === dialogRef.current || !dialogRef.current.contains(active);
    if (event.shiftKey && (active === first || atDialogBoundary)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || atDialogBoundary)) {
      event.preventDefault();
      first.focus();
    }
  }

  const value = useMemo<ActionConfirmationContextValue>(() => ({
    confirmAction,
    confirmationOpen: Boolean(pending)
  }), [confirmAction, pending]);

  const phraseRequired = pending?.spec.level === "strong" ? pending.spec.requiredPhrase : undefined;
  const phraseMatches = phraseRequired ? phrase === phraseRequired : true;

  return (
    <ActionConfirmationContext.Provider value={value}>
      {children}
      {pending && !locked && (
        <div
          className={`action-confirmation-backdrop action-confirmation-backdrop--${pending.spec.tone}`}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !settling) finish({ confirmed: false });
          }}
        >
          <section
            ref={dialogRef}
            className={`action-confirmation action-confirmation--${pending.spec.tone}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="action-confirmation-title"
            aria-describedby="action-confirmation-description"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            data-testid="action-confirmation"
          >
            <div className="action-confirmation__header">
              <div>
                <p className="action-confirmation__kicker">
                  {pending.spec.tone === "production" ? "Критическое действие" : "Подтверждение действия"}
                </p>
                <h2 id="action-confirmation-title">{pending.spec.title}</h2>
              </div>
              <span className="action-confirmation__environment">{pending.spec.environment}</span>
            </div>

            <div className="action-confirmation__target">
              <span>Цель</span>
              <strong>{pending.target ?? pending.spec.target}</strong>
            </div>

            {pending.revision && (
              <div className="action-confirmation__revision">
                <span>Текущая revision</span>
                <code>{pending.revision}</code>
              </div>
            )}

            <p id="action-confirmation-description" className="action-confirmation__description">
              {pending.spec.description}
            </p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!phraseMatches || settling) return;
                finish({
                  confirmed: true,
                  ...(phraseRequired ? { confirmation: phrase } : {})
                });
              }}
            >
              {phraseRequired && (
                <label className="action-confirmation__phrase">
                  <span>Введите фразу подтверждения</span>
                  <strong>{phraseRequired}</strong>
                  <input
                    type="text"
                    value={phrase}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    disabled={settling}
                    aria-describedby="action-confirmation-phrase-hint"
                    onChange={(event) => setPhrase(event.target.value)}
                  />
                  <small id="action-confirmation-phrase-hint">
                    Фраза должна совпасть полностью, включая регистр и пробел.
                  </small>
                </label>
              )}

              <div className="action-confirmation__actions">
                <button
                  type="button"
                  className="action-confirmation__cancel"
                  disabled={settling}
                  onClick={() => finish({ confirmed: false })}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="action-confirmation__confirm"
                  disabled={settling || !phraseMatches}
                >
                  {settling ? "Подтверждаем…" : pending.spec.confirmLabel}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </ActionConfirmationContext.Provider>
  );
}

export function useActionConfirmation() {
  const value = useContext(ActionConfirmationContext);
  if (!value) throw new Error("useActionConfirmation must be used inside ActionConfirmationProvider");
  return value;
}
