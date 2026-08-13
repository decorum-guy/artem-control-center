import type { ReactNode } from "react";
import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import { ConnectivityRecoveryButton, useConnectivityActions } from "../../ConnectivityActions";
import { Icon } from "../../icons";
import { StatusText, WorkZone } from "../../ShellPrimitives";
import { resolveManifest, servicesByPriority } from "../../registry";
import { CoffeeWidget } from "../../widgets";
import { PlanningOverviewCard } from "../../PlanningOverviewCard";
import { RogG703CompactControl } from "../../RogG703Controls";
import type { OverviewRuntimeContext } from "./overviewRuntime";
import type {
  OverviewFallbackReason,
  OverviewProjectionItem
} from "./layoutValidation";

function findServiceByManifest(services: readonly ServiceSnapshot[], manifestId: string): ServiceSnapshot | null {
  return services.find((service) => resolveManifest(service).id === manifestId) ?? null;
}

function findRogService(services: readonly ServiceSnapshot[]): ServiceSnapshot | null {
  return services.find((service) => service.id === "rog_g703gi" || service.dataContract === "system.rog-g703.v1") ?? null;
}

function OverviewRuntimeUnavailable({
  title,
  detail,
  testId
}: {
  title: string;
  detail: string;
  testId?: string;
}): ReactNode {
  return (
    <WorkZone className="overview-v2-real-widget overview-v2-runtime-unavailable" data-testid={testId}>
      <div className="overview-v2-real-widget__heading">
        <p className="overview-v2-real-widget__eyebrow">Состояние</p>
        <h2>{title}</h2>
      </div>
      <p>{detail}</p>
    </WorkZone>
  );
}

function renderCoffee(runtime: OverviewRuntimeContext): ReactNode {
  const service = findServiceByManifest(runtime.snapshot.services, "home.coffee-machine");
  if (!service) {
    return (
      <OverviewRuntimeUnavailable
        title="Кофемашина"
        detail="Данные Home Assistant пока недоступны. Физическое состояние не предполагается."
        testId="overview-coffee-unavailable"
      />
    );
  }

  const manifest = resolveManifest(service);
  const overviewManifest = manifest.visualAsset
    ? {
        ...manifest,
        visualAsset: {
          ...manifest.visualAsset,
          sourcePath: "./assets/widgets/coffee-machine-overview.webp"
        }
      }
    : manifest;

  return (
    <CoffeeWidget
      service={service}
      generatedAt={runtime.snapshot.generatedAt}
      manifest={overviewManifest}
      variant="overview"
      onAction={runtime.onCoffeeAction}
      actionPending={runtime.coffeeActionPending}
    />
  );
}

function renderPlanning(runtime: OverviewRuntimeContext): ReactNode {
  return (
    <PlanningOverviewCard
      planning={runtime.snapshot.planning}
      onNavigate={runtime.onNavigate}
    />
  );
}

function quickDevices(snapshot: DashboardSnapshot): ServiceSnapshot[] {
  return servicesByPriority(snapshot.services)
    .filter((service) => service.presentation?.overview === "quick-control")
    .slice(0, 2);
}

function renderHome(runtime: OverviewRuntimeContext): ReactNode {
  const devices = quickDevices(runtime.snapshot);
  const stateCopy = (service: ServiceSnapshot): string => {
    const stage = (service.data as { stage?: unknown }).stage;
    return stage === "on" ? "Включён" : stage === "off" ? "Выключен" : "Недоступен";
  };
  const stateTone = (service: ServiceSnapshot): "success" | "warning" | "offline" | "unavailable" => {
    if (service.health === "healthy") return "success";
    if (service.health === "degraded" || service.health === "stale") return "warning";
    if (service.health === "offline") return "offline";
    return "unavailable";
  };
  return (
    <WorkZone className="overview-v2-real-widget overview-home-widget" data-testid="overview-home-widget">
      <header className="overview-v2-real-widget__header">
        <span className="overview-v2-real-widget__icon" aria-hidden="true"><Icon name="home" /></span>
        <div className="overview-v2-real-widget__heading">
          <p className="overview-v2-real-widget__eyebrow">Дом</p>
          <h2>Быстрые действия</h2>
        </div>
      </header>
      <div className="overview-home-widget__cells">
        {devices.length ? devices.map((service) => (
          <button
            className="overview-home-widget__cell"
            key={service.id}
            type="button"
            data-testid={`overview-home-device-${service.id}`}
            onClick={() => runtime.onNavigate("/home")}
            aria-label={`${service.title}. ${stateCopy(service)}. Открыть Дом`}
          >
            <span className="overview-home-widget__cell-kicker">Домашнее устройство</span>
            <strong>{service.title}</strong>
            <StatusText label={stateCopy(service)} tone={stateTone(service)} className="overview-home-widget__cell-state" />
          </button>
        )) : (
          <p className="overview-v2-real-widget__empty">Нет доступных устройств для быстрого просмотра.</p>
        )}
      </div>
    </WorkZone>
  );
}

function liveService(service: ServiceSnapshot | undefined): boolean {
  return Boolean(service && service.health === "healthy" && service.source === "live");
}

