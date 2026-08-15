import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  PlanningCalendarEvent,
  PlanningProject,
  PlanningReminder,
  PlanningSnapshot,
  PlanningTask
} from "@artem/contracts";
import type { RoutePath } from "./Shell";
import { formatReminderDueLabel } from "./planningOverview";
import {
  calendarAgendaRangeUtc,
  calendarDayRangeUtc,
  currentLocalDate,
  DEFAULT_PLANNING_TIME_ZONE,
  addCalendarDays
} from "./calendarRange";
import {
  readPlanningEvents,
  readPlanningProjects,
  readPlanningReminders,
  readPlanningTasks,
  usePlanningRead
} from "./planningReadClient";
import {
  deliveryAttentionRank,
  deliveryLabels,
  eventOverlapIds,
  eventTemporalState,
  calendarEventsInRange,
  formatEventRange,
  formatReminderExactDue,
  formatTaskDueForRoute,
  groupCalendarEvents,
  lifecycleLabels,
  priorityLabels,
  projectNameForTask,
  planningRouteReferenceTime,
  reminderMatchesView,
  reminderViewLabels,
  taskViewLabels
} from "./planningRouteLogic";
import {
  PaginationControls,
  PlanningRouteFrame,
  PlanningRouteState,
  PlanningSheet,
  previewEnvelope
} from "./PlanningRoutePrimitives";
import { planningRemindersRouteEnabled } from "./planningRouteConfig";
import { planningModuleForRoute } from "./planningModuleRegistry";
import { calendarIdentityForEvent, calendarIdentityLabel } from "./planningIdentity";

const tasksModule = planningModuleForRoute("/tasks")!;
const calendarModule = planningModuleForRoute("/calendar")!;
const remindersModule = planningModuleForRoute("/reminders")!;

interface PlanningRouteProps {
  snapshot: { revision: number; planning?: PlanningSnapshot | null };
  onNavigate: (path: RoutePath) => void;
}

function RouteControls({ children }: { children: ReactNode }) {
  return <div className="planning-route-controls">{children}</div>;
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="planning-detail-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TasksSegments({ view, onChange }: { view: "today" | "overdue" | "upcoming"; onChange: (view: "today" | "overdue" | "upcoming") => void }) {
  return (
    <div className="planning-segmented" role="group" aria-label="Представление задач">
      {(Object.keys(taskViewLabels) as Array<"today" | "overdue" | "upcoming">).map((value) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => onChange(value)}>
          {taskViewLabels[value]}
        </button>
      ))}
    </div>
  );
}

