import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import {
  fetchConnectivityAvailability,
  startConnectivityRestart,
  waitForConnectivityExecution,
  type ConnectivityActionAvailability,
  type ConnectivityActionStatus
} from "./connectivityApi";
import { useNoticeCenter } from "./NoticeCenter";

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
  const { showNotice: pushNotice } = useNoticeCenter();
  const showNotice = useCallback((next: ConnectivityNotice, timeoutMs?: number) => {
    pushNotice({
      id: "connectivity.recovery",
      correlationId: next.meta,
      severity: next.tone,
      title: "Домашнее подключение",
      detail: next.meta ? `${next.message} · ${next.meta}` : next.message,
      timeoutMs,
      testId: "connectivity-action-notice"
    });
  }, [pushNotice]);

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
      : "Локальный recovery API ещё недоступен";

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

export function ConnectivityRecoverySurface({
  services,
  showWhenHealthy = false
}: {
  services: ServiceSnapshot[];
  showWhenHealthy?: boolean;
}) {
  const connectivity = useConnectivityActions();
  const homeAssistant = services.find((service) => service.id === "home-assistant");
  const alice = services.find((service) => service.id === "alice-tg-bot");
  const homeAssistantLive = Boolean(
    homeAssistant && homeAssistant.health === "healthy" && homeAssistant.source === "live"
  );
  const aliceLive = Boolean(alice && alice.health === "healthy" && alice.source === "live");
  const degraded = !homeAssistantLive || !aliceLive;

  if (!degraded && !showWhenHealthy) return null;

  const recoveryApiReady = connectivity.available && connectivity.availability !== null;
  return (
    <section
      className={`connectivity-recovery-surface ${degraded ? "connectivity-recovery-surface--attention" : ""}`}
      aria-label="Приватное подключение Home Assistant и AliceTG"
      data-testid="connectivity-recovery-surface"
    >
      <div className="connectivity-recovery-surface__copy">
        <p className="section-kicker">Домашняя инфраструктура</p>
        <strong>{degraded ? "Приватное подключение требует внимания" : "Приватное подключение работает"}</strong>
        <span>
          Home Assistant: {homeAssistantLive ? "на связи" : "нет свежего соединения"}
          {" · "}
          AliceTG: {aliceLive ? "на связи" : "нет свежего соединения"}
          {!recoveryApiReady ? " · recovery API ещё не готов" : ""}
        </span>
      </div>
      <ConnectivityRecoveryButton degraded={degraded} />
    </section>
  );
}
