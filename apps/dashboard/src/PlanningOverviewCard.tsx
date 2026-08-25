import { useEffect, useState } from "react";
import type { PlanningSnapshot } from "@artem/contracts";
import type { RoutePath } from "./Shell";
import {
  formatCalendarEventDate,
  formatCalendarEventTime,
  formatOverdueTaskCount,
  formatReminderDueLabel,
  formatReminderExactTime,
  formatTaskDueLabel,
  planningHealthPresentation,
  planningOverviewSummary
} from "./planningOverview";
import { planningRemindersRouteEnabled } from "./planningRouteConfig";

type PlanningNavigationPath = Extract<RoutePath, "/calendar" | "/tasks" | "/reminders">;

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
  className = ""
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
}) {
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
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={`planning-row ${className}`.trim()} data-testid={testId}>
      {content}
    </div>
  );
}

function unavailableRowTitle(health: ReturnType<typeof planningHealthPresentation>, emptyTitle: string): string {
  return health.state === "offline" || health.state === "stale" ? "Данные недоступны" : emptyTitle;
}

export function PlanningOverviewCard({
  planning,
  onNavigate,
  density = "comfortable"
}: {
  planning?: PlanningSnapshot | null;
  onNavigate: (path: PlanningNavigationPath) => void;
  density?: "comfortable" | "compact";
}) {
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
          <span className="planning-card__health">{health.label}</span>
        </header>
        <p className="planning-card__unavailable-copy">Данные пока недоступны. Повторите попытку.</p>
      </section>
    );
  }

  const reminder = summary.reminder;
  const overdueTask = summary.overdueTask;
  const event = summary.event;
  const overdueCount = formatOverdueTaskCount(summary.overdueTaskCount);
  const currentData = planning.sourceStatus === "current";
  const reminderTitle = reminder?.title ?? unavailableRowTitle(health, "Напоминаний нет");
  const taskTitle = overdueTask?.title ?? unavailableRowTitle(health, "Нет просроченных задач");
  const eventTitle = event?.title ?? unavailableRowTitle(health, "Событий нет");
  const eventDate = event ? formatCalendarEventDate(event) : null;
  const taskMeta = overdueTask
    ? formatTaskDueLabel(overdueTask)
    : health.state === "current" || health.state === "degraded"
      ? overdueCount
      : undefined;

  return (
    <section
      className={`planning-card planning-card--${health.state} planning-card--${density}`}
      data-testid="planning-overview-card"
      data-state={health.state}
      data-density={density}
      aria-label="Дела"
    >
      <header className="planning-card__header">
        <div>
          <p className="section-kicker">Планирование</p>
          <h2>Дела</h2>
        </div>
        {health.label && <span className="planning-card__health">{health.label}</span>}
      </header>

      <div className="planning-card__rows">
        <PlanningRow
          testId="planning-reminder-row"
          className={!currentData ? "planning-row--not-current" : ""}
          label="Напоминание"
          title={reminderTitle}
          meta={reminder ? formatReminderDueLabel(reminder, planning.sourceStatus, now) : undefined}
          time={reminder ? formatReminderExactTime(reminder) : undefined}
          dateTime={reminder?.dueAtUtc}
          onClick={reminder && planningRemindersRouteEnabled ? () => onNavigate("/reminders") : undefined}
          ariaLabel={reminder ? `${reminder.title}. ${formatReminderDueLabel(reminder, planning.sourceStatus, now)}. Точное время ${formatReminderExactTime(reminder)}` : undefined}
          empty={!reminder}
        />
        <PlanningRow
          testId="planning-task-row"
          className={!currentData ? "planning-row--not-current" : ""}
          label="Просроченные задачи"
          title={overdueTask ? `${overdueCount} · ${overdueTask.title}` : taskTitle}
          meta={taskMeta}
          onClick={overdueTask ? () => onNavigate("/tasks") : undefined}
          ariaLabel={overdueTask ? `${overdueCount} просроченных задач. ${overdueTask.title}. ${formatTaskDueLabel(overdueTask)}` : undefined}
          empty={!overdueTask}
        />
        <PlanningRow
          testId="planning-event-row"
          className={!currentData ? "planning-row--not-current" : ""}
          label="Календарь"
          title={eventTitle}
          meta={event ? formatCalendarEventTime(event) : undefined}
          time={eventDate ?? undefined}
          onClick={event ? () => onNavigate("/calendar") : undefined}
          ariaLabel={event ? `${event.title}. ${formatCalendarEventTime(event)}${eventDate ? ` · ${eventDate}` : ""}` : undefined}
          empty={!event}
        />
      </div>
    </section>
  );
}