function ProjectFilterSheet({
  selectedProjectId,
  projects,
  hasMore,
  page,
  loading,
  error,
  onSelect,
  onNext,
  onPrevious,
  onClose
}: {
  selectedProjectId: string | null;
  projects: PlanningProject[];
  hasMore: boolean;
  page: number;
  loading: boolean;
  error: boolean;
  onSelect: (projectId: string | null) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  return (
    <PlanningSheet
      title="Проект"
      eyebrow="Фильтр задач"
      description="Показаны только проекты, подтверждённые Planning read API."
      onClose={onClose}
      testId="planning-project-sheet"
    >
      <div className="planning-filter-list" role="listbox" aria-label="Проекты">
        <button
          type="button"
          role="option"
          aria-selected={selectedProjectId === null}
          className={selectedProjectId === null ? "is-selected" : ""}
          onClick={() => onSelect(null)}
        >
          <span>Все проекты</span>
          {selectedProjectId === null && <span className="planning-filter-list__mark">Выбрано</span>}
        </button>
        {loading && <p className="planning-sheet__state">Загружаем проекты…</p>}
        {error && <p className="planning-sheet__state planning-sheet__state--error">Проекты сейчас недоступны. Повторите чтение.</p>}
        {!loading && projects.map((project) => (
          <button
            type="button"
            role="option"
            aria-selected={selectedProjectId === project.id}
            className={selectedProjectId === project.id ? "is-selected" : ""}
            key={project.id}
            onClick={() => onSelect(project.id)}
          >
            <span>{project.name}</span>
            {selectedProjectId === project.id && <span className="planning-filter-list__mark">Выбрано</span>}
          </button>
        ))}
      </div>
      <PaginationControls page={page} hasMore={hasMore} disabled={loading} onPrevious={onPrevious} onNext={onNext} />
    </PlanningSheet>
  );
}

function TaskDetailSheet({ task, projectName, onClose }: { task: PlanningTask; projectName: string; onClose: () => void }) {
  return (
    <PlanningSheet title={task.title} eyebrow="Задача · только чтение" onClose={onClose} testId="planning-task-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Приоритет" value={priorityLabels[task.priority]} />
        <ReadOnlyField label="Срок" value={formatTaskDueForRoute(task)} />
        <ReadOnlyField label="Проект" value={projectName || "Без проекта"} />
        <ReadOnlyField label="Источник" value={task.sourceLabel} />
        {task.timezone && <ReadOnlyField label="Часовой пояс" value={task.timezone} />}
      </dl>
      <p className="planning-detail-note">Изменение, завершение и архивирование будут добавлены в B4.</p>
    </PlanningSheet>
  );
}

function TaskRow({ task, projectName, onOpen }: { task: PlanningTask; projectName: string; onOpen: () => void }) {
  return (
    <button type="button" className="planning-route-row planning-task-row" data-testid="planning-task-route-row" onClick={onOpen}>
      <span className="planning-route-row__main">
        <span className="planning-route-row__eyebrow">{formatTaskDueForRoute(task)}</span>
        <strong>{task.title}</strong>
        <span className="planning-route-row__source">{task.sourceLabel}{projectName ? ` · ${projectName}` : " · Без проекта"}</span>
      </span>
      <span className={`planning-priority planning-priority--${task.priority}`}>{priorityLabels[task.priority]}</span>
    </button>
  );
}

export function TasksPage({ snapshot, onNavigate }: PlanningRouteProps) {
  const [view, setView] = useState<"today" | "overdue" | "upcoming">("today");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<PlanningTask | null>(null);
  const [retry, setRetry] = useState(0);
  const routeRead = usePlanningRead(
    `tasks:${view}:${projectId ?? "all"}:${page}:${snapshot.revision}:${retry}`,
    (signal) => readPlanningTasks(view, projectId, 20, page * 20, signal)
  );
  const projectRead = usePlanningRead(
    `projects:${projectPage}:${snapshot.revision}:${retry}:${filterOpen ? "open" : "closed"}`,
    filterOpen ? (signal) => readPlanningProjects(20, projectPage * 20, signal) : null,
    filterOpen
  );
  const planning = snapshot.planning ?? null;
  const fallback = planning && page === 0 && projectId === null
    ? previewEnvelope("task", planning.tasks[view], planning)
    : null;
  const envelope = routeRead.data ?? fallback;
  const preview = !routeRead.data && Boolean(fallback) && Boolean(routeRead.error);
  const routeError = Boolean(routeRead.error && !fallback);
  const projects = projectRead.data?.items ?? (planning?.tasks.projects ?? []);
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const projectFilterLabel = projectId ? (projectMap.get(projectId) ?? "Проект недоступен") : "Все проекты";

  useEffect(() => {
    setPage(0);
  }, [view, projectId]);

  return (
    <PlanningRouteFrame
      module={tasksModule}
      description="Открытые задачи по сроку, приоритету и проекту. Этот экран только наблюдает данные Planning."
      sourceStatus={envelope?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      error={routeRead.error}
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <>
          <TasksSegments view={view} onChange={setView} />
          <RouteControls>
            <button type="button" className="planning-secondary-button" onClick={() => setFilterOpen(true)}>{projectFilterLabel === "Все проекты" ? "Проект" : projectFilterLabel}</button>
            {planningRemindersRouteEnabled && <button type="button" className="planning-secondary-button" onClick={() => onNavigate("/reminders")}>Напоминания</button>}
          </RouteControls>
        </>
      )}
      testId="route-tasks"
    >
      <PlanningRouteState
        loading={routeRead.loading}
        empty={Boolean(envelope && envelope.items.length === 0)}
        error={routeError}
        preview={preview}
        onRetry={() => setRetry((value) => value + 1)}
      >
        {envelope && (
          <>
            <div className="planning-route-list" data-testid="planning-task-list">
              {envelope.items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  projectName={projectNameForTask(task, projects)}
                  onOpen={() => setSelectedTask(task)}
                />
              ))}
            </div>
            {!preview && <PaginationControls page={page} hasMore={envelope.hasMore} disabled={routeRead.loading} onPrevious={() => setPage((value) => Math.max(0, value - 1))} onNext={() => setPage((value) => value + 1)} />}
          </>
        )}
      </PlanningRouteState>
      {filterOpen && (
        <ProjectFilterSheet
          selectedProjectId={projectId}
          projects={projects}
          hasMore={projectRead.data?.hasMore ?? false}
          page={projectPage}
          loading={projectRead.loading}
          error={Boolean(projectRead.error)}
          onSelect={(value) => {
            setProjectId(value);
            setProjectPage(0);
            setFilterOpen(false);
          }}
          onPrevious={() => setProjectPage((value) => Math.max(0, value - 1))}
          onNext={() => setProjectPage((value) => value + 1)}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {selectedTask && (
        <TaskDetailSheet
          task={selectedTask}
          projectName={projectNameForTask(selectedTask, projects)}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </PlanningRouteFrame>
  );
}

function calendarDayLabel(localDate: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC"
  }).format(new Date(`${localDate}T12:00:00Z`));
}

