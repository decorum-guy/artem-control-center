import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { OverviewLayoutItem } from "@artem/contracts";
import { Icon } from "../../icons";
import { hasAppearanceControls } from "./appearanceConfig";
import { getOverviewWidgetDefinition, type OverviewWidgetDefinition } from "./overviewRegistry";

interface DragSession {
  kind: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  originW: number;
  originH: number;
}

function closestVariant(definition: OverviewWidgetDefinition, width: number, height: number): string {
  return Object.entries(definition.sizes)
    .filter(([, size]) => Boolean(size))
    .map(([variant, size]) => ({ variant, size: size! }))
    .sort((left, right) =>
      Math.abs(left.size.w - width) + Math.abs(left.size.h - height) -
      (Math.abs(right.size.w - width) + Math.abs(right.size.h - height))
    )[0]?.variant ?? definition.defaultSizeVariant;
}

export function EditableWidgetFrame({
  item,
  children,
  selected,
  disabled,
  onSelect,
  onMove,
  onResize,
  onRemove,
  onOpenAppearance,
  onAnnounce
}: {
  item: OverviewLayoutItem;
  children: ReactNode;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onMove: (dx: number, dy: number) => void;
  onResize: (sizeVariant: string) => void;
  onRemove: () => void;
  onOpenAppearance: () => void;
  onAnnounce: (message: string) => void;
}): ReactNode {
  const definition = getOverviewWidgetDefinition(item.widgetType);
  const frameRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<{ dx: number; dy: number; width: number; height: number; invalid: boolean } | null>(null);
  const appearanceAvailable = hasAppearanceControls(item.widgetType);
  const sizes = definition ? Object.entries(definition.sizes).filter(([, size]) => Boolean(size)) as [string, { w: number; h: number }][] : [];

  function unitSize(): { x: number; y: number } {
    const frame = frameRef.current?.closest(".overview-v2-grid") as HTMLElement | null;
    if (!frame) return { x: 80, y: 60 };
    const style = getComputedStyle(frame);
    const columns = Number(frame.parentElement?.getAttribute("data-grid-columns") ?? 12);
    const gap = Number.parseFloat(style.columnGap || style.gap || "12") || 12;
    return {
      x: (frame.getBoundingClientRect().width - gap * (columns - 1)) / columns + gap,
      y: Number.parseFloat(style.gridAutoRows) || 60
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, kind: "move" | "resize"): void {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    event.currentTarget.setPointerCapture(event.pointerId);
    sessionRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      originW: item.placement.w,
      originH: item.placement.h
    };
    setPreview({ dx: 0, dy: 0, width: item.placement.w, height: item.placement.h, invalid: false });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const units = unitSize();
    const dx = Math.round((event.clientX - session.startX) / Math.max(1, units.x));
    const dy = Math.round((event.clientY - session.startY) / Math.max(1, units.y));
    session.dx = dx;
    session.dy = dy;
    const width = session.kind === "resize" ? Math.max(1, session.originW + dx) : session.originW;
    const height = session.kind === "resize" ? Math.max(1, session.originH + dy) : session.originH;
    const invalid = session.kind === "move"
      ? item.placement.x + dx < 0 || item.placement.x + dx + item.placement.w > 12 || item.placement.y + dy < 0
      : item.placement.x + width > 12 || height > 8;
    setPreview({ dx, dy, width, height, invalid });
  }

  function finishPointer(event: ReactPointerEvent<HTMLButtonElement>): void {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    sessionRef.current = null;
    const currentPreview = preview;
    setPreview(null);
    if (!currentPreview || currentPreview.invalid || (session.dx === 0 && session.dy === 0)) {
      if (currentPreview?.invalid) onAnnounce("Это положение или размер выходит за пределы сетки. Виджет возвращён на исходное место.");
      return;
    }
    if (session.kind === "move") {
      onMove(session.dx, session.dy);
      return;
    }
    if (!definition) return;
    onResize(closestVariant(definition, currentPreview.width, currentPreview.height));
  }

  const previewUnits = preview && !preview.invalid ? unitSize() : null;
  const previewStyle = preview && !preview.invalid && previewUnits
    ? {
        width: `${(preview.width / item.placement.w) * 100}%`,
        height: `${(preview.height / item.placement.h) * 100}%`,
        transform: `translate(${preview.dx * previewUnits.x}px, ${preview.dy * previewUnits.y}px)`
      }
    : undefined;

  return (
    <div
      ref={frameRef}
      className={`overview-edit-frame${selected ? " overview-edit-frame--selected" : ""}${preview ? " overview-edit-frame--dragging" : ""}${preview?.invalid ? " overview-edit-frame--invalid" : ""}`}
      data-testid="overview-edit-frame"
      data-instance-id={item.instanceId}
      data-selected={selected}
      style={previewStyle}
      onPointerDown={onSelect}
    >
      <button
        type="button"
        className="overview-edit-frame__handle overview-edit-frame__drag-handle"
        aria-label={`Переместить ${definition?.title ?? item.widgetType}`}
        disabled={disabled}
        onPointerDown={(event) => onPointerDown(event, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      >
        <Icon name="grip" />
      </button>
      <div className="overview-edit-frame__actions">
        {appearanceAvailable && (
          <button type="button" className="overview-edit-frame__handle" aria-label="Настройки виджета" disabled={disabled} onClick={(event) => { event.stopPropagation(); onSelect(); onOpenAppearance(); }}>
            <Icon name="settings" />
          </button>
        )}
        <button type="button" className="overview-edit-frame__handle overview-edit-frame__remove" aria-label={`Убрать ${definition?.title ?? item.widgetType}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); onRemove(); }}>
          <Icon name="close" />
        </button>
      </div>
      <div
        className="overview-edit-frame__body"
        onClickCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDownCapture={(event) => {
          if (event.target !== event.currentTarget) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        aria-label="Содержимое виджета доступно только для просмотра в режиме редактирования"
      >
        {children}
      </div>
      <button
        type="button"
        className="overview-edit-frame__handle overview-edit-frame__menu-toggle"
        aria-label="Меню перемещения виджета"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); setMenuOpen((current) => !current); }}
      >
        ⋯
      </button>
      {definition && (
        <span className="overview-edit-frame__size" aria-label={`Размер ${item.placement.w} на ${item.placement.h}`}>
          {item.placement.w} × {item.placement.h}
        </span>
      )}
      {definition && sizes.length > 1 && (
        <button
          type="button"
          className="overview-edit-frame__resize-handle"
          aria-label={`Изменить размер ${definition.title}`}
          disabled={disabled}
          onPointerDown={(event) => onPointerDown(event, "resize")}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
        >
          <span aria-hidden="true">↘</span>
        </button>
      )}
      {menuOpen && (
        <div className="overview-edit-frame__menu" role="menu" aria-label="Альтернативное управление виджетом">
          <button type="button" role="menuitem" onClick={() => { onMove(0, -1); setMenuOpen(false); }}>Вверх</button>
          <button type="button" role="menuitem" onClick={() => { onMove(0, 1); setMenuOpen(false); }}>Вниз</button>
          <button type="button" role="menuitem" onClick={() => { onMove(-1, 0); setMenuOpen(false); }}>Влево</button>
          <button type="button" role="menuitem" onClick={() => { onMove(1, 0); setMenuOpen(false); }}>Вправо</button>
          {sizes.map(([variant, size]) => (
            <button key={variant} type="button" role="menuitem" onClick={() => { onResize(variant); setMenuOpen(false); }}>
              Размер {size.w} × {size.h}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
