import type { ReactNode } from "react";
import { Icon } from "../../icons";
import { WorkZone } from "../../ShellPrimitives";
import type {
  OverviewFallbackReason,
  OverviewProjectionItem
} from "./layoutValidation";

export function TrustedOverviewWidget({ item }: { item: OverviewProjectionItem }): ReactNode {
  const definition = item.definition;
  if (!definition) {
    return <OverviewUnavailableWidget reason="unknown" />;
  }

  // This exact fixture id is only emitted by the DEV error-isolation scenario.
  // It is not a runtime configuration hook or a production action surface.
  if (import.meta.env.DEV && item.item.instanceId === "fixture.throwing") {
    throw new Error("Intentional Overview V2 fixture renderer failure");
  }

  return (
    <WorkZone className="overview-v2-widget" data-widget-type={definition.widgetType}>
      <header className="overview-v2-widget__header">
        <span className="overview-v2-widget__icon" aria-hidden="true">
          <Icon name={definition.iconKey} />
        </span>
        <div className="overview-v2-widget__heading">
          <p className="overview-v2-widget__category">{definition.category}</p>
          <h2>{definition.title}</h2>
        </div>
        <span className="overview-v2-widget__size">
          {item.sizeVariant} {item.placement.w}×{item.placement.h}
        </span>
      </header>
      {item.placement.h > 1 && (
        <p className="overview-v2-widget__copy">{definition.fixtureCopy}</p>
      )}
    </WorkZone>
  );
}

export function OverviewUnavailableWidget({
  reason
}: {
  reason: OverviewFallbackReason;
}): ReactNode {
  return (
    <WorkZone className="overview-v2-widget overview-v2-widget--unavailable" data-testid="overview-widget-unavailable">
      <header className="overview-v2-widget__header">
        <span className="overview-v2-widget__icon" aria-hidden="true">
          <Icon name="overview" />
        </span>
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