function syncStateLabel(value: PlanningCalendarEvent["syncState"]): string {
  return {
    local_only: "Только локально",
    pending: "Ожидает синхронизации",
    synced: "Синхронизировано",
    stale: "Синхронизация устарела",
    conflict: "Конфликт синхронизации",
    error: "Ошибка синхронизации"
  }[value];
}

function CalendarEventRow({ event, overlap, now, onOpen }: { event: PlanningCalendarEvent; overlap: boolean; now: Date; onOpen: () => void }) {
  const state = eventTemporalState(event, now);
  return (
    <button
      type="button"
      className={`planning-route-row calendar-event-row calendar-event-row--${state}${overlap ? " calendar-event-row--overlap" : ""}`}
      data-testid="planning-calendar-event-row"
      data-sync-state={event.syncState}
      data-overlap={overlap ? "true" : "false"}
      onClick={onOpen}
    >
      <span className="planning-route-row__main">
        <span className="planning-route-row__eyebrow">{event.allDay ? "Весь день" : formatEventRange(event)}</span>
        <strong>{event.title}</strong>
        <span className="planning-route-row__source planning-calendar-state-line">
          <span data-testid="planning-calendar-identity">{calendarIdentityLabel(event)}</span>
          <span data-testid="planning-calendar-sync-state">Синхронизация: {syncStateLabel(event.syncState)}</span>
        </span>
      </span>
      <span className="calendar-event-row__badges">
        {state === "running" && <span className="calendar-badge calendar-badge--running">Идёт</span>}
        {state === "past" && <span className="calendar-badge">Завершено</span>}
        {overlap && <span className="calendar-badge calendar-badge--overlap">Пересекается по времени</span>}
      </span>
    </button>
  );
}

function CalendarDetailSheet({ event, overlap, onClose }: { event: PlanningCalendarEvent; overlap: boolean; onClose: () => void }) {
  const identity = calendarIdentityForEvent(event);
  return (
    <PlanningSheet title={event.title} eyebrow="Календарь · только чтение" onClose={onClose} testId="planning-calendar-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Тип" value={event.allDay ? "Весь день" : "Событие с временем"} />
        <ReadOnlyField label="Начало и конец" value={formatEventRange(event)} />
        <ReadOnlyField label="Часовой пояс" value={event.timezone} />
        <ReadOnlyField label="Провайдер" value={identity.providerLabel} />
        <ReadOnlyField label="Календарь" value={identity.calendarLabel} />
        <ReadOnlyField label="Состояние синхронизации" value={syncStateLabel(event.syncState)} />
        {overlap && <ReadOnlyField label="Пересечение" value="Пересекается с другим загруженным событием" />}
      </dl>
      <p className="planning-detail-note">Изменение, удаление и выбор провайдера относятся к следующим фазам продукта.</p>
    </PlanningSheet>
  );
}

function CalendarSegments({ segment, onChange }: { segment: "today" | "agenda"; onChange: (segment: "today" | "agenda") => void }) {
  return (
    <div className="planning-segmented" role="group" aria-label="Представление календаря">
      <button type="button" aria-pressed={segment === "today"} onClick={() => onChange("today")}>Сегодня</button>
      <button type="button" aria-pressed={segment === "agenda"} onClick={() => onChange("agenda")}>Повестка</button>
    </div>
  );
}

