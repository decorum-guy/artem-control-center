import { useEffect, useState } from "react";
import type {
  CoffeeData,
  KettleData,
  ServiceSnapshot,
  WidgetManifest
} from "@artem/contracts";
import { coffeePresentation } from "./coffee";
import { resolveWidgetAsset } from "./widgetAssets";

const healthLabels = {
  healthy: "Работает",
  degraded: "Требует внимания",
  offline: "Недоступен",
  stale: "Данные устарели"
} as const;

export function HealthMark({
  health,
  compact = false
}: {
  health: ServiceSnapshot["health"];
  compact?: boolean;
}) {
  return (
    <span className={`health-mark health-mark--${health} ${compact ? "health-mark--compact" : ""}`}>
      <i aria-hidden="true" />
      {healthLabels[health]}
    </span>
  );
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return "меньше минуты";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} ч ${remainder} мин` : `${hours} ч`;
}

function CoffeeAsset({ manifest }: { manifest: WidgetManifest }) {
  const asset = manifest.visualAsset;
  const resolved = asset ? resolveWidgetAsset(asset.sourcePath) : null;
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [resolved]);

  if (!asset || !resolved || failed) {
    return (
      <div className="coffee-asset__fallback" data-testid="coffee-asset-fallback">
        <span>Иллюстрация кофемашины</span>
      </div>
    );
  }

  return (
    <img
      className="coffee-asset__image"
      src={resolved}
      alt={asset.alt}
      style={{ objectFit: asset.fit }}
      onError={() => setFailed(true)}
    />
  );
}

export function CoffeeWidget({
  service,
  generatedAt,
  manifest,
  variant = "featured",
  onAction
}: {
  service: ServiceSnapshot;
  generatedAt: string;
  manifest: WidgetManifest;
  variant?: "featured" | "home" | "gallery";
  onAction?: (service: ServiceSnapshot, actionId: string) => void;
}) {
  const data = service.data as unknown as CoffeeData;
  const view = coffeePresentation(data, generatedAt);
  const duration = formatDuration(view.runningSeconds);
  const remaining = formatDuration(view.remainingSeconds);
  const warming = view.stage === "warming" && view.progress !== null;
  const activeAction = service.actions.find((action) =>
    view.stage === "off" ? action.id.endsWith("turn_on") : action.id.endsWith("turn_off")
  );

  let stateDetail = service.summary;
  if (warming && remaining) stateDetail = `Осталось примерно ${remaining}`;
  if (view.stage === "ready" && duration) stateDetail = `Работает ${duration} · можно готовить кофе`;
  if (view.stage === "running" && duration) stateDetail = `Работает ${duration}`;
  if (view.stage === "running_too_long" && duration) stateDetail = `Включена уже ${duration}`;
  if (view.stage === "off" && data.machine.entityLastChangedAt) {
    stateDetail = `Последнее изменение ${new Date(data.machine.entityLastChangedAt).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit"
    })}`;
  }

  return (
    <article
      className={`coffee-panel coffee-panel--${variant} coffee-panel--${view.stage} ${view.warning ? "surface--warning" : ""}`}
      data-testid="widget-coffee-machine"
      data-stage={view.stage}
    >
      <div className="coffee-panel__copy">
        <div className="coffee-panel__heading">
          <div>
            <p className="section-kicker">Дом · кофемашина</p>
            <h2>{service.title}</h2>
          </div>
          <HealthMark health={service.health} compact />
        </div>

        <div className="coffee-panel__state" aria-live="polite">
          <strong>{view.label}</strong>
          <span>{stateDetail}</span>
        </div>

        {warming && (
          <div className="coffee-progress" aria-label={`Разогрев ${view.progressText}`}>
            <div className="coffee-progress__track">
              <span style={{ width: `${view.progress! * 100}%` }} />
            </div>
            <output>{view.progressText}</output>
          </div>
        )}

        {(data.timingPolicy.stale || !data.timingPolicy.sourceAvailable || view.stage === "unavailable") && (
          <p className={`coffee-policy-note ${data.timingPolicy.stale ? "coffee-policy-note--stale" : ""}`}>
            {view.timingMessage}
          </p>
        )}

        {activeAction && (
          <button
            className="primary-action"
            type="button"
            disabled={!activeAction.enabled || !onAction}
            onClick={() => onAction?.(service, activeAction.id)}
          >
            {activeAction.title}
          </button>
        )}
      </div>

      <div className="coffee-asset" data-fit={manifest.visualAsset?.fit ?? "contain"}>
        <CoffeeAsset manifest={manifest} />
        {view.stage === "warming" && (
          <span className="coffee-activity" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className={`coffee-state-marker coffee-state-marker--${view.stage}`}>
          {view.stage === "warming" ? "Разогрев" : view.label}
        </span>
      </div>
    </article>
  );
}

export function HomeDeviceWidget({
  service,
  prominent = false
}: {
  service: ServiceSnapshot;
  prominent?: boolean;
}) {
  const data = service.data as unknown as KettleData;
  const state =
    data.stage === "on" ? "Включён" : data.stage === "off" ? "Выключен" : "Недоступен";

  return (
    <article
      className={`device-control ${prominent ? "device-control--prominent" : ""}`}
      data-testid={`widget-${service.id}`}
    >
      <div>
        <p className="section-kicker">Домашнее устройство</p>
        <h3>{service.title}</h3>
      </div>
      <div className="device-control__state">
        <strong>{state}</strong>
        <HealthMark health={service.health} compact />
      </div>
    </article>
  );
}

export function ServiceRow({ service }: { service: ServiceSnapshot }) {
  const incidents = service.presentation?.incidents ?? (service.health === "healthy" ? 0 : 1);
  const sourceLabels = {
    live: "live",
    cached: "cache",
    fixture: "fixture",
    stale: "stale",
    unavailable: "нет данных"
  } as const;
  return (
    <article className="service-row" data-testid={`widget-${service.id}`}>
      <div className="service-row__identity">
        <HealthMark health={service.health} compact />
        <div>
          <h3>{service.title}</h3>
          <p>{service.summary}</p>
        </div>
      </div>
      <dl className="service-row__facts">
        <div>
          <dt>Среда</dt>
          <dd>{service.presentation?.environment ?? "—"}</dd>
        </div>
        <div>
          <dt>Свежесть</dt>
          <dd>{service.presentation?.freshnessLabel ?? "нет данных"}</dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>{sourceLabels[service.source]}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>
            {typeof service.presentation?.latencyMs === "number"
              ? `${service.presentation.latencyMs} ms`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Incidents</dt>
          <dd>{incidents}</dd>
        </div>
      </dl>
      <div className="service-row__actions">
        {service.actions
          .filter((action) => action.enabled)
          .map((action) => (
            <button key={action.id} type="button" disabled title="Foundation: action execution disabled">
              {action.title}
            </button>
          ))}
        <button type="button" className="text-action">Подробнее</button>
      </div>
    </article>
  );
}

export function GenericServiceWidget({ service }: { service: ServiceSnapshot }) {
  return (
    <article className="dev-widget" data-testid={`widget-${service.id}`}>
      <header className="dev-widget__header">
        <div>
          <p className="section-kicker">{service.dataContract}</p>
          <h2>{service.title}</h2>
        </div>
        <HealthMark health={service.health} />
      </header>
      <p>{service.summary}</p>
      <footer className="dev-widget__footer">
        <span>{service.actions.length ? `${service.actions.length} actions` : "monitor-only"}</span>
        <span>generic fallback</span>
      </footer>
    </article>
  );
}
