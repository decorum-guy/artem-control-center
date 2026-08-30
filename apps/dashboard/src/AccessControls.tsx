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
  clearTemporaryFull,
  fetchAccessStatus,
  setAccessProfile,
  unlockTemporaryFull,
  type AccessProfile,
  type AccessStatus
} from "./accessApi";
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  applyPinKey,
  isValidPin,
  type PinKey
} from "./pinKeypad";
import { NumericKeypadButtons } from "./NumericKeypad";
import { useInteractionLock } from "./InteractionLock";
import "./AccessControls.css";

interface PinPrompt {
  title: string;
  description: string;
  validate: (pin: string) => Promise<boolean>;
}

interface AccessContextValue {
  status: AccessStatus | null;
  available: boolean;
  refresh: () => Promise<AccessStatus | null>;
  ensureCapability: (capability: string, title: string) => Promise<boolean>;
  changeProfile: (profile: AccessProfile) => Promise<boolean>;
  clearTemporary: () => Promise<void>;
  explainAvailability: (availability: string) => string;
}

const AccessContext = createContext<AccessContextValue | null>(null);

const availabilityCopy: Record<string, string> = {
  allowed: "Действие доступно",
  elevation_required: "Требуется временный полный доступ",
  profile_blocked: "Недоступно в текущем профиле",
  pin_not_configured: "Сначала настройте PIN на Samsung",
  gate_disabled: "Операция отключена",
  integration_unavailable: "Сервис недоступен",
  busy: "Другая операция уже выполняется",
  cooldown: "Повторный запуск временно ограничен",
  precondition_failed: "Предварительная проверка не пройдена"
};

function pinErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : "invalid_pin";
  if (code === "pin_rate_limited") return "Слишком много попыток. Повторите через несколько минут.";
  if (code === "pin_not_configured") return "PIN ещё не настроен на Samsung.";
  return "Неверный PIN.";
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const { locked, guardMutation } = useInteractionLock();
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [prompt, setPrompt] = useState<PinPrompt | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const resolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchAccessStatus();
      setStatus(next);
      setAvailable(true);
      return next;
    } catch {
      setAvailable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!prompt) return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [prompt]);

  useEffect(() => {
    if (locked && prompt) closePrompt(false);
  }, [locked, prompt]);

  function requestPin(
    title: string,
    description: string,
    validate: (pin: string) => Promise<boolean>
  ): Promise<boolean> {
    resolverRef.current?.(false);
    setPin("");
    setPinError(null);
    setPinBusy(false);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setPrompt({ title, description, validate });
    });
  }

  function closePrompt(accepted: boolean) {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    setPin("");
    setPinError(null);
    setPinBusy(false);
    resolve?.(accepted);
  }

  function updatePin(key: PinKey) {
    if (pinBusy) return;
    setPin((current) => applyPinKey(current, key));
    setPinError(null);
  }

  async function submitPin() {
    if (!prompt || pinBusy) return;
    if (!isValidPin(pin)) {
      setPinError(`PIN должен содержать от ${PIN_MIN_LENGTH} до ${PIN_MAX_LENGTH} цифр.`);
      return;
    }

    setPinBusy(true);
    setPinError(null);
    try {
      const accepted = await prompt.validate(pin);
      if (accepted) {
        closePrompt(true);
        return;
      }
      setPin("");
      setPinBusy(false);
      window.requestAnimationFrame(() => dialogRef.current?.focus());
    } catch (error) {
      setPinError(pinErrorCopy(error));
      setPin("");
      setPinBusy(false);
      window.requestAnimationFrame(() => dialogRef.current?.focus());
    }
  }

  function handlePinKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!prompt || pinBusy) return;

    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      updatePin(event.key as PinKey);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      updatePin("backspace");
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      updatePin("clear");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePrompt(false);
      return;
    }
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void submitPin();
    }
  }

  const ensureCapability = useCallback(async (capability: string, title: string) => {
    if (!guardMutation()) return false;
    const current = status ?? await refresh();
    if (!current) return true; // Fixture/dev runtime has no production access API.
    const decision = current.capabilities[capability];
    if (!decision || decision.allowed) return true;
    if (decision.availability !== "elevation_required") return false;

    return requestPin(
      title,
      "Полный доступ включится на 30 минут и будет действовать для следующих защищённых операций.",
      async (entered) => {
        if (!guardMutation()) return false;
        try {
          const next = await unlockTemporaryFull(entered);
          setStatus(next);
          return Boolean(next.capabilities[capability]?.allowed);
        } catch (error) {
          setPinError(pinErrorCopy(error));
          return false;
        }
      }
    );
  }, [guardMutation, refresh, status]);

  const changeProfile = useCallback(async (profile: AccessProfile) => {
    if (!guardMutation()) return false;
    if (profile !== "full") {
      try {
        setStatus(await setAccessProfile(profile));
        return true;
      } catch {
        return false;
      }
    }

    return requestPin(
      "Включить полный доступ",
      "Ручной полный доступ не имеет таймера и сохранится после перезапуска, пока вы не смените профиль.",
      async (entered) => {
        if (!guardMutation()) return false;
        try {
          setStatus(await setAccessProfile(profile, entered));
          return true;
        } catch (error) {
          setPinError(pinErrorCopy(error));
          return false;
        }
      }
    );
  }, [guardMutation]);

  const clearTemporary = useCallback(async () => {
    if (!guardMutation()) return;
    setStatus(await clearTemporaryFull());
  }, [guardMutation]);

  const explainAvailability = useCallback(
    (availability: string) => availabilityCopy[availability] ?? "Операция сейчас недоступна",
    []
  );

  const value = useMemo<AccessContextValue>(() => ({
    status,
    available,
    refresh,
    ensureCapability,
    changeProfile,
    clearTemporary,
    explainAvailability
  }), [
    status,
    available,
    refresh,
    ensureCapability,
    changeProfile,
    clearTemporary,
    explainAvailability
  ]);

  const pinValid = isValidPin(pin);
  const maskedPin = pin.length > 0 ? Array.from({ length: pin.length }, () => "●").join(" ") : "○ ○ ○ ○";

  return (
    <AccessContext.Provider value={value}>
      {children}
      {prompt && (
        <div
          className="pin-modal-backdrop"
          role="presentation"
          onPointerDown={() => !pinBusy && closePrompt(false)}
        >
          <section
            ref={dialogRef}
            className="pin-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pin-modal-title"
            aria-describedby="pin-modal-description"
            tabIndex={-1}
            onKeyDown={handlePinKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <p className="section-kicker">Защищённая операция</p>
            <h2 id="pin-modal-title">{prompt.title}</h2>
            <p id="pin-modal-description">{prompt.description}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitPin();
              }}
            >
              <div className="pin-entry" aria-labelledby="pin-entry-label">
                <span id="pin-entry-label" className="pin-entry-label">PIN</span>
                <div
                  className={`pin-display${pin.length === 0 ? " pin-display--empty" : ""}`}
                  role="status"
                  aria-live="polite"
                  aria-label={pin.length > 0 ? `Введено цифр: ${pin.length}` : "PIN не введён"}
                >
                  <span className="pin-dots" aria-hidden="true">{maskedPin}</span>
                  <span className="pin-length" aria-hidden="true">{pin.length}/{PIN_MAX_LENGTH}</span>
                </div>
              </div>

              <NumericKeypadButtons
                decimal={false}
                clearLabel="C"
                clearAriaLabel="Очистить PIN"
                backspaceAriaLabel="Удалить последнюю цифру"
                digitAriaLabel={(key) => key}
                className="pin-keypad"
                ariaLabel="Цифровая клавиатура PIN"
                buttonClassName="pin-key"
                utilityButtonClassName="pin-key pin-key--utility"
                isKeyDisabled={(key) => pinBusy || (key === "backspace" && pin.length === 0) || (key === "clear" && pin.length === 0)}
                onKey={(key) => {
                  if (key !== "." && key !== ",") updatePin(key);
                }}
              />

              {pinError && <span className="pin-error" role="alert">{pinError}</span>}
              <div className="pin-modal-actions">
                <button type="button" disabled={pinBusy} onClick={() => closePrompt(false)}>Отмена</button>
                <button type="submit" className="primary-action" disabled={pinBusy || !pinValid}>
                  {pinBusy ? "Проверяем…" : "Разблокировать"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </AccessContext.Provider>
  );
}

export function useAccess() {
  const value = useContext(AccessContext);
  if (!value) throw new Error("useAccess must be used inside AccessProvider");
  return value;
}

export function TemporaryAccessIndicator() {
  const { status, clearTemporary } = useAccess();
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingSeconds = status?.temporaryFullExpiresAt
    ? Math.max(0, Math.ceil((Date.parse(status.temporaryFullExpiresAt) - clock) / 1000))
    : 0;
  if (!status?.temporaryFull || remainingSeconds <= 0) return null;

  const remainingMinutes = Math.floor(remainingSeconds / 60);
  const remainingRemainder = remainingSeconds % 60;
  return (
    <div className="temporary-access-chip" role="status" data-testid="temporary-access-indicator">
      <span>Полный доступ</span>
      <strong>{remainingMinutes}:{String(remainingRemainder).padStart(2, "0")}</strong>
      <button type="button" onClick={() => void clearTemporary()}>Завершить</button>
    </div>
  );
}

const profileCopy: Record<AccessProfile, { title: string; description: string }> = {
  read_only: {
    title: "Только чтение",
    description: "Показывает данные, но блокирует управление устройствами и инфраструктурой."
  },
  standard: {
    title: "Обычный доступ",
    description: "Повседневные действия доступны; чувствительные операции требуют PIN."
  },
  full: {
    title: "Полный доступ",
    description: "Все разрешённые операции доступны без таймера до ручного отключения."
  }
};

export function AccessSettingsPanel() {
  const { status, available, changeProfile } = useAccess();

  return (
    <section className="settings-section access-settings" aria-labelledby="access-settings-title">
      <div className="access-settings-copy">
        <h2 id="access-settings-title">Уровень доступа</h2>
        <p>Профиль защищает операции, даже если кнопка скрыта или недоступна.</p>
        {!available && <span className="runtime-controls-status">Состояние доступа недоступно.</span>}
        {status && (
          <span className="access-current-state">
            Сейчас: {profileCopy[status.effectiveProfile].title}
            {status.temporaryFull ? " · временно" : ""}
          </span>
        )}
      </div>
      <div className="access-profile-grid" role="radiogroup" aria-label="Уровень доступа">
        {(Object.keys(profileCopy) as AccessProfile[]).map((profile) => (
          <button
            key={profile}
            type="button"
            role="radio"
            aria-checked={status?.baseProfile === profile}
            className={status?.baseProfile === profile ? "access-profile--active" : ""}
            disabled={!available || !status}
            onClick={() => void changeProfile(profile)}
          >
            <strong>{profileCopy[profile].title}</strong>
            <span>{profileCopy[profile].description}</span>
          </button>
        ))}
      </div>
      {status && !status.pinConfigured && (
        <p className="access-warning">PIN ещё не настроен на Samsung.</p>
      )}
    </section>
  );
}
