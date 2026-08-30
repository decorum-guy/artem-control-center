import { type ReactNode } from "react";
import type { InterfaceCopyPageKey, PlanningCalendarSource, PlanningSourceStatus, PlanningSnapshot } from "@artem/contracts";
import type { PlanningReadEnvelope, PlanningReadError } from "./planningReadClient";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import { Sheet } from "./Sheet";
import type { PlanningModuleDefinition } from "./planningModuleRegistry";
import { RouteHeader } from "./ShellPrimitives";
import { useOwnerWarningDwell } from "./planningWarningDwell";
import { pageSubtitleField, pageTitleField, useInterfaceCopy } from "./interfaceCopy";

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
  sourceStatus,
  lastSyncedAt,
  sources,
  error,
  loading = false,
  hasConfirmedContent = false,
  refreshing = false,
  suppressRefreshWithConfirmedContent = false,
  preview,
  onRetry,
  controls,
  futureAction,
  children,
  testId
}: {
  module: PlanningModuleDefinition;
  eyebrow?: string;
  sourceStatus: PlanningSourceStatus | "unavailable";
  lastSyncedAt: string | null;
  sources?: PlanningCalendarSource[];
  error?: PlanningReadError | null;
  /** A started target read is neutral; absence of an envelope is not an outage. */
  loading?: boolean;
  hasConfirmedContent?: boolean;
  refreshing?: boolean;
  /** Calendar uses a delayed fixed overlay; other Planning routes retain their established in-flow cue. */
  suppressRefreshWithConfirmedContent?: boolean;
  preview?: boolean;
  onRetry: () => void;
  controls: ReactNode;
  futureAction?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  const { copy } = useInterfaceCopy();
  const pageKey: InterfaceCopyPageKey = module.domain === "calendar"
    ? "calendar"
    : module.domain === "tasks"
      ? "tasks"
      : "reminders";
  return (
    <div
      className="planning-route-page"
      data-testid={testId}
      data-planning-module={module.id}
      data-planning-domain={module.domain}
    >
      <RouteHeader eyebrow={eyebrow} title={copy(pageTitleField(pageKey))} description={copy(pageSubtitleField(pageKey))} />
      <div className="planning-route-heading-row">
        <div className={`planning-route-controls planning-route-controls--primary${module.domain === "calendar" ? " planning-route-controls--calendar" : ""}`}>{controls}</div>
        {futureAction && <div className="planning-future-action-slot" data-testid="planning-future-action-slot">{futureAction}</div>}
      </div>
      <PlanningRouteHealth
        sourceStatus={sourceStatus}
        lastSyncedAt={lastSyncedAt}
        error={error}
        loading={loading}
        hasConfirmedContent={hasConfirmedContent}
        refreshing={refreshing}
        suppressRefreshWithConfirmedContent={suppressRefreshWithConfirmedContent}
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
        {sources.map((source) => <PlanningSourceItem source={source} key={source.id} />)}
      </div>
    </section>
  );
}

function PlanningSourceItem({ source }: { source: PlanningCalendarSource }) {
  const rawWarning = source.status === "current" ? null : source.status;
  const visibleWarning = useOwnerWarningDwell(rawWarning);
  const displayStatus = source.status === "current" ? (visibleWarning ?? "current") : visibleWarning;
  return (
    <span
      className={`planning-source-strip__item planning-source-strip__item--${displayStatus ?? "pending"}`}
      data-testid="planning-source"
      data-source-id={source.id}
      data-raw-source-status={source.status}
      data-warning-visible={displayStatus && displayStatus !== "current" ? "true" : "false"}
    >
      <strong>{source.label}</strong>
      {displayStatus && <span>{sourceStatusLabel(displayStatus)}</span>}
      {displayStatus === "stale" && source.lastSyncedAt && <span>· обновлено {syncTimeLabel(source.lastSyncedAt)}</span>}
    </span>
  );
}

