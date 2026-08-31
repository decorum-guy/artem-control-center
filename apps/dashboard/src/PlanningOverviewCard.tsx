import { useEffect, useState, type CSSProperties } from "react";
import type { PlanningCalendarSourceCalendar, PlanningDomainHealthStatus, PlanningHealthIssue, PlanningProviderFreshnessStatus, PlanningSnapshot } from "@artem/contracts";
import type { ShellNavigationTarget } from "./Shell";
import { Sheet } from "./Sheet";
import { calendarLocalDateForEvent, calendarNavigationForDate, type CalendarNavigationTarget } from "./calendarNavigation";
import {
  formatCalendarEventDate,
  formatCalendarEventTime,
  formatOverdueTaskCount,
  formatReminderDueLabel,
  formatReminderExactTime,
  formatTaskDueLabel,
  planningHealthPresentation,
  planningDomainStatus,
  displayPlanningOverviewItems,
  planningOverviewRowLimit,
  planningOverviewSummary
} from "./planningOverview";
import { planningRemindersRouteEnabled } from "./planningRouteConfig";
import { calendarEventColor } from "./planningRouteLogic";
import { useCalendarDisplayPreferences } from "./CalendarDisplayPreferences";

type PlanningNavigationTarget = Extract<ShellNavigationTarget, "/calendar" | "/tasks" | "/reminders"> | CalendarNavigationTarget;

function usePlanningPresentationNow(sourceStatus: PlanningSnapshot["sourceStatus"] | "unavailable") {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (sourceStatus !== "current") return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [sourceStatus]);

  return now;
}

