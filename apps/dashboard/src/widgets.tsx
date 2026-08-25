import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CoffeeData,
  KettleData,
  ServiceSnapshot,
  WidgetManifest
} from "@artem/contracts";
import { useAccess } from "./AccessControls";
import { useAvalarActions } from "./AvalarActions";
import { avalarActionTitles } from "./avalarApi";
import { coffeePresentation } from "./coffee";
import { resolveWidgetAsset } from "./widgetAssets";
import type { CoffeeAppearanceConfig } from "./features/overview/appearanceConfig";
import { sourceOwnedCoffeeScale } from "./features/overview/appearanceConfig";

const healthLabels = {
  healthy: "Работает",
  degraded: "Требует внимания",
  offline: "Недоступен",
  stale: "Данные устарели"
} as const;

export function HealthMark({
  health,
  compact = false,
  healthyLabel
}: {
  health: ServiceSnapshot["health"];
  compact?: boolean;
  healthyLabel?: string;
}) {
  const label = health === "healthy" && healthyLabel ? healthyLabel : healthLabels[health];

  return (
    <span className={`health-mark health-mark--${health} ${compact ? "health-mark--compact" : ""}`}>
      <i aria-hidden="true" />
      {label}
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

function CoffeeAsset({
  manifest,
  scale
}: {
  manifest: WidgetManifest;
  scale: number;
}) {
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
      decoding="async"
      style={{ objectFit: asset.fit, "--cc-coffee-image-scale": scale / 100 } as CSSProperties}
      onError={() => setFailed(true)}
    />
  );
}

export function CoffeeWidget({
  service,
  generatedAt,
  manifest,
  variant = "featured",
  onAction,
  actionPending = false,
  interactive = true,
  appearanceConfig
}: {
  service: ServiceSnapshot;
  generatedAt: string;
  manifest: WidgetManifest;
  variant?: "featured" | "home" | "home-v2" | "gallery" | "overview";
  onAction?: (service: ServiceSnapshot, actionId: string) => void;
  actionPending?: boolean;
  interactive?: boolean;
  appearanceConfig?: CoffeeAppearanceConfig;
}) {
  const data = service.data as unknown as CoffeeData;
  const [presentationTime, setPresentationTime] = useState(() => Date.parse(generatedAt));
  const clockAnchor = useRef({
    snapshotTime: Date.parse(generatedAt),
    wallTime: Date.now()
  });
  const clockEnabled =
    data.machine.state === "on" &&
    data.machine.available &&
    !data.machine.stale &&
    !data.timingPolicy.stale &&
    data.timingPolicy.warmupDurationSeconds !== null &&
    data.timingPolicy.longRunningThresholdSeconds !== null;

  useEffect(() => {
    const next = Date.parse(generatedAt);
    const snapshotTime = Number.isFinite(next) ? next : Date.now();
    clockAnchor.current = { snapshotTime, wallTime: Date.now() };
    setPresentationTime(snapshotTime);
  }, [generatedAt, data.machine.turnedOnAt]);

  useEffect(() => {
    if (!clockEnabled) return;
    const timer = window.setInterval(
      () => {
        const anchor = clockAnchor.current;
        setPresentationTime(
          anchor.snapshotTime + Math.max(0, Date.now() - anchor.wallTime)
        );
      },
      1_000
    );
    return () => window.clearInterval(timer);
  }, [clockEnabled]);

  const view = coffeePresentation(
    data,
    new Date(presentationTime).toISOString()
  );
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
  const showsPolicyNote = data.timingPolicy.stale || !data.timingPolicy.sourceAvailable || view.stage === "unavailable";
  const overviewCopyDensity = warming || stateDetail.length + (showsPolicyNote ? view.timingMessage.length : 0) > 64
    ? "dense"
    : "spacious";
  const appearance: CoffeeAppearanceConfig = appearanceConfig ?? {
    imageScalePct: 100,
    imageXStep: 0,
    imageYStep: 0,
    composition: "auto",
    showStateMarker: true,
    showAuthority: true,
    showImage: true
  };
  const requestedDensity = appearance.composition === "compact"
    ? "dense"
    : appearance.composition === "spacious"
      ? "spacious"
      : overviewCopyDensity;
  const safeMaximum = requestedDensity === "dense" || view.stage === "unavailable" ? 100 : 120;
  const imageScale = sourceOwnedCoffeeScale(appearance.imageScalePct, safeMaximum);
  const coffeeImage = appearance.showImage
    ? <CoffeeAsset manifest={manifest} scale={imageScale} />
    : null;
  const coffeeActivity = view.stage === "warming" && (variant !== "overview" || appearance.showImage)
    ? (
        <span className="coffee-activity" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )
    : null;
  const coffeeVisual = variant === "overview"
    ? appearance.showImage
      ? (
          <div
            className="coffee-asset__visual"
            style={{ "--cc-coffee-image-scale": imageScale / 100 } as CSSProperties}
          >
            {coffeeActivity}
            {coffeeImage}
          </div>
        )
      : null
    : (
        <>
          {coffeeImage}
          {coffeeActivity}
        </>
      );

  return (
    <article
      className={`coffee-panel coffee-panel--${variant} coffee-panel--${view.stage} coffee-panel--density-${requestedDensity} coffee-panel--image-x-${appearance.imageXStep + 3} coffee-panel--image-y-${appearance.imageYStep + 2} ${view.warning ? "surface--warning" : ""}`}
      data-testid="widget-coffee-machine"
      data-stage={view.stage}
      data-overview-copy-density={variant === "overview" ? requestedDensity : undefined}
      data-image-scale={imageScale}
      data-image-x={appearance.imageXStep}
      data-image-y={appearance.imageYStep}
    >
      <div className="coffee-panel__copy">
        <div className="coffee-panel__heading">
          <div>
            <p className="section-kicker">Дом · кофемашина</p>
            <h2>{service.title}</h2>
          </div>
          <HealthMark health={service.health} compact healthyLabel="Онлайн" />
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
            disabled={!interactive || !activeAction.enabled || !onAction || actionPending}
            onClick={() => onAction?.(service, activeAction.id)}
          >
            {actionPending ? "Подтверждаем…" : activeAction.title}
          </button>
        )}
        {activeAction && !activeAction.enabled && (
          <span className="action-hint">Управление отключено политикой панели.</span>
        )}
        {variant === "overview" && appearance.showAuthority && (
          <p className="coffee-authority">Источник: Home Assistant</p>
        )}
      </div>

      <div className="coffee-asset" data-fit={manifest.visualAsset?.fit ?? "contain"} data-image-visible={appearance.showImage}>
        {coffeeVisual}
        {appearance.showStateMarker && (
          <span className={`coffee-state-marker coffee-state-marker--${view.stage}`}>
            {view.stage === "warming" ? "Разогрев" : view.label}
          </span>
        )}
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
    live: "актуальные данные",
    cached: "последние доступные данные",
    fixture: "тестовый режим",
    stale: "данные могут быть устаревшими",
    unavailable: "нет данных"
  } as const;
  const avalar = useAvalarActions();
  const { explainAvailability } = useAccess();
  const avalarActions = avalar.actionsFor(service);

  return (
    <article className={`service-row ${service.id === "avalar-site-main" ? "service-row--production" : ""}`} data-testid={`widget-${service.id}`}>
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
          <dt>Отклик</dt>
          <dd>
            {typeof service.presentation?.latencyMs === "number"
              ? `${service.presentation.latencyMs} ms`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Проблемы</dt>
          <dd>{incidents}</dd>
        </div>
      </dl>
      <div className="service-row__actions">
        {avalarActions.map((actionId) => {
          const decision = avalar.availabilityFor(actionId);
          const canPress = Boolean(
            decision &&
            !avalar.pendingAction &&
            ["allowed", "elevation_required"].includes(decision.availability)
          );
          const locked = decision?.availability === "elevation_required";
          return (
            <button
              key={actionId}
              type="button"
              className={`service-action service-action--${decision?.availability ?? "unavailable"}`}
              disabled={!canPress}
              title={decision ? explainAvailability(decision.availability) : "Действие недоступно"}
              onClick={() => void avalar.run(service, actionId)}
            >
              {locked ? "🔒 " : ""}{avalarActionTitles[actionId]}
            </button>
          );
        })}
        {!avalarActions.length && service.actions
          .filter((action) => action.enabled)
          .map((action) => (
            <button key={action.id} type="button" disabled title="Action executor is unavailable">
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
