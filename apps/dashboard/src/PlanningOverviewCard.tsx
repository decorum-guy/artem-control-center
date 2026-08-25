import { useEffect, useState } from "react";
import type { PlanningSnapshot } from "@artem/contracts";
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
  planningOverviewSummary
} from "./planningOverview";
import { planningRemindersRouteEnabled } from "./planningRouteConfig";

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
  health,
  onNavigate
}: {
  health: ReturnType<typeof planningHealthPresentation>;
  onNavigate: (target: PlanningNavigationTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  if (health.state === "current" || !health.label) return null;
  const detail = planningHealthDetail(health);
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
          footer={<button type="button" className="planning-primary-button" onClick={() => onNavigate("/calendar")}>Открыть календарь</button>}
        >
          <p className="planning-overview-health-details__copy">{detail.detail}</p>
        </Sheet>
      )}
    </>
  );
}

export function PlanningOverviewCard({
  planning,
  onNavigate,
  density = "comfortable"
}: {
  planning?: PlanningSnapshot | null;
  onNavigate: (target: PlanningNavigationTarget) => void;
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
          <PlanningHealthAction health={health} onNavigate={onNavigate} />
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
        <PlanningHealthAction health={health} onNavigate={onNavigate} />
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
          onClick={event ? () => {
            const dateTarget = calendarNavigationForDate(calendarLocalDateForEvent(event) ?? "");
            onNavigate(dateTarget ?? "/calendar");
          } : undefined}
          ariaLabel={event ? `${event.title}. ${formatCalendarEventTime(event)}${eventDate ? ` · ${eventDate}` : ""}` : undefined}
          empty={!event}
        />
      </div>
    </section>
  );
}