export function PlanningRouteHealth({
  sourceStatus,
  lastSyncedAt,
  error,
  loading = false,
  hasConfirmedContent = false,
  refreshing = false,
  suppressRefreshWithConfirmedContent = false,
  preview,
  onRetry
}: {
  sourceStatus: PlanningSourceStatus | "unavailable";
  lastSyncedAt: string | null;
  error?: PlanningReadError | null;
  loading?: boolean;
  hasConfirmedContent?: boolean;
  refreshing?: boolean;
  suppressRefreshWithConfirmedContent?: boolean;
  preview?: boolean;
  onRetry?: () => void;
}) {
  const errorUnavailable = Boolean(error && error.status === 503);
  const rawWarning = loading || preview ? null : errorUnavailable ? "unavailable" : error ? "error" : sourceStatus === "current" ? null : sourceStatus;
  const visibleWarning = useOwnerWarningDwell(rawWarning);
  const warningVisibleImmediately = !loading && (preview || !hasConfirmedContent);
  const warning = warningVisibleImmediately ? rawWarning : visibleWarning;
  const visibleError = Boolean(error) && (warningVisibleImmediately || visibleWarning !== null);
  const state = visibleError
    ? (errorUnavailable ? "unavailable" : "degraded")
    : warning && warning !== "error"
      ? warning
      : warningVisibleImmediately
        ? (errorUnavailable ? "unavailable" : sourceStatus)
        : "current";
  const label = preview
    ? "Последние доступные данные"
    : visibleError && hasConfirmedContent
      ? "Не удалось обновить данные"
      : visibleError
        ? "Данные недоступны"
        : refreshing && (!hasConfirmedContent || !suppressRefreshWithConfirmedContent)
          ? "Обновляем…"
          : state === "degraded"
            ? "Есть проблемы"
            : state === "stale"
              ? "Данные могут быть устаревшими"
              : state === "offline" || state === "unavailable"
                ? "Данные недоступны"
                : null;
  // A transient read error must stay visually silent until warning dwell elapses;
  // otherwise an empty in-flow section itself causes the Calendar to jump.
  if (!label && !warning) return null;
  return (
    <section
      className={`planning-route-health planning-route-health--${state}`}
      data-testid="planning-route-health"
      data-state={state}
      data-has-confirmed-content={hasConfirmedContent ? "true" : "false"}
      data-raw-warning={rawWarning ?? "none"}
      data-visible-warning={visibleWarning ?? "none"}
      aria-live="polite"
    >
      <div className="planning-route-health__copy">
        <strong>{label ?? "Планирование"}</strong>
        {preview ? (
          <p>Показаны последние доступные данные. Они могут быть неполными.</p>
        ) : visibleError && hasConfirmedContent ? (
          <p>Показаны последние доступные данные. Повторите попытку.</p>
        ) : visibleError ? (
          <p>Повторите попытку.</p>
        ) : refreshing && (!hasConfirmedContent || !suppressRefreshWithConfirmedContent) ? (
          <p>Показаны последние доступные данные, пока выполняется обновление.</p>
        ) : state === "degraded" ? (
          <p>Некоторые данные могут быть недоступны. Проверьте состояние ниже.</p>
        ) : state === "stale" ? (
          <p>{syncTimeLabel(lastSyncedAt) ? `Последнее обновление: ${syncTimeLabel(lastSyncedAt)}` : "Повторите попытку."}</p>
        ) : state !== "current" ? (
          <p>Проверьте соединение и повторите попытку.</p>
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
        <strong>Нет доступных объектов</strong>
        <p>Повторите попытку.</p>
        <button type="button" onClick={onRetry}>Повторить</button>
      </section>
    );
  }
  if (error) {
    return (
      <section className="planning-route-state planning-route-state--error" data-testid="planning-route-error">
        <strong>Данные недоступны</strong>
        <p>Повторите попытку.</p>
        <button type="button" onClick={onRetry}>Повторить</button>
      </section>
    );
  }
  if (empty) {
    return (
      <section className="planning-route-state planning-route-state--empty" data-testid="planning-route-empty">
        <strong>Здесь пока пусто</strong>
        <p>Для выбранного представления пока ничего нет.</p>
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