function CalendarDateNavigation({ segment, onPrevious, onToday, onNext }: { segment: "today" | "agenda"; onPrevious: () => void; onToday: () => void; onNext: () => void }) {
  return (
    <div className="planning-calendar-date-nav" role="group" aria-label="Навигация по датам">
      <button type="button" className="planning-secondary-button" onClick={onPrevious}>{segment === "today" ? "Предыдущий день" : "Предыдущие 7 дней"}</button>
      <button type="button" className="planning-secondary-button" onClick={onToday}>Сегодня</button>
      <button type="button" className="planning-secondary-button" onClick={onNext}>{segment === "today" ? "Следующий день" : "Следующие 7 дней"}</button>
    </div>
  );
}

export function CalendarPage({ snapshot }: PlanningRouteProps) {
  const [segment, setSegment] = useState<"today" | "agenda">("today");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [page, setPage] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<PlanningCalendarEvent | null>(null);
  const [retry, setRetry] = useState(0);
  const [liveNow, setLiveNow] = useState(() => new Date());
  const requestTodayLocalDate = addCalendarDays(
    currentLocalDate(liveNow, DEFAULT_PLANNING_TIME_ZONE),
    segment === "today" ? periodOffset : periodOffset * 7
  );
  const requestRange = useMemo(() => {
    if (segment === "today") return calendarDayRangeUtc(requestTodayLocalDate, DEFAULT_PLANNING_TIME_ZONE);
    return calendarAgendaRangeUtc(requestTodayLocalDate, 7, DEFAULT_PLANNING_TIME_ZONE);
  }, [segment, requestTodayLocalDate]);
  const routeRead = usePlanningRead(
    `events:${requestRange.fromUtc}:${requestRange.toUtc}:${page}:${snapshot.revision}:${retry}`,
    (signal) => readPlanningEvents(requestRange.fromUtc, requestRange.toUtc, 20, page * 20, signal)
  );
  const planning = snapshot.planning ?? null;
  const previewCandidate = Boolean(routeRead.error && planning && page === 0);
  const referenceTime = planningRouteReferenceTime(
    routeRead.data?.sourceStatus ?? planning?.sourceStatus ?? "unavailable",
    routeRead.data?.generatedAt ?? planning?.generatedAt ?? null,
    routeRead.data?.lastSyncedAt ?? planning?.lastSyncedAt ?? null,
    liveNow,
    previewCandidate || !routeRead.data
  );
  const displayTodayLocalDate = addCalendarDays(
    currentLocalDate(referenceTime, DEFAULT_PLANNING_TIME_ZONE),
    segment === "today" ? periodOffset : periodOffset * 7
  );
  const displayRange = useMemo(() => {
    if (segment === "today") return calendarDayRangeUtc(displayTodayLocalDate, DEFAULT_PLANNING_TIME_ZONE);
    return calendarAgendaRangeUtc(displayTodayLocalDate, 7, DEFAULT_PLANNING_TIME_ZONE);
  }, [segment, displayTodayLocalDate]);
  const previewItems = planning
    ? [...planning.calendar.today, ...planning.calendar.upcoming]
    : [];
  const fallbackItems = calendarEventsInRange(previewItems, displayRange);
  const fallback = planning && page === 0 ? previewEnvelope("calendar_event", fallbackItems, planning) : null;
  const envelope = routeRead.data ?? fallback;
  const preview = !routeRead.data && Boolean(fallback) && Boolean(routeRead.error);
  const routeError = Boolean(routeRead.error && !fallback);
  const events = calendarEventsInRange(envelope?.items ?? [], displayRange);
  const overlapIds = eventOverlapIds(events);
  const groups = groupCalendarEvents(events, displayRange.fromLocalDate, displayRange.toLocalDateExclusive);

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setPage(0);
  }, [segment, periodOffset]);

  return (
    <PlanningRouteFrame
      module={calendarModule}
      eyebrow="Расписание"
      description="Сегодня и ближайшие семь дней — весь день отдельно, события по локальному календарному дню."
      sourceStatus={envelope?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      error={routeRead.error}
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <>
          <CalendarSegments segment={segment} onChange={setSegment} />
          <CalendarDateNavigation
            segment={segment}
            onPrevious={() => setPeriodOffset((value) => value - 1)}
            onToday={() => setPeriodOffset(0)}
            onNext={() => setPeriodOffset((value) => value + 1)}
          />
        </>
      )}
      testId="route-calendar"
    >
      <PlanningRouteState loading={routeRead.loading} empty={Boolean(envelope && events.length === 0)} error={routeError} preview={preview} onRetry={() => setRetry((value) => value + 1)}>
        {envelope && (
          <>
            {groups.length ? (
              <div className="calendar-groups" data-testid="planning-calendar-groups">
                {groups.map((group) => (
                  <section className="calendar-day-group" key={group.localDate}>
                    <h2>{calendarDayLabel(group.localDate)}</h2>
                    {group.allDay.length > 0 && (
                      <div className="calendar-band" data-testid="planning-calendar-all-day-band">
                        <p className="calendar-band__label">Весь день</p>
                        {group.allDay.map((event) => <CalendarEventRow key={event.id} event={event} overlap={false} now={referenceTime} onOpen={() => setSelectedEvent(event)} />)}
                      </div>
                    )}
                    <div className="calendar-timed-list">
                      {group.timed.map((event) => <CalendarEventRow key={event.id} event={event} overlap={overlapIds.has(event.id)} now={referenceTime} onOpen={() => setSelectedEvent(event)} />)}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="planning-route-state planning-route-state--empty">В выбранном диапазоне событий нет.</div>
            )}
            {!preview && <PaginationControls page={page} hasMore={envelope.hasMore} disabled={routeRead.loading} onPrevious={() => setPage((value) => Math.max(0, value - 1))} onNext={() => setPage((value) => value + 1)} />}
          </>
        )}
      </PlanningRouteState>
      {selectedEvent && <CalendarDetailSheet event={selectedEvent} overlap={overlapIds.has(selectedEvent.id)} onClose={() => setSelectedEvent(null)} />}
    </PlanningRouteFrame>
  );
}

function reminderFallbackItems(planning: PlanningSnapshot, view: "upcoming" | "overdue" | "delivery", referenceTime: Date): PlanningReminder[] {
  const all = [...planning.reminders.upcoming, ...planning.reminders.overdue, ...planning.reminders.deliveryFailures];
  const unique = [...new Map(all.map((item) => [item.id, item])).values()];
  return unique.filter((reminder) => reminderMatchesView(reminder, view, referenceTime));
}

function ReminderSegments({ view, onChange }: { view: "upcoming" | "overdue" | "delivery"; onChange: (view: "upcoming" | "overdue" | "delivery") => void }) {
  return (
    <div className="planning-segmented" role="group" aria-label="Представление напоминаний">
      {(Object.keys(reminderViewLabels) as Array<"upcoming" | "overdue" | "delivery">).map((value) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => onChange(value)}>{reminderViewLabels[value]}</button>
      ))}
    </div>
  );
}

