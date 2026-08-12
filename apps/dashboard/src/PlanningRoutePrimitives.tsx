import { createPortal } from "react-dom";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { PlanningSourceStatus, PlanningSnapshot } from "@artem/contracts";
import type { PlanningReadEnvelope, PlanningReadError } from "./planningReadClient";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export function syncTimeLabel(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DEFAULT_PLANNING_TIME_ZONE
  }).format(new Date(value));
}

export function previewEnvelope<T>(
  domain: PlanningReadEnvelope<T>["domain"],
  items: T[],
  planning: PlanningSnapshot,
  limit = items.length
): PlanningReadEnvelope<T> {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain,
    generatedAt: planning.generatedAt,
    sourceStatus: planning.sourceStatus,
    lastSyncedAt: planning.lastSyncedAt,
    staleAfter: planning.staleAfter,
    items: items.slice(0, limit),
    limit,
    offset: 0,
    count: Math.min(items.length, limit),
    hasMore: false
  };
}

export function PlanningRouteHealth({
  sourceStatus,
  lastSyncedAt,
  error,
  preview,
  onRetry
}: {
  sourceStatus: PlanningSourceStatus | "unavailable";
  lastSyncedAt: string | null;
  error?: PlanningReadError | null;
  preview?: boolean;
  onRetry?: () => void;
}) {
  const errorUnavailable = Boolean(error && error.status === 503);
  const state = errorUnavailable ? "unavailable" : sourceStatus;
  const label = preview
    ? "Последние данные · краткий снимок"
    : state === "degraded"
      ? "Есть проблемы"
      : state === "stale"
        ? (syncTimeLabel(lastSyncedAt) ? `Данные от ${syncTimeLabel(lastSyncedAt)}` : "Данные устарели")
        : state === "offline" || state === "unavailable"
          ? "Актуальные данные недоступны"
          : null;
  if (!label && !error) return null;
  return (
    <section
      className={`planning-route-health planning-route-health--${state}`}
      data-testid="planning-route-health"
      data-state={state}
      aria-live="polite"
    >
      <div className="planning-route-health__copy">
        <strong>{label ?? "Планирование"}</strong>
        {preview ? (
          <p>Показан ограниченный снимок Overview. Фильтры и пагинация отключены, потому что полный маршрут недоступен.</p>
        ) : error ? (
          <p>Не удалось получить данные маршрута. Это состояние не означает, что список пуст.</p>
        ) : state === "degraded" ? (
          <p>Источник отвечает с ограничениями; свежесть данных отмечена рядом с маршрутом.</p>
        ) : state !== "current" ? (
          <p>Проверьте соединение или повторите чтение, когда Panel Agent будет доступен.</p>
        ) : null}
      </div>
      {onRetry && (
        <button type="button" className="planning-route-health__retry" onClick={onRetry}>
          Повторить
        </button>
      )}
    </section>
  );
}

export function PlanningRouteState({
  loading,
  empty,
  error,
  preview = false,
  onRetry,
  children
}: {
  loading: boolean;
  empty: boolean;
  error: boolean;
  preview?: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading) return <div className="planning-route-state" data-testid="planning-route-loading">Загружаем данные…</div>;
  if (preview && empty) {
    return (
      <section className="planning-route-state planning-route-state--error" data-testid="planning-route-preview-empty">
        <strong>В кратком снимке объектов нет</strong>
        <p>Полный список сейчас недоступен. Повторите чтение.</p>
        <button type="button" onClick={onRetry}>Повторить</button>
      </section>
    );
  }
  if (error) {
    return (
      <section className="planning-route-state planning-route-state--error" data-testid="planning-route-error">
        <strong>Не удалось получить данные</strong>
        <p>Panel Agent не подтвердил полный ответ маршрута.</p>
        <button type="button" onClick={onRetry}>Повторить</button>
      </section>
    );
  }
  if (empty) {
    return (
      <section className="planning-route-state planning-route-state--empty" data-testid="planning-route-empty">
        <strong>Здесь пока пусто</strong>
        <p>Для выбранного представления подтверждённых объектов нет.</p>
      </section>
    );
  }
  return <>{children}</>;
}

export function PaginationControls({
  page,
  hasMore,
  disabled,
  onPrevious,
  onNext
}: {
  page: number;
  hasMore: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (page === 0 && !hasMore) return null;
  return (
    <nav className="planning-pagination" aria-label="Постраничная навигация">
      <button type="button" onClick={onPrevious} disabled={disabled || page === 0}>Назад</button>
      <span>Страница {page + 1}</span>
      <button type="button" onClick={onNext} disabled={disabled || !hasMore}>Ещё</button>
    </nav>
  );
}

export function PlanningSheet({
  title,
  eyebrow,
  description,
  onClose,
  children,
  testId = "planning-sheet"
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const app = document.querySelector<HTMLElement>(".app");
    const wasInert = app?.hasAttribute("inert") ?? false;
    const previousAriaHidden = app?.getAttribute("aria-hidden") ?? null;
    app?.setAttribute("inert", "");
    app?.setAttribute("aria-hidden", "true");
    const focusFirst = () => {
      const dialog = dialogRef.current;
      const firstFocusable = dialog ? focusableElements(dialog)[0] : null;
      (firstFocusable ?? dialog ?? closeRef.current)?.focus();
    };
    focusFirst();
    const frame = window.requestAnimationFrame(focusFirst);

    return () => {
      window.cancelAnimationFrame(frame);
      if (app) {
        if (!wasInert) app.removeAttribute("inert");
        if (previousAriaHidden === null) app.removeAttribute("aria-hidden");
        else app.setAttribute("aria-hidden", previousAriaHidden);
      }
      const opener = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (opener?.isConnected) {
        opener.focus();
        window.requestAnimationFrame(() => opener.focus());
      }
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusables = focusableElements(dialogRef.current);
    if (!focusables.length) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const atDialogBoundary = active === dialogRef.current || !dialogRef.current.contains(active);
    if (event.shiftKey && (active === first || atDialogBoundary)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || atDialogBoundary)) {
      event.preventDefault();
      first.focus();
    }
  }

  const sheet = (
    <div
      className="planning-sheet-backdrop"
      data-testid={`${testId}-backdrop`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <section
        ref={dialogRef}
        className="planning-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
        data-testid={testId}
      >
        <header className="planning-sheet__header">
          <div>
            {eyebrow && <p className="section-kicker">{eyebrow}</p>}
            <h2 id={`${testId}-title`}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button ref={closeRef} className="planning-sheet__close" type="button" onClick={onClose} aria-label="Закрыть">
            Закрыть
          </button>
        </header>
        <div className="planning-sheet__body">{children}</div>
      </section>
    </div>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
