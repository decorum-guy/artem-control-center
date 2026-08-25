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
import { useActionConfirmation } from "./ActionConfirmations";
import type { ActionConfirmationId } from "./actionConfirmationCatalog";
import { useNoticeCenter } from "./NoticeCenter";
import { useInteractionLock } from "./InteractionLock";
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

type ActionNoticeTone = "progress" | "success" | "warning" | "error";

interface ActionNotice {
  title: string;
  message: string;
  tone: ActionNoticeTone;
  meta?: string;
}

const AvalarActionsContext = createContext<AvalarActionsContextValue | null>(null);

const progressCopy: Record<AvalarActionStatus, string> = {
  requested: "Запрос зарегистрирован",
  prechecking: "Проверяем доступность",
  accepted: "Операция принята",
  running: "Выполняем действие",
  verifying: "Проверяем результат",
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

function confirmationIdFor(actionId: AvalarActionId): ActionConfirmationId | null {
  switch (actionId) {
    case "avalar.main.restart":
    case "avalar.main.deploy":
    case "avalar.stage.restart":
    case "avalar.stage.deploy":
      return actionId;
    default:
      return null;
  }
}

export function AvalarActionsProvider({ children }: { children: ReactNode }) {
  const { ensureCapability, explainAvailability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { confirmAction, confirmationOpen } = useActionConfirmation();
  const [availability, setAvailability] = useState<Record<AvalarActionId, AvalarActionAvailability> | null>(null);
  const [available, setAvailable] = useState(false);
  const [pendingAction, setPendingAction] = useState<AvalarActionId | null>(null);
  const { showNotice: pushNotice } = useNoticeCenter();
  const showNotice = useCallback((next: ActionNotice, timeoutMs?: number) => {
    pushNotice({
      id: "avalar.action",
      correlationId: next.meta,
      severity: next.tone,
      title: next.title,
      detail: next.message,
      timeoutMs,
      testId: "avalar-action-notice"
    });
  }, [pushNotice]);

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
    if (!guardMutation()) return;
    if (pendingAction || confirmationOpen) return;
    const actionTitle = avalarActionTitles[actionId];
    let decision = availability?.[actionId];
    if (!decision) {
      showNotice({
        title: actionTitle,
        message: "Действие AVALAR сейчас недоступно.",
        tone: "warning"
      }, 6_000);
      return;
    }
    if (!decision.allowed) {
      if (decision.availability === "elevation_required") {
        const elevated = await ensureCapability(actionId, actionTitle);
        if (!elevated) {
          showNotice({
            title: actionTitle,
            message: explainAvailability(decision.availability),
            tone: "warning"
          }, 6_000);
          return;
        }
        await refresh();
        decision = (await fetchAvalarAvailability())[actionId];
        setAvailability((current) => current ? { ...current, [actionId]: decision } : current);
      }
      if (!decision.allowed) {
        showNotice({
          title: actionTitle,
          message: explainAvailability(decision.availability),
          tone: "warning"
        }, 6_000);
        return;
      }
    }

    const confirmationId = confirmationIdFor(actionId);
    let confirmationValue: string | undefined;
    if (confirmationId) {
      const result = await confirmAction(confirmationId, {
        revision: expectedRevision(service)
      });
      if (!result.confirmed) return;
      confirmationValue = result.confirmation;
    }

    if (!guardMutation()) return;
    setPendingAction(actionId);
    showNotice({
      title: actionTitle,
      message: "Отправляем защищённую команду…",
      tone: "progress"
    });
    try {
      const started = await startAvalarAction(actionId, {
        expectedRevision: expectedRevision(service),
        ...(confirmationValue ? { confirmation: confirmationValue } : {})
      });
      const finished = await waitForAvalarExecution(started.correlationId, (execution) => {
        showNotice({
          title: actionTitle,
          message: progressCopy[execution.status],
          tone: execution.status === "failed" ? "error" : "progress",
          meta: `Операция ${execution.correlationId.slice(0, 8)}`
        });
      });
      if (finished.status === "success") {
        showNotice({
          title: actionTitle,
          message: "Успешно проверено.",
          tone: "success",
          meta: `Операция ${finished.correlationId.slice(0, 8)}`
        }, 8_000);
      } else {
        showNotice({
          title: actionTitle,
          message: "Операция не выполнена.",
          tone: "error",
          meta: `Операция ${finished.correlationId.slice(0, 8)}`
        }, 10_000);
      }
      await refresh();
    } catch (error) {
      showNotice({
        title: actionTitle,
        message: error instanceof Error ? error.message : "action_failed",
        tone: "error"
      }, 10_000);
    } finally {
      setPendingAction(null);
    }
  }, [
    availability,
    pendingAction,
    confirmationOpen,
    confirmAction,
    ensureCapability,
    explainAvailability,
    guardMutation,
    refresh,
    showNotice
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
    </AvalarActionsContext.Provider>
  );
}

export function useAvalarActions() {
  const value = useContext(AvalarActionsContext);
  if (!value) throw new Error("useAvalarActions must be used inside AvalarActionsProvider");
  return value;
}