function ReminderDetailSheet({ reminder, onClose }: { reminder: PlanningReminder; onClose: () => void }) {
  return (
    <PlanningSheet title={reminder.title} eyebrow="Напоминание · только чтение" onClose={onClose} testId="planning-reminder-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Срок" value={formatReminderExactDue(reminder)} />
        <ReadOnlyField label="Жизненный цикл" value={lifecycleLabels[reminder.status]} />
        <ReadOnlyField label="Доставка" value={deliveryLabels[reminder.deliveryState]} />
        <ReadOnlyField label="Часовой пояс" value={reminder.timezone} />
        <ReadOnlyField label="Источник" value={reminder.sourceLabel} />
      </dl>
      <p className="planning-detail-note">Доставлено не означает завершено. Завершение, отмена, snooze и retry относятся к B4.</p>
    </PlanningSheet>
  );
}

function ReminderRow({ reminder, sourceStatus, now, onOpen }: { reminder: PlanningReminder; sourceStatus: PlanningSnapshot["sourceStatus"] | "unavailable"; now: Date; onOpen: () => void }) {
  const deliveredOpen = reminder.status === "due" && reminder.deliveryState === "delivered";
  return (
    <button
      type="button"
      className={`planning-route-row reminder-route-row ${deliveredOpen ? "reminder-route-row--delivered-open" : ""}`}
      data-testid="planning-reminder-route-row"
      data-lifecycle-state={reminder.status}
      data-delivery-state={reminder.deliveryState}
      onClick={onOpen}
    >
      <span className="planning-route-row__main">
        <span className="planning-route-row__eyebrow">{formatReminderDueLabel(reminder, sourceStatus === "unavailable" ? "offline" : sourceStatus, now)} · {formatReminderExactDue(reminder)}</span>
        <strong>{reminder.title}</strong>
        <span className="planning-route-row__source planning-reminder-state-line">
          <span data-testid="planning-reminder-lifecycle">Жизненный цикл: {lifecycleLabels[reminder.status]}</span>
          <span data-testid="planning-reminder-delivery">Доставка: {deliveryLabels[reminder.deliveryState]}</span>
          <span>Источник: {reminder.sourceLabel}</span>
        </span>
      </span>
      {deliveredOpen && <span className="reminder-status-badge">Открыто</span>}
    </button>
  );
}

