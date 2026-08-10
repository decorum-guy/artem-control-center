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

interface PinKeyDefinition {
  key: PinKey;
  label: string;
  ariaLabel: string;
  utility?: boolean;
}

const AccessContext = createContext<AccessContextValue | null>(null);

const availabilityCopy: Record<string, string> = {
  allowed: "Действие доступно",
  elevation_required: "Требуется временный полный доступ",
  profile_blocked: "Недоступно в текущем профиле",
  pin_not_configured: "Сначала настройте PIN на Samsung",
  gate_disabled: "Операция отключена серверной политикой",
  integration_unavailable: "Исполнитель интеграции не настроен",
  busy: "Другая операция уже выполняется",
  cooldown: "Повторный запуск временно ограничен",
  precondition_failed: "Предварительная проверка не пройдена"
};

const pinKeys: PinKeyDefinition[] = [
  { key: "1", label: "1", ariaLabel: "1" },
  { key: "2", label: "2", ariaLabel: "2" },
  { key: "3", label: "3", ariaLabel: "3" },
  { key: "4", label: "4", ariaLabel: "4" },
  { key: "5", label: "5", ariaLabel: "5" },
  { key: "6", label: "6", ariaLabel: "6" },
  { key: "7", label: "7", ariaLabel: "7" },
  { key: "8", label: "8", ariaLabel: "8" },
  { key: "9", label: "9", ariaLabel: "9" },
  { key: "backspace", label: "←", ariaLabel: "Удалить последнюю цифру", utility: true },
  { key: "0", label: "0", ariaLabel: "0" },
  { key: "clear", label: "C", ariaLabel: "Очистить PIN", utility: true }
];

function pinErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : "invalid_pin";
  if (code === "pin_rate_limited") return "Слишком много попыток. Повторите через несколько минут.";
  if (code === "pin_not_configured") return "PIN ещё не настроен на Samsung.";
  return "Неверный PIN.";
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [prompt, setPrompt] = useState<PinPrompt | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
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
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!prompt) return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [prompt]);

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
    const current = status ?? await refresh();
    if (!current) return true; // Fixture/dev runtime has no production access API.
    const decision = current.capabilities[capability];
    if (!decision || decision.allowed) return true;
    if (decision.availability !== "elevation_required") return false;

    return requestPin(
      title,
      "Полный доступ включится на 30 минут и будет действовать для следующих защищённых операций.",
      async (entered) => {
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
  }, [refresh, status]);

  const changeProfile = useCallback(async (profile: AccessProfile) => {
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
        try {
          setStatus(await setAccessProfile(profile, entered));
          return true;
        } catch (error) {
          setPinError(pinErrorCopy(error));
          return false;
        }
      }
    );
  }, []);

  const clearTemporary = useCallback(async () => {
    setStatus(await clearTemporaryFull());
  }, []);

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

  const remainingSeconds = status?.temporaryFullExpiresAt
    ? Math.max(0, Math.ceil((Date.parse(status.temporaryFullExpiresAt) - clock) / 1000))
    : 0;
  const remainingMinutes = Math.floor(remainingSeconds / 60);
  const remainingRemainder = remainingSeconds % 60;
  const pinValid = isValidPin(pin);
  const maskedPin = pin.length > 0 ? Array.from({ length: pin.length }, () => "●").join(" ") : "○ ○ ○ ○";

  return (
    <AccessContext.Provider value={value}>
      {children}
      {status?.temporaryFull && remainingSeconds > 0 && (
        <aside className="temporary-access-badge" role="status">
          <span>Полный доступ</span>
          <strong>{remainingMinutes}:{String(remainingRemainder).padStart(2, "0")}</strong>
          <button type="button" onClick={() => void clearTemporary()}>Завершить</button>
        </aside>
      )}
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

              <div className="pin-keypad" aria-label="Цифровая клавиатура PIN">
                {pinKeys.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={item.utility ? "pin-key pin-key--utility" : "pin-key"}
                    aria-label={item.ariaLabel}
                    disabled={pinBusy || (item.key === "backspace" && pin.length === 0) || (item.key === "clear" && pin.length === 0)}
                    onClick={() => updatePin(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

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

const profileCopy: Record<AccessProfile, { title: string; description: string }> = {
  read_only: {
    title: "Только чтение",
    description: "Показывает данные, но блокирует управление устройствами и инфраструктурой."
  },
  standard: {
    title: "Обычный доступ",
    description: "Повседневные действия доступны; restart, deploy и restore требуют PIN."
  },
  full: {
    title: "Полный доступ",
    description: "Все отдельно включённые серверные операции доступны без таймера до ручного отключения."
  }
};

export function AccessSettingsPanel() {
  const { status, available, changeProfile } = useAccess();

  return (
    <section className="settings-section access-settings" aria-labelledby="access-settings-title">
      <div className="access-settings-copy">
        <h2 id="access-settings-title">Уровень доступа</h2>
        <p>Профиль проверяется Panel Agent, поэтому скрытие кнопки или прямой HTTP-запрос не обходят защиту.</p>
        {!available && <span className="runtime-controls-status">Access API пока недоступен.</span>}
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
        <p className="access-warning">PIN ещё не настроен локальным helper-скриптом на Samsung.</p>
      )}
    </section>
  );
}
