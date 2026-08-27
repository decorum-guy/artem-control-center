import { useCallback, useEffect, useMemo, useState } from "react";
import type { RogG703Data, ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useNoticeCenter } from "./NoticeCenter";
import { useInteractionLock } from "./InteractionLock";
import {
  fetchRogG703Availability,
  ROG_G703_HIBERNATE_ACTION,
  ROG_G703_SLEEP_ACTION,
  ROG_G703_WAKE_ACTION,
  startRogG703Action,
  waitForRogG703Execution,
  type RogG703ActionAvailability,
  type RogG703ActionExecution,
  type RogG703ActionId,
  type RogG703DeviceStatus
} from "./rogG703Api";

type AvailabilityMap = Record<RogG703ActionId, RogG703ActionAvailability>;

export const rogG703StatusCopy: Record<RogG703DeviceStatus, { label: string; detail: string }> = {
  online: { label: "В сети", detail: "ASUS отвечает" },
  offline: { label: "Не в сети", detail: "Устройство не отвечает — сон или гибернация" },
  waking: { label: "Пробуждение", detail: "Ждём, когда ASUS появится в сети" },
  sleeping: { label: "Сон", detail: "Ждём завершения перехода" },
  hibernating: { label: "Гибернация", detail: "Ждём завершения перехода" },
  unavailable: { label: "Недоступен", detail: "Проверка устройства сейчас недоступна" }
};

const actionProgressCopy: Record<RogG703ActionExecution["status"], string> = {
  requested: "Запрос зарегистрирован",
  waking: "Пакет пробуждения отправлен",
  online: "ASUS появился в сети",
  wake_timeout: "Не удалось разбудить ASUS",
  sleeping: "ASUS переходит в сон",
  hibernating: "ASUS переходит в гибернацию",
  offline: "ASUS больше не отвечает — переход подтверждён",
  failed: "Операция ASUS завершилась ошибкой"
};

function actionErrorCopy(error: string | null): string {
  switch (error) {
    case "wake_timeout":
      return "Не удалось разбудить ASUS в заданное время.";
    case "hibernate_timeout":
      return "ASUS остаётся доступен: переход в гибернацию не подтверждён.";
    case "sleep_timeout":
      return "ASUS остаётся доступен: переход в сон не подтверждён.";
    case "companion_health_failed":
    case "companion_hibernate_failed":
    case "companion_sleep_failed":
      return "ASUS companion не подтвердил операцию.";
    default:
      return "Операция ASUS не выполнена. Проверьте состояние и повторите попытку.";
  }
}

function statusFromService(service: ServiceSnapshot): RogG703DeviceStatus {
  const data = service.data as Partial<RogG703Data>;
  return data.status ?? "unavailable";
}

export interface RogG703ControllerState {
  readonly serviceStatus: RogG703DeviceStatus;
  readonly displayStatus: RogG703DeviceStatus;
  readonly display: { label: string; detail: string };
  readonly availability: AvailabilityMap | null;
  readonly apiAvailable: boolean;
  readonly pendingAction: RogG703ActionId | null;
  readonly actionTitles: Record<RogG703ActionId, string>;
  readonly availabilityReason: (actionId: RogG703ActionId) => string;
  readonly canUse: (actionId: RogG703ActionId) => boolean;
  readonly run: (actionId: RogG703ActionId) => Promise<void>;
}

/**
 * The single ROG orchestration owner. Presentations call this hook; they do
 * not own polling, access elevation, confirmation, action execution, or
 * operation notices.
 */