export function RemindersPage({ snapshot }: PlanningRouteProps) {
  const [view, setView] = useState<"upcoming" | "overdue" | "delivery">("upcoming");
  const [page, setPage] = useState(0);
  const [selectedReminder, setSelectedReminder] = useState<PlanningReminder | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [retry, setRetry] = useState(0);
  const routeRead = usePlanningRead(
    `reminders:${view}:${page}:${snapshot.revision}:${retry}`,
    (signal) => readPlanningReminders(view, 20, page * 20, signal)
  );
  const planning = snapshot.planning ?? null;
  const fallbackReferenceTime = planningRouteReferenceTime(
    planning?.sourceStatus ?? "unavailable",
    planning?.generatedAt ?? null,
    planning?.lastSyncedAt ?? null,
    now,
    true
  );
  const fallback = planning && page === 0 ? previewEnvelope("reminder", reminderFallbackItems(planning, view, fallbackReferenceTime), planning) : null;
  const envelope = routeRead.data ?? fallback;
  const preview = !routeRead.data && Boolean(fallback) && Boolean(routeRead.error);
  const routeError = Boolean(routeRead.error && !fallback);
  const referenceTime = planningRouteReferenceTime(
    envelope?.sourceStatus ?? "unavailable",
    envelope?.generatedAt ?? null,
    envelope?.lastSyncedAt ?? null,
    now,
    preview || !routeRead.data
  );
  const visibleItems = envelope?.items
    .filter((reminder) => reminderMatchesView(reminder, view, referenceTime))
    .sort((left, right) => view === "delivery"
      ? deliveryAttentionRank(left.deliveryState) - deliveryAttentionRank(right.deliveryState) || left.dueAtUtc.localeCompare(right.dueAtUtc) || left.id.localeCompare(right.id)
      : left.dueAtUtc.localeCompare(right.dueAtUtc) || left.id.localeCompare(right.id)) ?? [];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setPage(0);
  }, [view]);

  return (
    <PlanningRouteFrame
      module={remindersModule}
      description="Активные сроки и состояние доставки. Напоминание остаётся открытым, пока его жизненный цикл не завершён."
      sourceStatus={envelope?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      error={routeRead.error}
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <>
          <ReminderSegments view={view} onChange={setView} />
          <span className="planning-route-note">Только чтение · доставка и завершение разделены</span>
        </>
      )}
      testId="route-reminders"
    >
      <PlanningRouteState loading={routeRead.loading} empty={Boolean(envelope && visibleItems.length === 0)} error={routeError} preview={preview} onRetry={() => setRetry((value) => value + 1)}>
        {envelope && (
          <>
            <div className="planning-route-list" data-testid="planning-reminder-list">
              {visibleItems.map((reminder) => <ReminderRow key={reminder.id} reminder={reminder} sourceStatus={envelope.sourceStatus} now={referenceTime} onOpen={() => setSelectedReminder(reminder)} />)}
            </div>
            {!preview && <PaginationControls page={page} hasMore={envelope.hasMore} disabled={routeRead.loading} onPrevious={() => setPage((value) => Math.max(0, value - 1))} onNext={() => setPage((value) => value + 1)} />}
          </>
        )}
      </PlanningRouteState>
      {selectedReminder && <ReminderDetailSheet reminder={selectedReminder} onClose={() => setSelectedReminder(null)} />}
    </PlanningRouteFrame>
  );
}
