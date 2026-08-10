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
import { useAccess } from "./AccessControls";
import {
  fetchConnectivityAvailability,
  startConnectivityRestart,
  waitForConnectivityExecution,
  type ConnectivityActionAvailability,
  type ConnectivityActionStatus
} from "./connectivityApi";

interface ConnectivityActionsContextValue {
  available: boolean;
  availability: ConnectivityActionAvailability | null;
  pending: boolean;
  run: () => Promise<void>;
}

type NoticeTone = "progress" | "success" | "warning" | "error";

interface ConnectivityNotice {
  message: string;
  tone: NoticeTone;
  meta?: string;
}

const progressCopy: Record<ConnectivityActionStatus, string> = {
  requested: "Запрос зарегистрирован",
  restarting: "Перезапускаем приватное подключение",
  waiting_for_forwards: "Ждём туннели Home Assistant и AliceTG",
  verifying: "Проверяем Home Assistant и AliceTG",
  connected: "Подключение восстановлено",
  degraded: "Подключение восстановлено не полностью",
  failed: "Не удалось восстановить подключение"
};

const ConnectivityActionsContext = createContext<ConnectivityActionsContextValue | null>(null);

export function ConnectivityActionsProvider({ children }: { children: ReactNode }) {
  const [availability, setAvailability] = useState<ConnectivityActionAvailability | null>(null);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<ConnectivityNotice | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((next: ConnectivityNotice, timeoutMs?: number) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(next);
    if (timeoutMs) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, timeoutMs);
    }
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchConnectivityAvailability();
      setAvailability(next);
      setAvailable(true);
      return next;
    } catch {
      setAvailability(null);
      setAvailable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = useCallback(async () => {
    if (pending) return;
    const decision = availability ?? await refresh();
    if (!decision?.allowed) return;

    setPending(true);
    showNotice({
      message: "Отправляем команду локальному supervisor…",
      tone: "progress"
    });
    try {
      const started = await startConnectivityRestart();
      const finished = await waitForConnectivityExecution(started.correlationId, (execution) => {
        const tone: NoticeTone = execution.status === "failed"
          ? "error"
          : execution.status === "degraded"
            ? "warning"
            : execution.status === "connected"
              ? "success"
              : "progress";
        showNotice({
          message: progressCopy[execution.status],
          tone,
          meta: `Операция ${execution.correlationId.slice(0, 8)}`
        });
      });

      if (finished.status === "connected") {
        showNotice({
          message: "Home Assistant и AliceTG снова на связи.",
          tone: "success",
          meta: `Операция ${finished.correlationId.slice(0, 8)}`
        }, 8_000);
      } else if (finished.status === "degraded") {
        showNotice({
          message: "Туннель поднят не полностью или один из сервисов ещё не подтвердил здоровье.",
          tone: "warning",
          meta: `Операция ${finished.correlationId.slice(0, 8)}`
        }, 10_000);
      } else {
        showNotice({
          message: "Приватное подключение не восстановилось. Система продолжит автоматические попытки.",
          tone: "error",
          meta: `Операция ${finished.correlationId.slice(0, 8)}`
        }, 10_000);
      }
    } catch (error) {
      showNotice({
        message: error instanceof Error ? error.message : "Не удалось запустить восстановление подключения.",
        tone: "error"
      }, 10_000);
    } finally {
      setPending(false);
      await refresh();
    }
  }, [availability, pending, refresh, showNotice]);

  const value = useMemo<ConnectivityActionsContextValue>(() => ({
    available,
    availability,
    pending,
    run
  }), [available, availability, pending, run]);

  return (
    <ConnectivityActionsContext.Provider value={value}>
      {children}
      {notice && (
        <aside
          className={`action-notice action-notice--${notice.tone} connectivity-action-notice`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          data-testid="connectivity-action-notice"
        >
          <span className="action-notice__indicator" aria-hidden="true" />
          <span className="action-notice__copy">
            <strong>Домашнее подключение</strong>
            <span>{notice.message}</span>
            {notice.meta && <small>{notice.meta}</small>}
          </span>
        </aside>
      )}
    </ConnectivityActionsContext.Provider>
  );
}

export function useConnectivityActions() {
  const value = useContext(ConnectivityActionsContext);
  if (!value) throw new Error("useConnectivityActions must be used inside ConnectivityActionsProvider");
  return value;
}

export function ConnectivityRecoveryButton({
  degraded = false,
  className = ""
}: {
  degraded?: boolean;
  className?: string;
}) {
  const connectivity = useConnectivityActions();
  const { explainAvailability } = useAccess();
  const decision = connectivity.availability;
  const label = degraded ? "Подключиться снова" : "Перезапустить подключение";
  const reason = decision
    ? explainAvailability(decision.availability)
    : connectivity.available
      ? "Операция сейчас недоступна"
      : "Connectivity API недоступен";

  return (
    <button
      type="button"
      className={`connectivity-recovery-button ${className}`.trim()}
      disabled={!decision?.allowed || connectivity.pending}
      title={reason}
      aria-busy={connectivity.pending}
      onClick={() => void connectivity.run()}
    >
      {connectivity.pending ? "Восстанавливаем…" : label}
    </button>
  );
}
