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
  avalarActionTitles,
  fetchAvalarAvailability,
  startAvalarAction,
  waitForAvalarExecution,
  type AvalarActionAvailability,
  type AvalarActionId,
  type AvalarActionStatus
} from "./avalarApi";

interface AvalarActionsContextValue {
  available: boolean;
  actionsFor: (service: ServiceSnapshot) => AvalarActionId[];
  availabilityFor: (actionId: AvalarActionId) => AvalarActionAvailability | null;
  run: (service: ServiceSnapshot, actionId: AvalarActionId) => Promise<void>;
  pendingAction: AvalarActionId | null;
}

const AvalarActionsContext = createContext<AvalarActionsContextValue | null>(null);

const progressCopy: Record<AvalarActionStatus, string> = {
  requested: "Запрос зарегистрирован",
  prechecking: "Проверяем среду и блокировки",
  accepted: "Операция принята",
  running: "Выполняем на сервере",
  verifying: "Проверяем health, сайт и revision",
  success: "Операция подтверждена",
  failed: "Операция завершилась ошибкой"
};

function servicePrefix(service: ServiceSnapshot): "avalar.main." | "avalar.stage." | null {
  if (service.id === "avalar-site-main") return "avalar.main.";
  if (service.id === "avalar-site-stage") return "avalar.stage.";
  return null;
}

function expectedRevision(service: ServiceSnapshot): string | undefined {
  const data = service.data as Record<string, unknown>;
  const value = data.deploymentRevision ?? data.commit;
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

function confirmationFor(actionId: AvalarActionId): string | null | false {
  if (actionId === "avalar.main.restart") {
    return window.prompt(
      "Это production. Для перезапуска Main введите RESTART MAIN"
    ) === "RESTART MAIN" ? "RESTART MAIN" : false;
  }
  if (actionId === "avalar.main.deploy") {
    return window.prompt(
      "Это production deploy. Для продолжения введите DEPLOY MAIN"
    ) === "DEPLOY MAIN" ? "DEPLOY MAIN" : false;
  }
  if (actionId === "avalar.stage.restart") {
    return window.confirm("Перезапустить Stage без git pull?") ? null : false;
  }
  if (actionId === "avalar.stage.deploy") {
    return window.confirm(
      "Обновить Stage из GitHub и проверить health после deploy?"
    ) ? null : false;
  }
  return null;
}

export function AvalarActionsProvider({ children }: { children: ReactNode }) {
  const { ensureCapability, explainAvailability } = useAccess();
  const [availability, setAvailability] = useState<Record<AvalarActionId, AvalarActionAvailability> | null>(null);
  const [available, setAvailable] = useState(false);
  const [pendingAction, setPendingAction] = useState<AvalarActionId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAvailability(await fetchAvalarAvailability());
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const actionsFor = useCallback((service: ServiceSnapshot) => {
    const prefix = servicePrefix(service);
    if (!prefix || !availability) return [];
    return (Object.keys(availability) as AvalarActionId[])
      .filter((actionId) => actionId.startsWith(prefix))
      .sort((left, right) => {
        const order = ["smoke", "restart", "deploy"];
        return order.indexOf(left.split(".").at(-1) ?? "") - order.indexOf(right.split(".").at(-1) ?? "");
      });
  }, [availability]);

  const availabilityFor = useCallback(
    (actionId: AvalarActionId) => availability?.[actionId] ?? null,
    [availability]
  );

  const run = useCallback(async (service: ServiceSnapshot, actionId: AvalarActionId) => {
    if (pendingAction) return;
    let decision = availability?.[actionId];
    if (!decision) {
      setNotice("AVALAR action API пока недоступен.");
      return;
    }
    if (!decision.allowed) {
      if (decision.availability === "elevation_required") {
        const elevated = await ensureCapability(actionId, avalarActionTitles[actionId]);
        if (!elevated) {
          setNotice(explainAvailability(decision.availability));
          return;
        }
        await refresh();
        decision = (await fetchAvalarAvailability())[actionId];
        setAvailability((current) => current ? { ...current, [actionId]: decision } : current);
      }
      if (!decision.allowed) {
        setNotice(explainAvailability(decision.availability));
        window.setTimeout(() => setNotice(null), 6_000);
        return;
      }
    }

    const confirmation = confirmationFor(actionId);
    if (confirmation === false) return;
    setPendingAction(actionId);
    setNotice(`${avalarActionTitles[actionId]}: отправляем защищённую команду…`);
    try {
      const started = await startAvalarAction(actionId, {
        expectedRevision: expectedRevision(service),
        ...(typeof confirmation === "string" ? { confirmation } : {})
      });
      const finished = await waitForAvalarExecution(started.correlationId, (execution) => {
        setNotice(
          `${avalarActionTitles[actionId]} · ${progressCopy[execution.status]} · ${execution.correlationId.slice(0, 8)}`
        );
      });
      if (finished.status === "success") {
        setNotice(`${avalarActionTitles[actionId]}: успешно проверено.`);
      } else {
        setNotice(`${avalarActionTitles[actionId]}: ${finished.error ?? "action_failed"}.`);
      }
      await refresh();
    } catch (error) {
      setNotice(`${avalarActionTitles[actionId]}: ${error instanceof Error ? error.message : "action_failed"}.`);
    } finally {
      setPendingAction(null);
      window.setTimeout(() => setNotice(null), 8_000);
    }
  }, [
    availability,
    pendingAction,
    ensureCapability,
    explainAvailability,
    refresh
  ]);

  const value = useMemo<AvalarActionsContextValue>(() => ({
    available,
    actionsFor,
    availabilityFor,
    run,
    pendingAction
  }), [available, actionsFor, availabilityFor, run, pendingAction]);

  return (
    <AvalarActionsContext.Provider value={value}>
      {children}
      {notice && <div className="action-notice" role="status">{notice}</div>}
    </AvalarActionsContext.Provider>
  );
}

export function useAvalarActions() {
  const value = useContext(AvalarActionsContext);
  if (!value) throw new Error("useAvalarActions must be used inside AvalarActionsProvider");
  return value;
}
