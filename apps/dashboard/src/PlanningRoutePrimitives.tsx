import { type ReactNode } from "react";
import type { PlanningCalendarSource, PlanningSourceStatus, PlanningSnapshot } from "@artem/contracts";
import type { PlanningReadEnvelope, PlanningReadError } from "./planningReadClient";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import { Sheet } from "./Sheet";
import type { PlanningModuleDefinition } from "./planningModuleRegistry";
import { RouteHeader } from "./ShellPrimitives";

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
    sources: planning.providerStatuses,
    items: items.slice(0, limit),
    limit,
    offset: 0,
    count: Math.min(items.length, limit),
    hasMore: false
  };
}

/** Shared touch-first geometry for the three Planning route surfaces. */
export function PlanningRouteFrame({
  module,
  eyebrow = "Планирование",
  description,
  sourceStatus,
  lastSyncedAt,
  sources,
  error,
  refreshing = false,
  preview,
  onRetry,
  controls,
  futureAction,
  children,
  testId
}: {
  module: PlanningModuleDefinition;
  eyebrow?: string;
  description: string;
  sourceStatus: PlanningSourceStatus | "unavailable";
  lastSyncedAt: string | null;
  sources?: PlanningCalendarSource[];
  error?: PlanningReadError | null;
  refreshing?: boolean;
  preview?: boolean;
  onRetry: () => void;
  controls: ReactNode;
  futureAction?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="planning-route-page"
      data-testid={testId}
      data-planning-module={module.id}
      data-planning-domain={module.domain}
    >
      <RouteHeader eyebrow={eyebrow} title={module.label} description={description} />
      <div className="planning-route-heading-row">
        <div className="planning-route-controls planning-route-controls--primary">{controls}</div>
        {futureAction && <div className="planning-future-action-slot" data-testid="planning-future-action-slot">{futureAction}</div>}
      </div>
      <PlanningRouteHealth
        sourceStatus={sourceStatus}
        lastSyncedAt={lastSyncedAt}
        error={error}
        refreshing={refreshing}
        preview={preview}
        onRetry={onRetry}
      />
      {sources && <PlanningSourceStrip sources={sources} />}
      <div className="planning-route-workzone">{children}</div>
    </div>
  );
}

function sourceStatusLabel(status: PlanningCalendarSource["status"]): string {
  return {
    current: "актуально",
    stale: "сохранённая копия",
    error: "недоступен",
    disabled: "отключён",
    not_configured: "не настроен"
  }[status];
}

function PlanningSourceStrip({ sources }: { sources: PlanningCalendarSource[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="planning-source-strip" data-testid="planning-source-strip" aria-label="Источники календаря">
      <span className="planning-source-strip__label">Источники</span>
      <div className="planning-source-strip__items">
        {sources.map((source) => (
          <span
            className={`planning-source-strip__item planning-source-strip__item--${source.status}`}
            data-testid="planning-source"
            data-source-id={source.id}
            key={source.id}
          >
            <strong>{source.label}</strong>
            <span>{sourceStatusLabel(source.status)}</span>
            {source.status === "stale" && source.lastSyncedAt && <span>· обновлено {syncTimeLabel(source.lastSyncedAt)}</span>}
          </span>
        ))}
      </div>
    </section>
  );
}

export function PlanningRouteHealth({
  sourceStatus,
  lastSyncedAt,
  error,
  refreshing = false,
  preview,
  onRetry
}: {
  sourceStatus: PlanningSourceStatus | "unavailable";
  lastSyncedAt: string | null;
  error?: PlanningReadError | null;
  refreshing?: boolean;
  preview?: boolean;
  onRetry?: () => void;
}) {
  const errorUnavailable = Boolean(error && error.status === 503);
  const state = errorUnavailable ? "unavailable" : sourceStatus;
  const label = preview
    ? "Последние данные · краткий снимок"
    : error
      ? "Обновление не удалось"
      : refreshing
        ? "Обновляем данные…"
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
          <p>Не удалось обновить данные маршрута. Подтверждённый список остаётся видимым; повторите чтение.</p>
        ) : refreshing ? (
          <p>Подтверждённый список остаётся видимым, пока приходит свежий ответ.</p>
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
  return (
    <Sheet
      title={title}
      eyebrow={eyebrow}
      description={description}
      onClose={onClose}
      testId={testId}
    >
      {children}
    </Sheet>
  );
}
