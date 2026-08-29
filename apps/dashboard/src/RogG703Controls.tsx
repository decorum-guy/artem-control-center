import type { ServiceSnapshot } from "@artem/contracts";
import { Icon } from "./icons";
import { StatusText, WorkZone } from "./ShellPrimitives";
import { HealthMark } from "./widgets";
import {
  useRogG703Controller,
  rogG703StatusCopy
} from "./RogG703Controller";
import {
  ROG_G703_HIBERNATE_ACTION,
  ROG_G703_SLEEP_ACTION,
  ROG_G703_WAKE_ACTION
} from "./rogG703Api";
import "./RogG703Controls.css";

type RogG703Controller = ReturnType<typeof useRogG703Controller>;

function RogG703PowerActionGroup({
  controller,
  testIdPrefix,
  className,
  interactive = true
}: {
  controller: RogG703Controller;
  testIdPrefix: "rog-g703" | "system-rog" | "overview-rog-g703";
  className: string;
  interactive?: boolean;
}) {
  const status = controller.displayStatus;
  const actionIds = status === "online" || status === "sleeping" || status === "hibernating"
    ? [ROG_G703_SLEEP_ACTION, ROG_G703_HIBERNATE_ACTION]
    : status === "offline" || status === "waking"
      ? [ROG_G703_WAKE_ACTION]
      : [];

  if (!actionIds.length) return null;

  return (
    <div
      className={[className, actionIds.length === 1 ? "rog-g703-actions--single" : ""].filter(Boolean).join(" ")}
      aria-label="Управление ASUS ROG G703GI"
    >
      {actionIds.map((actionId) => {
        const pending = controller.pendingAction === actionId;
        const label = pending
          ? actionId === ROG_G703_WAKE_ACTION
            ? "Пробуждаем…"
            : actionId === ROG_G703_SLEEP_ACTION
              ? "Сон…"
              : "Гибернация…"
          : controller.actionTitles[actionId];
        return (
          <button
            key={actionId}
            className={`rog-g703-action rog-g703-action--${actionId === ROG_G703_WAKE_ACTION ? "wake" : actionId === ROG_G703_SLEEP_ACTION ? "sleep" : "hibernate"}`}
            type="button"
            data-testid={`${testIdPrefix}-${actionId === ROG_G703_WAKE_ACTION ? "wake" : actionId === ROG_G703_SLEEP_ACTION ? "sleep" : "hibernate"}`}
            disabled={!interactive || !controller.canUse(actionId)}
            aria-busy={pending}
            title={controller.availabilityReason(actionId)}
            onClick={() => void controller.run(actionId)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function RogG703Controls({ service }: { service: ServiceSnapshot }) {
  const controller = useRogG703Controller(service);
  const display = rogG703StatusCopy[controller.displayStatus];

  return (
    <section className="rog-g703-controls" data-testid="rog-g703-controls" aria-labelledby="rog-g703-title">
      <header className="rog-g703-controls__header">
        <div>
        <p className="section-kicker">Устройство · Windows</p>
          <h2 id="rog-g703-title">{service.title}</h2>
        </div>
        <HealthMark health={service.health} compact />
      </header>

      <div className={`rog-g703-status rog-g703-status--${controller.displayStatus}`} role="status" aria-live="polite">
        <span className="rog-g703-status__indicator" aria-hidden="true" />
        <div>
          <strong>{display.label}</strong>
          <span>{display.detail}</span>
        </div>
      </div>

      <RogG703PowerActionGroup
        controller={controller}
        testIdPrefix="rog-g703"
        className="rog-g703-actions"
      />

      <p className="rog-g703-controls__note">
        Сон и гибернация — отдельные операции Windows. Полное выключение здесь недоступно.
      </p>
      {!controller.apiAvailable && (
        <p className="rog-g703-controls__unavailable">Управление ASUS ROG сейчас недоступно.</p>
      )}
    </section>
  );
}

function rogG703Tone(status: ReturnType<typeof useRogG703Controller>["displayStatus"]): "success" | "warning" | "offline" | "unavailable" {
  if (status === "online") return "success";
  if (status === "waking" || status === "sleeping" || status === "hibernating") return "warning";
  if (status === "unavailable") return "unavailable";
  return "offline";
}

/** Compact/standard Overview presentation backed by the same controller as System. */
export function RogG703CompactControl({ service, interactive = true }: { service: ServiceSnapshot; interactive?: boolean }) {
  const controller = useRogG703Controller(service);
  const status = controller.displayStatus;

  return (
    <WorkZone className="overview-v2-real-widget overview-rog-widget" data-testid="overview-rog-g703">
      <span className="overview-rog-widget__icon" aria-hidden="true"><Icon name="system" /></span>
      <div className="overview-rog-widget__identity">
        <h2>{service.title}</h2>
      </div>
      <span className="overview-rog-widget__separator" aria-hidden="true">·</span>
      <StatusText
        label={controller.display.label}
        tone={rogG703Tone(status)}
        className="overview-rog-widget__status"
      />
      <span className="overview-rog-widget__freshness">
        {service.presentation?.freshnessLabel ?? "свежесть не указана"}
      </span>
      <div className="overview-rog-widget__action">
        {status === "unavailable" ? (
          <span className="overview-rog-widget__unavailable" data-testid="overview-rog-g703-unavailable">
            Недоступен
          </span>
        ) : (
          <RogG703PowerActionGroup
            controller={controller}
            testIdPrefix="overview-rog-g703"
            className="overview-rog-widget__actions"
            interactive={interactive}
          />
        )}
      </div>
    </WorkZone>
  );
}

/** Detailed System presentation backed by the same fixed controller. */
export function RogG703DetailControl({ service }: { service: ServiceSnapshot }) {
  const controller = useRogG703Controller(service);
  const status = controller.displayStatus;

  return (
    <section className="system-rog-detail" data-testid="system-rog-g703" aria-labelledby="system-rog-g703-title">
      <header className="system-rog-detail__header">
        <div className="system-rog-detail__identity">
          <span className="system-rog-detail__icon" aria-hidden="true"><Icon name="system" /></span>
          <h2 id="system-rog-g703-title">{service.title}</h2>
        </div>
        <StatusText label={controller.display.label} tone={rogG703Tone(status)} />
      </header>

      <div className="system-rog-detail__state" role="status" aria-live="polite">
        <strong>{controller.display.label}</strong>
        <span>{controller.display.detail}</span>
      </div>

      <div className="system-rog-detail__footer">
        <span>{service.presentation?.freshnessLabel ?? "Свежесть не указана"}</span>
        {status === "unavailable" ? (
          <span className="system-rog-detail__unavailable" data-testid="system-rog-action-unavailable">Недоступен</span>
        ) : (
          <RogG703PowerActionGroup
            controller={controller}
            testIdPrefix="system-rog"
            className="system-rog-detail__actions"
          />
        )}
      </div>
    </section>
  );
}