function OverviewHealthWidget(runtime: OverviewRuntimeContext): ReactNode {
  const services = servicesByPriority(runtime.snapshot.services);
  const catalog = services.filter((service) =>
    service.presentation?.category !== "home-device" && service.id !== "rog_g703gi"
  );
  const healthyCount = catalog.filter((service) => service.health === "healthy").length;
  const attention = catalog.filter((service) => service.health !== "healthy");
  const incident = attention[0] ?? null;
  const backups = services.filter((service) => service.dataContract.startsWith("backup."));
  const homeAssistant = services.find((service) => service.id === "home-assistant");
  const alice = services.find((service) => service.id === "alice-tg-bot");
  const connectivity = useConnectivityActions();
  const connectivityDegraded = !liveService(homeAssistant) || !liveService(alice);
  const backupCopy = backups[0]
    ? backups[0].presentation?.freshnessLabel
      ? `Резервные копии: ${backups[0].presentation.freshnessLabel}`
      : `Резервные копии: ${backups[0].summary}`
    : "Резервные копии: источник не подключён";

  return (
    <WorkZone
      className={`overview-v2-real-widget overview-health-widget${attention.length ? " overview-health-widget--attention" : ""}`}
      data-testid="overview-health-widget"
      aria-label="Состояние сервисов и резервных копий"
    >
      <header className="overview-v2-real-widget__header">
        <span className="overview-v2-real-widget__icon" aria-hidden="true"><Icon name="services" /></span>
        <div className="overview-v2-real-widget__heading">
          <p className="overview-v2-real-widget__eyebrow">Состояние</p>
          <h2>Сервисы и backup</h2>
        </div>
      </header>
      <div className="overview-health-widget__aggregate">
        <StatusText
          label={`${healthyCount} в норме · ${attention.length} требуют внимания`}
          tone={attention.length ? "warning" : "success"}
        />
      </div>
      <p className="overview-health-widget__incident">
        {incident ? `${incident.title}: ${incident.summary}` : "Критичных инцидентов нет."}
      </p>
      <footer className="overview-health-widget__footer">
        <span>{backupCopy}</span>
        {connectivityDegraded && connectivity.available && (
          <ConnectivityRecoveryButton degraded className="overview-health-widget__recovery" />
        )}
      </footer>
      {connectivityDegraded && !connectivity.available && (
        <span className="overview-health-widget__recovery-state">Recovery API недоступен</span>
      )}
    </WorkZone>
  );
}

function renderStructuralPlaceholder(item: OverviewProjectionItem): ReactNode {
  const definition = item.definition;
  if (!definition) return <OverviewUnavailableWidget reason="unknown" />;
  return (
    <WorkZone className="overview-v2-widget overview-v2-widget--placeholder" data-widget-type={definition.widgetType}>
      <header className="overview-v2-widget__header">
        <span className="overview-v2-widget__icon" aria-hidden="true"><Icon name={definition.iconKey} /></span>
        <div className="overview-v2-widget__heading">
          <p className="overview-v2-widget__category">{definition.category}</p>
          <h2>{definition.title}</h2>
        </div>
        <span className="overview-v2-widget__size">{item.sizeVariant} {item.placement.w}×{item.placement.h}</span>
      </header>
      {item.placement.h > 1 && <p className="overview-v2-widget__copy">{definition.fixtureCopy}</p>}
    </WorkZone>
  );
}

function renderTrustedWidget(item: OverviewProjectionItem, runtime: OverviewRuntimeContext): ReactNode {
  switch (item.item.widgetType) {
    case "system.rog-g703-operational": {
      const service = findRogService(runtime.snapshot.services);
      return service
        ? <RogG703CompactControl service={service} />
        : (
          <WorkZone className="overview-v2-real-widget overview-rog-widget overview-rog-widget--unavailable" data-testid="overview-rog-g703-unavailable">
            <span className="overview-rog-widget__icon" aria-hidden="true"><Icon name="system" /></span>
            <div className="overview-rog-widget__identity">
              <p className="overview-v2-real-widget__eyebrow">Система · Windows</p>
              <h2>ASUS ROG G703GI</h2>
            </div>
            <StatusText label="Недоступен" tone="unavailable" className="overview-rog-widget__status" />
            <span className="overview-rog-widget__freshness">Состояние интеграции не получено</span>
            <span className="overview-rog-widget__unavailable">Недоступен</span>
          </WorkZone>
        );
    }
    case "home.coffee-machine":
      return renderCoffee(runtime);
    case "planning.summary":
      return renderPlanning(runtime);
    case "home.quick-actions":
      return renderHome(runtime);
    case "system.health-summary":
      return <OverviewHealthWidget {...runtime} />;
    default:
      return renderStructuralPlaceholder(item);
  }
}

export function TrustedOverviewWidget({
  item,
  runtime
}: {
  item: OverviewProjectionItem;
  runtime: OverviewRuntimeContext;
}): ReactNode {
  // This exact fixture id is only emitted by the DEV error-isolation scenario.
  // It is not a runtime configuration hook or a production action surface.
  if (import.meta.env.DEV && item.item.instanceId === "fixture.throwing") {
    throw new Error("Intentional Overview V2 fixture renderer failure");
  }
  return renderTrustedWidget(item, runtime);
}

export function OverviewUnavailableWidget({
  reason
}: {
  reason: OverviewFallbackReason;
}): ReactNode {
  return (
    <WorkZone className="overview-v2-widget overview-v2-widget--unavailable" data-testid="overview-widget-unavailable">
      <header className="overview-v2-widget__header">
        <span className="overview-v2-widget__icon" aria-hidden="true"><Icon name="overview" /></span>
        <div className="overview-v2-widget__heading">
          <p className="overview-v2-widget__category">Недоступно</p>
          <h2>Виджет недоступен</h2>
        </div>
      </header>
      <p className="overview-v2-widget__copy">
        {reason === "unknown"
          ? "Рендерер не зарегистрирован в локальном реестре."
          : reason === "unsupported-profile"
            ? "Для этого профиля нет безопасного размера."
            : "Конфигурация расположения некорректна."}
      </p>
    </WorkZone>
  );
}
