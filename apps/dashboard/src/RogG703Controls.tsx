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
  ROG_G703_WAKE_ACTION
} from "./rogG703Api";
import "./RogG703Controls.css";

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

      <div className="rog-g703-actions" aria-label="Управление ASUS ROG G703GI">
        <button
          className="rog-g703-action rog-g703-action--wake"
          type="button"
          data-testid="rog-g703-wake"
          disabled={!controller.canUse(ROG_G703_WAKE_ACTION)}
          aria-busy={controller.pendingAction === ROG_G703_WAKE_ACTION}
          title={controller.availabilityReason(ROG_G703_WAKE_ACTION)}
          onClick={() => void controller.run(ROG_G703_WAKE_ACTION)}
        >
          {controller.pendingAction === ROG_G703_WAKE_ACTION ? "Пробуждаем…" : "Включить"}
        </button>
        <button
          className="rog-g703-action rog-g703-action--hibernate"
          type="button"
          data-testid="rog-g703-hibernate"
          disabled={!controller.canUse(ROG_G703_HIBERNATE_ACTION)}
          aria-busy={controller.pendingAction === ROG_G703_HIBERNATE_ACTION}
          title={controller.availabilityReason(ROG_G703_HIBERNATE_ACTION)}
          onClick={() => void controller.run(ROG_G703_HIBERNATE_ACTION)}
        >
          {controller.pendingAction === ROG_G703_HIBERNATE_ACTION ? "Гибернация…" : "Гибернация"}
        </button>
      </div>

      <p className="rog-g703-controls__note">
        Кнопка переводит Windows в гибернацию. Полное выключение здесь недоступно.
      </p>
      {!controller.apiAvailable && (
        <p className="rog-g703-controls__unavailable">Управление ASUS ROG сейчас недоступно.</p>
      )}
    </section>
  );
}

function rogG703Tone(status: ReturnType<typeof useRogG703Controller>["displayStatus"]): "success" | "warning" | "offline" | "unavailable" {
  if (status === "online") return "success";
  if (status === "waking" || status === "hibernating") return "warning";
  if (status === "unavailable") return "unavailable";
  return "offline";
}

/** Compact/standard Overview presentation backed by the same controller as System. */
export function RogG703CompactControl({ service, interactive = true }: { service: ServiceSnapshot; interactive?: boolean }) {
  const controller = useRogG703Controller(service);
  const status = controller.displayStatus;
  const actionId = status === "online"
    ? ROG_G703_HIBERNATE_ACTION
    : status === "offline"
      ? ROG_G703_WAKE_ACTION
      : null;
  const transition = status === "waking" || status === "hibernating";

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
        {transition ? (
          <button type="button" data-testid="overview-rog-g703-action" disabled aria-busy="true">
            {controller.display.label}
          </button>
        ) : actionId ? (
          <button
            type="button"
            data-testid="overview-rog-g703-action"
            disabled={!interactive || !controller.canUse(actionId)}
            title={controller.availabilityReason(actionId)}
            aria-busy={controller.pendingAction === actionId}
            onClick={() => { if (interactive) void controller.run(actionId); }}
          >
            {controller.pendingAction === actionId ? "Проверяем…" : controller.actionTitles[actionId]}
          </button>
        ) : (
          <span className="overview-rog-widget__unavailable" data-testid="overview-rog-g703-unavailable">
            Недоступен
          </span>
        )}
      </div>
    </WorkZone>
  );
}

/** Detailed System presentation backed by the same fixed controller. */
export function RogG703DetailControl({ service }: { service: ServiceSnapshot }) {
  const controller = useRogG703Controller(service);
  const status = controller.displayStatus;
  const transition = status === "waking" || status === "hibernating";
  const actionId = status === "online"
    ? ROG_G703_HIBERNATE_ACTION
    : status === "offline"
      ? ROG_G703_WAKE_ACTION
      : null;

  return (
    <section className="system-rog-detail" data-testid="system-rog-g703" aria-labelledby="system-rog-g703-title">
      <header className="system-rog-detail__header">
        <div className="system-rog-detail__identity">
          <span className="system-rog-detail__icon" aria-hidden="true"><Icon name="system" /></span>
          <div>
            <p className="section-kicker">Хост · ASUS</p>
            <h2 id="system-rog-g703-title">{service.title}</h2>
          </div>
        </div>
        <StatusText label={controller.display.label} tone={rogG703Tone(status)} />
      </header>

      <div className="system-rog-detail__state" role="status" aria-live="polite">
        <strong>{controller.display.label}</strong>
        <span>{controller.display.detail}</span>
      </div>

      <div className="system-rog-detail__footer">
        <span>{service.presentation?.freshnessLabel ?? "Свежесть не указана"}</span>
        {transition ? (
          <button type="button" disabled aria-busy="true" data-testid="system-rog-action">
            {controller.display.label}
          </button>
        ) : actionId ? (
          <button
            type="button"
            data-testid="system-rog-action"
            disabled={!controller.canUse(actionId)}
            aria-busy={controller.pendingAction === actionId}
            title={controller.availabilityReason(actionId)}
            onClick={() => void controller.run(actionId)}
          >
            {controller.pendingAction === actionId ? "Проверяем…" : controller.actionTitles[actionId]}
          </button>
        ) : (
          <span className="system-rog-detail__unavailable" data-testid="system-rog-action-unavailable">Недоступен</span>
        )}
      </div>
    </section>
  );
}