export function useRogG703Controller(service: ServiceSnapshot): RogG703ControllerState {
  const { ensureCapability, explainAvailability } = useAccess();
  const { confirmAction, confirmationOpen } = useActionConfirmation();
  const { showNotice } = useNoticeCenter();
  const { guardMutation } = useInteractionLock();
  const [availability, setAvailability] = useState<AvailabilityMap | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [pendingAction, setPendingAction] = useState<RogG703ActionId | null>(null);
  const [transitionStatus, setTransitionStatus] = useState<RogG703DeviceStatus | null>(null);

  const serviceStatus = statusFromService(service);
  const displayStatus = transitionStatus ?? serviceStatus;
  const display = rogG703StatusCopy[displayStatus];

  const refresh = useCallback(async () => {
    try {
      const next = await fetchRogG703Availability();
      setAvailability(next.actions);
      setApiAvailable(true);
      return next;
    } catch {
      setAvailability(null);
      setApiAvailable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!pendingAction && transitionStatus === serviceStatus) setTransitionStatus(null);
  }, [serviceStatus, pendingAction, transitionStatus]);

  const actionTitles = useMemo<Record<RogG703ActionId, string>>(() => ({
    [ROG_G703_WAKE_ACTION]: "Включить",
    [ROG_G703_HIBERNATE_ACTION]: "Гибернация",
    [ROG_G703_SLEEP_ACTION]: "Сон"
  }), []);

  const showActionNotice = useCallback((
    severity: "progress" | "success" | "warning" | "error",
    detail: string,
    correlationId?: string,
    timeoutMs?: number
  ) => {
    showNotice({
      id: "rog-g703.action",
      correlationId,
      severity,
      title: "ASUS ROG G703GI",
      detail,
      timeoutMs,
      testId: "rog-g703-action-notice"
    });
  }, [showNotice]);

  const run = useCallback(async (actionId: RogG703ActionId) => {
    if (!guardMutation()) return;
    if (pendingAction || confirmationOpen) return;

    let decision = availability?.[actionId] ?? null;
    if (!decision) {
      const next = await refresh();
      decision = next?.actions[actionId] ?? null;
    }
    if (!decision) {
      showActionNotice("warning", "Исполнитель ASUS пока недоступен.", undefined, 6_000);
      return;
    }

    if (!decision.allowed && decision.availability === "elevation_required") {
      const elevated = await ensureCapability(actionId, actionTitles[actionId]);
      if (elevated) {
        const next = await refresh();
        decision = next?.actions[actionId] ?? decision;
      }
    }
    if (!decision.allowed) {
      showActionNotice("warning", explainAvailability(decision.availability), undefined, 6_000);
      return;
    }

    if (actionId === ROG_G703_HIBERNATE_ACTION || actionId === ROG_G703_SLEEP_ACTION) {
      const confirmation = await confirmAction(actionId);
      if (!confirmation.confirmed) return;
    }

    if (!guardMutation()) return;
    setPendingAction(actionId);
    setTransitionStatus(
      actionId === ROG_G703_WAKE_ACTION
        ? "waking"
        : actionId === ROG_G703_SLEEP_ACTION
          ? "sleeping"
          : "hibernating"
    );
    showActionNotice(
      "progress",
      actionId === ROG_G703_WAKE_ACTION
        ? "Отправляем пакет пробуждения…"
        : actionId === ROG_G703_SLEEP_ACTION
          ? "Отправляем команду сна…"
          : "Отправляем команду гибернации…"
    );

    try {
      const started = await startRogG703Action(actionId);
      const finished = await waitForRogG703Execution(
        started.correlationId,
        (execution) => {
          const failed = execution.status === "failed" || execution.status === "wake_timeout";
          if (execution.status === "waking") setTransitionStatus("waking");
          if (execution.status === "sleeping") setTransitionStatus("sleeping");
          if (execution.status === "hibernating") setTransitionStatus("hibernating");
          if (execution.status === "online") setTransitionStatus("online");
          if (execution.status === "offline" || execution.status === "wake_timeout") setTransitionStatus("offline");
          if (execution.status === "failed") {
            setTransitionStatus(actionId === ROG_G703_WAKE_ACTION ? "offline" : "online");
          }
          showActionNotice(
            failed ? "error" : execution.status === "online" || execution.status === "offline" ? "success" : "progress",
            failed ? actionErrorCopy(execution.error) : actionProgressCopy[execution.status],
            execution.correlationId.slice(0, 8),
            failed ? 10_000 : undefined
          );
        }
      );
      if (finished.status === "online" || finished.status === "offline") {
        showActionNotice(
          "success",
          actionProgressCopy[finished.status],
          finished.correlationId.slice(0, 8),
          8_000
        );
      } else {
        showActionNotice(
          "error",
          actionErrorCopy(finished.error),
          finished.correlationId.slice(0, 8),
          10_000
        );
      }
      await refresh();
    } catch (error) {
      showActionNotice(
        "error",
        error instanceof Error ? actionErrorCopy(error.message) : actionErrorCopy(null),
        undefined,
        10_000
      );
    } finally {
      setPendingAction(null);
    }
  }, [actionTitles, availability, confirmAction, confirmationOpen, ensureCapability, explainAvailability, guardMutation, pendingAction, refresh, showActionNotice]);

  const canUse = useCallback((actionId: RogG703ActionId) => {
    const decision = availability?.[actionId];
    return Boolean(
      apiAvailable &&
      decision &&
      (decision.allowed || decision.availability === "elevation_required") &&
      !pendingAction
    );
  }, [apiAvailable, availability, pendingAction]);

  const availabilityReason = useCallback((actionId: RogG703ActionId) => {
    const decision = availability?.[actionId];
    return decision ? explainAvailability(decision.availability) : "Проверяем доступность";
  }, [availability, explainAvailability]);

  return {
    serviceStatus,
    displayStatus,
    display,
    availability,
    apiAvailable,
    pendingAction,
    actionTitles,
    availabilityReason,
    canUse,
    run
  };
}
