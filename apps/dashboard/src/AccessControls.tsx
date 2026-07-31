import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import "./AccessControls.css";

interface PinPrompt {
  title: string;
  description: string;
  resolve: (pin: string | null) => void;
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
  gate_disabled: "Операция отключена серверной политикой",
  integration_unavailable: "Исполнитель интеграции не настроен",
  busy: "Другая операция уже выполняется",
  cooldown: "Повторный запуск временно ограничен",
  precondition_failed: "Предварительная проверка не пройдена"
};

export function AccessProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [prompt, setPrompt] = useState<PinPrompt | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const resolverRef = useRef<((pin: string | null) => void) | null>(null);

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

  function requestPin(title: string, description: string): Promise<string | null> {
    if (resolverRef.current) resolverRef.current(null);
    setPin("");
    setPinError(null);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setPrompt({ title, description, resolve });
    });
  }

  function closePrompt(value: string | null) {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    setPin("");
    setPinError(null);
    resolve?.(value);
  }

  const ensureCapability = useCallback(async (capability: string, title: string) => {
    let current = status ?? await refresh();
    if (!current) return true; // Fixture/dev runtime has no production access API.
    const decision = current.capabilities[capability];
    if (!decision || decision.allowed) return true;
    if (decision.availability !== "elevation_required") return false;

    const entered = await requestPin(
      title,
      "Полный доступ включится на 30 минут и будет действовать для следующих защищённых операций."
    );
    if (!entered) return false;
    try {
      current = await unlockTemporaryFull(entered);
      setStatus(current);
      return Boolean(current.capabilities[capability]?.allowed);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : "invalid_pin");
      return false;
    }
  }, [refresh, status]);

  const changeProfile = useCallback(async (profile: AccessProfile) => {
    try {
      if (profile === "full") {
        const entered = await requestPin(
          "Включить полный доступ",
          "Ручной полный доступ не имеет таймера и сохранится после перезапуска, пока вы не смените профиль."
        );
        if (!entered) return false;
        setStatus(await setAccessProfile(profile, entered));
      } else {
        setStatus(await setAccessProfile(profile));
      }
      return true;
    } catch (error) {
      setPinError(error instanceof Error ? error.message : "profile_change_failed");
      return false;
    }
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
        <div className="pin-modal-backdrop" role="presentation" onMouseDown={() => closePrompt(null)}>
          <section
            className="pin-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pin-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="section-kicker">Защищённая операция</p>
            <h2 id="pin-modal-title">{prompt.title}</h2>
            <p>{prompt.description}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (/^[0-9]{4,12}$/.test(pin)) closePrompt(pin);
                else setPinError("PIN должен содержать от 4 до 12 цифр.");
              }}
            >
              <label>
                PIN
                <input
                  autoFocus
                  inputMode="numeric"
                  autoComplete="off"
                  type="password"
                  value={pin}
                  onChange={(event) => {
                    setPin(event.target.value.replace(/\D/g, "").slice(0, 12));
                    setPinError(null);
                  }}
                />
              </label>
              {pinError && <span className="pin-error">Неверный PIN или временная блокировка.</span>}
              <div className="pin-modal-actions">
                <button type="button" onClick={() => closePrompt(null)}>Отмена</button>
                <button type="submit" className="primary-action">Подтвердить</button>
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
