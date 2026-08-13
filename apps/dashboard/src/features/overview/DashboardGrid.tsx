import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { OverviewLayoutItem } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { OverviewUnavailableWidget, TrustedOverviewWidget } from "./overviewRenderers";
import {
  projectOverviewLayout,
  type OverviewProjectionItem
} from "./layoutValidation";

function useMeasuredWidth(elementRef: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1064);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;

    const update = () => setWidth(Math.max(0, element.clientWidth));
    update();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [elementRef]);

  return width;
}

function gridItemStyle(item: OverviewProjectionItem): CSSProperties {
  return {
    gridColumn: `${item.placement.x + 1} / span ${item.placement.w}`,
    gridRow: `${item.placement.y + 1} / span ${item.placement.h}`
  };
}

function renderProjectionItem(item: OverviewProjectionItem): ReactNode {
  if (item.state === "fallback") {
    return <OverviewUnavailableWidget reason={item.fallbackReason ?? "unknown"} />;
  }
  return (
    <ErrorBoundary title={item.definition?.title ?? "Виджет"}>
      <TrustedOverviewWidget item={item} />
    </ErrorBoundary>
  );
}

export function DashboardGrid({
  items,
  className
}: {
  items: readonly OverviewLayoutItem[];
  className?: string;
}): ReactNode {
  const shellRef = useRef<HTMLElement | null>(null);
  const workspaceWidth = useMeasuredWidth(shellRef);
  const projection = projectOverviewLayout(items, workspaceWidth);
  const profileStyle = {
    "--overview-grid-columns": String(projection.profile.columns),
    "--overview-grid-row-height": typeof projection.profile.rowHeight === "number"
      ? `${projection.profile.rowHeight}px`
      : "auto",
    "--overview-grid-gap": `${projection.profile.gap}px`
  } as CSSProperties;

  return (
    <section
      ref={shellRef}
      className={["overview-v2-grid-shell", className].filter(Boolean).join(" ")}
      data-testid="overview-grid"
      data-grid-profile={projection.profile.id}
      data-grid-columns={projection.profile.columns}
      data-grid-issue-count={projection.issues.length}
    >
      <p
        className="overview-v2-grid__validation"
        data-testid="overview-grid-validation"
        aria-hidden={projection.issues.length === 0}
      >
        {projection.issues.length > 0 ? `Сетка обработала ${projection.issues.length} ограничений безопасно.` : " "}
      </p>
      <div className="overview-v2-grid" style={profileStyle}>
        {projection.items.map((item, index) => (
          <div
            className="overview-v2-grid-item"
            key={`${item.item.instanceId}-${index}`}
            data-testid="overview-grid-item"
            data-instance-id={item.item.instanceId}
            data-widget-type={item.item.widgetType}
            data-grid-state={item.state}
            data-grid-x={item.placement.x}
            data-grid-y={item.placement.y}
            data-grid-w={item.placement.w}
            data-grid-h={item.placement.h}
            style={gridItemStyle(item)}
          >
            {renderProjectionItem(item)}
          </div>
        ))}
      </div>
    </section>
  );
}
