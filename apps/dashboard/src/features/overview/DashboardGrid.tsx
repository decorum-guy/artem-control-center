import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { OverviewLayoutItem } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { OverviewUnavailableWidget, TrustedOverviewWidget } from "./overviewRenderers";
import type { OverviewRuntimeContext } from "./overviewRuntime";
import {
  projectOverviewLayout,
  type OverviewProjectionItem
} from "./layoutValidation";
import { EditableWidgetFrame } from "./EditableWidgetFrame";

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

function renderProjectionItem(
  item: OverviewProjectionItem,
  runtime: OverviewRuntimeContext
): ReactNode {
  if (item.state === "fallback") {
    return <OverviewUnavailableWidget reason={item.fallbackReason ?? "unknown"} />;
  }
  return (
    <ErrorBoundary title={item.definition?.title ?? "Виджет"}>
      <TrustedOverviewWidget item={item} runtime={runtime} />
    </ErrorBoundary>
  );
}

export function DashboardGrid({
  items,
  className,
  runtime,
  editMode = false,
  selectedInstanceId,
  editingDisabled = false,
  onSelect,
  onMove,
  onResize,
  onRemove,
  onOpenAppearance,
  onAnnounce
}: {
  items: readonly OverviewLayoutItem[];
  className?: string;
  runtime: OverviewRuntimeContext;
  editMode?: boolean;
  selectedInstanceId?: string | null;
  editingDisabled?: boolean;
  onSelect?: (instanceId: string) => void;
  onMove?: (instanceId: string, dx: number, dy: number) => void;
  onResize?: (instanceId: string, sizeVariant: string) => void;
  onRemove?: (instanceId: string) => void;
  onOpenAppearance?: (instanceId: string) => void;
  onAnnounce?: (message: string) => void;
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
      {projection.issues.length > 0 && (
        <p
          className="overview-v2-grid__validation"
          data-testid="overview-grid-validation"
        >
          Сетка обработала {projection.issues.length} ограничений безопасно.
        </p>
      )}
      {editMode && <p className="overview-edit-live-message" aria-live="polite" data-testid="overview-edit-live-message" />}
      <div className="overview-v2-grid" style={profileStyle}>
        {projection.items.map((item, index) => (
          <div
            className="overview-v2-grid-item"
            key={`${item.item.instanceId}-${index}`}
            data-testid="overview-grid-item"
            data-instance-id={item.item.instanceId}
            data-widget-type={item.item.widgetType}
            data-grid-state={item.state}
            data-size-variant={item.sizeVariant ?? ""}
            data-grid-x={item.placement.x}
            data-grid-y={item.placement.y}
            data-grid-w={item.placement.w}
            data-grid-h={item.placement.h}
            style={gridItemStyle(item)}
          >
            {editMode && onSelect && onMove && onResize && onRemove && onOpenAppearance && onAnnounce ? (
              <EditableWidgetFrame
                item={item.item}
                selected={selectedInstanceId === item.item.instanceId}
                disabled={editingDisabled}
                onSelect={() => onSelect(item.item.instanceId)}
                onMove={(dx, dy) => onMove(item.item.instanceId, dx, dy)}
                onResize={(sizeVariant) => onResize(item.item.instanceId, sizeVariant)}
                onRemove={() => onRemove(item.item.instanceId)}
                onOpenAppearance={() => onOpenAppearance(item.item.instanceId)}
                onAnnounce={onAnnounce}
              >
                {renderProjectionItem(item, runtime)}
              </EditableWidgetFrame>
            ) : renderProjectionItem(item, runtime)}
          </div>
        ))}
      </div>
    </section>
  );
}