function PlanningRow({
  testId,
  label,
  title,
  meta,
  time,
  dateTime,
  onClick,
  ariaLabel,
  empty = false,
  className = "",
  dataState = "current",
  indicatorColor,
  indicatorTestId
}: {
  testId: string;
  label: string;
  title: string;
  meta?: string;
  time?: string;
  dateTime?: string;
  onClick?: () => void;
  ariaLabel?: string;
  empty?: boolean;
  className?: string;
  dataState?: PlanningDomainHealthStatus;
  indicatorColor?: string;
  indicatorTestId?: string;
}) {
  const indicator = indicatorColor ? (
    <span
      className="planning-row__source-marker"
      data-testid={indicatorTestId}
      data-color={indicatorColor}
      style={{ backgroundColor: indicatorColor } as CSSProperties}
      aria-hidden="true"
    />
  ) : null;
  const content = (
    <>
      <div className="planning-row__copy">
        <span className="planning-row__label">{label}</span>
        <strong className={empty ? "planning-row__title planning-row__title--empty" : "planning-row__title"}>
          {title}
        </strong>
      </div>
      {(meta || time) && (
        <div className="planning-row__meta">
          {meta && <span>{meta}</span>}
          {time && <time dateTime={dateTime}>{time}</time>}
        </div>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        className={`planning-row planning-row--interactive ${className}`.trim()}
        data-testid={testId}
        data-planning-state={dataState}
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {indicator}
        {content}
      </button>
    );
  }

  return (
    <div className={`planning-row ${className}`.trim()} data-testid={testId} data-planning-state={dataState}>
      {indicator}
      {content}
    </div>
  );
}

function unavailableRowTitle(
  emptyTitle: string,
  domainStatus: PlanningDomainHealthStatus
): string {
  if (domainStatus === "unavailable") return "Данные недоступны";
  if (domainStatus === "stale") return "Данные могут быть устаревшими";
  return emptyTitle;
}

type PlanningHealthProblem = {
  provider: string;
  kind: "native" | "external";
  providerLabel: string;
  providerStatus: string | null;
  calendars: Array<{ label: string; status: string }>;
};

const MAX_HEALTH_PROVIDERS = 3;
const MAX_HEALTH_CALENDARS = 2;

const healthIssueLabels: Record<PlanningHealthIssue["source"], string> = {
  reminders: "Напоминания",
  tasks: "Задачи",
  calendar: "Календарь",
  projects: "Проекты",
  "planning-status": "Планирование"
};

function ownerFacingHealthIssue(status: PlanningHealthIssue["status"]): string | null {
  switch (status) {
    case "degraded": return "Не удалось обновить данные";
    case "stale": return "Данные могут быть устаревшими";
    case "unavailable": return "Данные недоступны";
    case "retrying": return null;
  }
}

function ownerFacingFreshness(status: PlanningProviderFreshnessStatus): string | null {
  switch (status) {
    case "stale":
      return "Данные могут быть устаревшими";
    case "error":
      return "Не удалось обновить данные";
    case "current":
    case "disabled":
    case "not_configured":
      return null;
  }
}

function abnormalCalendars(calendars: PlanningCalendarSourceCalendar[]): Array<{ label: string; status: string }> {
  return calendars
    .filter((calendar) => calendar.enabled)
    .flatMap((calendar) => {
      const status = ownerFacingFreshness(calendar.status);
      return status ? [{ label: calendar.label, status }] : [];
    })
    .slice(0, MAX_HEALTH_CALENDARS);
}

function planningHealthProblems(planning: PlanningSnapshot): PlanningHealthProblem[] {
  const issueProblems = (planning.health?.issues ?? [])
    .filter((issue) => issue.status !== "retrying")
    .map((issue) => ({
      provider: issue.source,
      kind: "native" as const,
      providerLabel: healthIssueLabels[issue.source],
      providerStatus: ownerFacingHealthIssue(issue.status),
      calendars: []
    }));
  const providerProblems = planning.providerStatuses
    .filter((provider) => provider.configured)
    .flatMap((provider) => {
      const providerStatus = ownerFacingFreshness(provider.status);
      const calendars = abnormalCalendars(provider.calendars);
      return providerStatus || calendars.length > 0
        ? [{ provider: provider.provider, kind: provider.kind, providerLabel: provider.label, providerStatus, calendars }]
        : [];
    });
  return [...issueProblems, ...providerProblems].slice(0, MAX_HEALTH_PROVIDERS);
}

function planningHealthDetail(health: ReturnType<typeof planningHealthPresentation>): { title: string; description: string; detail: string } {
  const retainedData = health.hasLastGoodData
    ? "Показаны последние доступные данные."
    : "Актуальные данные пока недоступны.";
  switch (health.state) {
    case "degraded":
      return { title: "Есть проблемы", description: "Не удалось обновить часть данных", detail: retainedData };
    case "stale":
      return { title: "Данные могут быть устаревшими", description: "Показана последняя доступная информация", detail: retainedData };
    case "offline":
      return { title: "Данные недоступны", description: "Подключение к планированию сейчас недоступно", detail: retainedData };
    case "unavailable":
      return { title: "Планирование недоступно", description: "Не удалось получить данные планирования", detail: retainedData };
    case "current":
      return { title: "Планирование", description: "Данные актуальны", detail: "" };
  }
}

function PlanningHealthAction({
  planning,
  health,
  onNavigate
}: {
  planning?: PlanningSnapshot | null;
  health: ReturnType<typeof planningHealthPresentation>;
  onNavigate: (target: PlanningNavigationTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  if (health.state === "current" || !health.label) return null;
  const detail = planningHealthDetail(health);
  const problems = planning ? planningHealthProblems(planning) : [];
  const sourceCouldNotBeDetermined = Boolean(planning) && problems.length === 0;
  const canOpenCalendar = problems.some((problem) => problem.provider === "calendar" || (problem.kind === "external" && problem.provider === "icloud"));
  return (
    <>
      <button
        type="button"
        className="planning-card__health planning-card__health--action"
        data-testid="planning-overview-health-action"
        aria-haspopup="dialog"
        aria-label={`${health.label}. Подробнее о состоянии планирования`}
        onClick={() => setOpen(true)}
      >
        {health.label}
      </button>
      {open && (
        <Sheet
          title={detail.title}
          description={detail.description}
          testId="planning-overview-health-details"
          onClose={() => setOpen(false)}
          footer={canOpenCalendar ? (
            <button type="button" className="planning-primary-button" onClick={() => onNavigate("/calendar")}>Открыть календарь</button>
          ) : undefined}
        >
          {!planning && <p className="planning-overview-health-details__copy">Данные планирования сейчас недоступны.</p>}
          {sourceCouldNotBeDetermined && (
            <p className="planning-overview-health-details__copy">
              Планирование сообщает о проблеме, но конкретный источник определить не удалось.
            </p>
          )}
          {problems.length > 0 && (
            <ul className="planning-overview-health-details__problems" aria-label="Проблемные источники">
              {problems.map((problem) => (
                <li className="planning-overview-health-details__problem" key={`${problem.provider}:${problem.providerLabel}`}>
                  <strong>{problem.providerLabel}</strong>
                  {problem.providerStatus && <span>{problem.providerStatus}</span>}
                  {problem.calendars.length > 0 && (
                    <ul className="planning-overview-health-details__calendars">
                      {problem.calendars.map((calendar) => (
                        <li key={`${problem.provider}:${calendar.label}`}>
                          <span>{calendar.label}</span>
                          <span>{calendar.status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {planning && <p className="planning-overview-health-details__copy">{detail.detail}</p>}
        </Sheet>
      )}
    </>
  );
}

export function PlanningOverviewCard({
  planning,
  onNavigate,
  density = "comfortable",
  sizeVariant = "standard"
}: {
  planning?: PlanningSnapshot | null;
  onNavigate: (target: PlanningNavigationTarget) => void;
  density?: "comfortable" | "compact";
  sizeVariant?: "compact" | "standard" | "large";
}) {
  const { preferences: calendarDisplayPreferences } = useCalendarDisplayPreferences();
  const initialHealth = planningHealthPresentation(planning);
  const now = usePlanningPresentationNow(initialHealth.state);
  const summary = planningOverviewSummary(planning, now);
  const health = summary.health;

  if (!planning) {
    return (
        <section className={`planning-card planning-card--unavailable planning-card--${density}`} data-testid="planning-overview-card" data-state="unavailable" aria-label="Дела">
        <header className="planning-card__header">
          <div>
            <p className="section-kicker">Планирование</p>
            <h2>Дела</h2>
          </div>
          <PlanningHealthAction planning={planning} health={health} onNavigate={onNavigate} />
        </header>
        <p className="planning-card__unavailable-copy">Данные планирования сейчас недоступны.</p>
      </section>
    );
  }

  const displayItems = displayPlanningOverviewItems(planning, summary.overviewItems, planningOverviewRowLimit(sizeVariant));
  const overdueCount = formatOverdueTaskCount(summary.overdueTaskCount);

  return (
    <section
      className={`planning-card planning-card--${health.state} planning-card--${density}`}
      data-testid="planning-overview-card"
      data-state={health.state}
      data-density={density}
      data-size-variant={sizeVariant}
      data-visible-item-count={displayItems.length}
      aria-label="Дела"
    >
      <header className="planning-card__header">
        <div>
          <p className="section-kicker">Планирование</p>
          <h2>Дела</h2>
        </div>
        <PlanningHealthAction planning={planning} health={health} onNavigate={onNavigate} />
      </header>

      <div className="planning-card__rows">
        {displayItems.map((entry, index) => {
          const kindOccurrence = displayItems.slice(0, index).filter((item) => item.kind === entry.kind).length + 1;
          const suffix = kindOccurrence === 1 ? "" : `-${kindOccurrence}`;
          const testId = entry.presentation === "unavailable"
            ? `planning-${entry.kind === "calendar" ? "calendar" : entry.kind}-status-row`
            : `planning-${entry.kind === "calendar" ? "event" : entry.kind}-row${suffix}`;
          const domain = entry.kind === "calendar" ? "calendar" : entry.kind === "task" ? "tasks" : "reminders";
          const rowState = planningDomainStatus(planning, domain);
          const isUnavailableStatus = entry.presentation === "unavailable";
          const isMeaningful = entry.presentation === "meaningful";
          const className = rowState !== "current" && rowState !== "retrying" ? "planning-row--not-current" : "";
          const rowSourceStatus = rowState === "retrying" || rowState === "current"
            ? "current"
            : rowState === "unavailable" ? "offline" : rowState;
          if (entry.kind === "reminder") {
            const reminder = entry.item;
            return (
              <PlanningRow
                key={`${entry.kind}-${index}`}
                testId={testId}
                className={className}
                dataState={rowState}
                label={isUnavailableStatus ? "Напоминания" : "Напоминание"}
                title={isMeaningful && reminder ? reminder.title : unavailableRowTitle("Напоминаний нет", rowState)}
                meta={isMeaningful && reminder ? formatReminderDueLabel(reminder, rowSourceStatus, now) : undefined}
                time={isMeaningful && reminder ? formatReminderExactTime(reminder) : undefined}
                dateTime={reminder?.dueAtUtc}
                onClick={isMeaningful && reminder && planningRemindersRouteEnabled ? () => onNavigate("/reminders") : undefined}
                ariaLabel={isMeaningful && reminder ? `${reminder.title}. ${formatReminderDueLabel(reminder, rowSourceStatus, now)}. Точное время ${formatReminderExactTime(reminder)}` : undefined}
                empty={!isMeaningful}
              />
            );
          }
          if (entry.kind === "task") {
            const task = entry.item;
            const taskTitle = isMeaningful && task
              ? entry.overdue ? `${overdueCount} · ${task.title}` : task.title
              : unavailableRowTitle("Нет просроченных задач", rowState);
            return (
              <PlanningRow
                key={`${entry.kind}-${index}`}
                testId={testId}
                className={className}
                dataState={rowState}
                label={isUnavailableStatus ? "Задачи" : entry.overdue ? "Просроченные задачи" : "Задача"}
                title={taskTitle}
                meta={isMeaningful && task ? formatTaskDueLabel(task) : entry.presentation === "placeholder" && (rowState === "current" || rowState === "degraded") ? overdueCount : undefined}
                onClick={isMeaningful && task ? () => onNavigate("/tasks") : undefined}
                ariaLabel={isMeaningful && task ? `${task.title}. ${formatTaskDueLabel(task)}` : undefined}
                empty={!isMeaningful}
              />
            );
          }
          const event = entry.item;
          const eventDate = isMeaningful && event ? formatCalendarEventDate(event) : null;
          const calendarLabel = event?.calendarIdentity?.calendarLabel.trim() || event?.sourceLabel.trim() || "Календарь";
          return (
            <PlanningRow
              key={`${entry.kind}-${index}`}
              testId={testId}
              className={className}
              dataState={rowState}
              indicatorColor={isMeaningful && event ? calendarEventColor(event, planning.providerStatuses, calendarDisplayPreferences?.overrides ?? []) : undefined}
              indicatorTestId={entry.kind === "calendar" && kindOccurrence === 1
                ? "planning-overview-calendar-marker"
                : undefined}
              label={isMeaningful ? calendarLabel : "Календарь"}
              title={isMeaningful && event ? event.title : unavailableRowTitle("Событий нет", rowState)}
              meta={isMeaningful && event ? formatCalendarEventTime(event) : undefined}
              time={eventDate ?? undefined}
              onClick={isMeaningful && event ? () => {
                const dateTarget = calendarNavigationForDate(calendarLocalDateForEvent(event) ?? "");
                onNavigate(dateTarget ?? "/calendar");
              } : undefined}
              ariaLabel={isMeaningful && event ? `${event.title}. ${formatCalendarEventTime(event)}${eventDate ? ` · ${eventDate}` : ""}` : undefined}
              empty={!isMeaningful}
            />
          );
        })}
      </div>
    </section>
  );
}
