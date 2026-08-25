import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  PlanningCalendarEvent,
  PlanningCalendarSource,
  PlanningProject,
  PlanningReminder,
  PlanningSnapshot,
  PlanningTask
} from "@artem/contracts";
import type { ShellNavigationTarget } from "./Shell";
import { formatReminderDueLabel } from "./planningOverview";
import {
  currentLocalDate,
  DEFAULT_PLANNING_TIME_ZONE,
  addCalendarDays
} from "./calendarRange";
import { calendarMonthGrid, calendarMonthKeyForDate, shiftCalendarMonth } from "./calendarMonth";
import {
  mutatePlanningReminder,
  mutatePlanningEvent,
  mutatePlanningTask,
  newPlanningIdempotencyKey,
  PlanningMutationError,
  previewPlanningTask,
  previewPlanningReminder,
  previewPlanningEvent,
  readPlanningEventsForRange,
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
  calendarEventColor,
  calendarEventsForLocalDay,
  calendarEventsInRange,
  formatEventRange,
  formatReminderExactDue,
  formatTaskDueForRoute,
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
  previewEnvelope,
  syncTimeLabel
} from "./PlanningRoutePrimitives";
import {
  planningCalendarRouteEnabled,
  planningReminderMutationsEnabled,
  planningCalendarMutationsEnabled,
  planningRemindersRouteEnabled,
  planningTaskMutationsEnabled,
  planningTasksRouteEnabled
} from "./planningRouteConfig";
import { planningModuleForRoute } from "./planningModuleRegistry";
import { calendarIdentityForEvent, calendarIdentityLabel } from "./planningIdentity";
import { useNoticeCenter } from "./NoticeCenter";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { Icon } from "./icons";
import type { ActionConfirmationId } from "./actionConfirmationCatalog";
import {
  taskMutationBodyFromPreview,
  type TaskMutationBody,
  type TaskMutationSheetMode
} from "./taskMutationBody";
import {
  eventMutationBodyFromPreview,
  proposedEventEndLabel,
  type EventMutationBody,
  type EventMutationSheetMode
} from "./eventMutationBody";
import { calendarEventPreviewSaveState } from "./calendarEventPreviewPolicy";
import { calendarDateFromSearch } from "./calendarNavigation";

const tasksModule = planningModuleForRoute("/tasks")!;
const calendarModule = planningModuleForRoute("/calendar")!;
const remindersModule = planningModuleForRoute("/reminders")!;

interface PlanningRouteProps {
  snapshot: { revision: number; planning?: PlanningSnapshot | null };
  onNavigate: (target: ShellNavigationTarget) => void;
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
      description="Выберите проект для списка задач."
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

const planningTaskAccessCapabilities = {
  create: "planning.tasks.create",
  edit: "planning.tasks.edit",
  complete: "planning.tasks.complete",
  archive: "planning.tasks.archive"
} as const;

const planningTaskConfirmationIds: Record<"complete" | "archive", ActionConfirmationId> = {
  complete: "planning.tasks.complete",
  archive: "planning.tasks.archive"
};

function taskMutationAllowed(
  planning: PlanningSnapshot | null,
  capability: "create" | "edit" | "complete" | "archive"
): boolean {
  return planningTasksRouteEnabled
    && planningTaskMutationsEnabled
    && planning?.sourceStatus === "current"
    && Boolean(planning?.capabilities.tasks[capability]);
}

function TaskMutationSheet({
  mode,
  task,
  onClose,
  onSubmit
}: {
  mode: TaskMutationSheetMode;
  task: PlanningTask | null;
  onClose: () => void;
  onSubmit: (body: TaskMutationBody) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPlanningTask>> | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setParsing(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      void previewPlanningTask(
        trimmed,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        DEFAULT_PLANNING_TIME_ZONE,
        controller.signal
      )
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setParsing(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  const candidate = preview?.candidate;
  const fields = candidate?.fields ?? {};
  const priority = fields.priority;
  const canSave = Boolean(
    candidate?.domain === "task"
    && candidate.operation === "create"
    && preview?.confidence === "high"
    && preview.ambiguities.length === 0
    && !preview.requires_confirmation
    && typeof fields.title === "string"
    && (priority === "none" || priority === "low" || priority === "normal" || priority === "high")
  );

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    const body = taskMutationBodyFromPreview(mode, fields);
    try {
      await onSubmit(body);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PlanningSheet
      title={mode === "create" ? "Новая задача" : "Изменить задачу"}
      eyebrow="Задача · проверка перед сохранением"
      description="Введите задачу. Неоднозначная дата или время блокирует сохранение. Примеры: «завтра купить продукты» и «завтра в 18:30 отправить отчёт»."
      onClose={onClose}
      testId="planning-task-mutation"
    >
      <div className="planning-mutation-form">
        <label className="planning-mutation-form__label" htmlFor="planning-task-free-text">Фраза</label>
        <textarea
          id="planning-task-free-text"
          className="planning-mutation-form__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Например: завтра купить продукты или завтра в 18:30 отправить отчёт"
          rows={3}
          autoFocus
        />
        {parsing && <p className="planning-mutation-form__status">Проверяем формулировку…</p>}
        {preview && (
          <section className="planning-mutation-preview" data-testid="planning-task-preview" aria-live="polite">
            <p className="planning-mutation-preview__eyebrow">Человеческая расшифровка</p>
            <p className="planning-mutation-preview__restatement">{candidate?.normalized_paraphrase ?? "Предложение пока не сформировано."}</p>
            {preview.ambiguities.length > 0 && (
              <div className="planning-mutation-preview__ambiguities" data-testid="planning-task-ambiguities">
                <strong>Нужно уточнить</strong>
                {preview.ambiguities.map((ambiguity) => (
                  <p key={`${ambiguity.field}-${ambiguity.reason}`}>{ambiguity.reason}{ambiguity.candidates.length ? ` Варианты: ${ambiguity.candidates.join(", ")}.` : ""}</p>
                ))}
              </div>
            )}
            {preview.error_code && <p className="planning-mutation-form__error">Формулировка не подтверждена: {preview.error_code}.</p>}
          </section>
        )}
        <p className="planning-detail-note">
          {mode === "edit" && task ? `Текущая запись: ${task.title}. Изменения появятся после сохранения.` : "Сохранить можно только однозначную задачу."}
        </p>
      </div>
      <div className="planning-sheet-actions">
        <button type="button" className="planning-secondary-button" onClick={onClose}>Отмена</button>
        <button type="button" className="planning-primary-button" disabled={!canSave || parsing || saving} onClick={() => void save()}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </PlanningSheet>
  );
}

function TaskDetailSheet({
  task,
  projectName,
  onClose,
  canEdit,
  canComplete,
  canArchive,
  lifecyclePending,
  onEdit,
  onComplete,
  onArchive
}: {
  task: PlanningTask;
  projectName: string;
  onClose: () => void;
  canEdit: boolean;
  canComplete: boolean;
  canArchive: boolean;
  lifecyclePending: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onArchive: () => void;
}) {
  const active = task.status === "open";
  return (
    <PlanningSheet title={task.title} eyebrow="Задача" onClose={onClose} testId="planning-task-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Приоритет" value={priorityLabels[task.priority]} />
        <ReadOnlyField label="Срок" value={formatTaskDueForRoute(task)} />
        <ReadOnlyField label="Проект" value={projectName || "Без проекта"} />
        <ReadOnlyField label="Источник" value={task.sourceLabel} />
        <ReadOnlyField label="Жизненный цикл" value={task.status === "open" ? "Открыта" : task.status === "completed" ? "Завершена" : "Архивирована"} />
        {task.timezone && <ReadOnlyField label="Часовой пояс" value={task.timezone} />}
        {task.notes && <ReadOnlyField label="Заметки" value={task.notes} />}
      </dl>
      {active && (canEdit || canComplete || canArchive) && (
        <div className="planning-sheet-actions planning-sheet-actions--stacked">
          {canEdit && <button type="button" className="planning-secondary-button" onClick={onEdit}>Изменить</button>}
          {canComplete && <button type="button" className="planning-primary-button" disabled={lifecyclePending} onClick={onComplete}>Завершить</button>}
          {canArchive && <button type="button" className="planning-secondary-button" disabled={lifecyclePending} onClick={onArchive}>Архивировать</button>}
        </div>
      )}
      <p className="planning-detail-note">Архивирование — логическое удаление из активных представлений; физическая строка не удаляется.</p>
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
  const [mutationSheet, setMutationSheet] = useState<TaskMutationSheetMode | null>(null);
  const [retry, setRetry] = useState(0);
  const { showNotice } = useNoticeCenter();
  const { status: accessStatus, ensureCapability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { confirmAction } = useActionConfirmation();
  const lifecyclePendingRef = useRef(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const routeRead = usePlanningRead(
    {
      queryKey: `tasks:${view}:${projectId ?? "all"}:${page}`,
      refreshKey: `${snapshot.revision}:${retry}`,
      reader: (signal) => readPlanningTasks(view, projectId, 20, page * 20, signal)
    }
  );
  const projectRead = usePlanningRead(
    {
      queryKey: `projects:${projectPage}:${filterOpen ? "open" : "closed"}`,
      refreshKey: `${snapshot.revision}:${retry}`,
      reader: filterOpen ? (signal) => readPlanningProjects(20, projectPage * 20, signal) : null,
      enabled: filterOpen
    }
  );
  const planning = snapshot.planning ?? null;
  const fallback = planning && page === 0 && projectId === null
    ? previewEnvelope("task", planning.tasks[view], planning)
    : null;
  const envelope = routeRead.data ?? fallback;
  const preview = !routeRead.data && Boolean(fallback) && Boolean(routeRead.error);
  const routeError = Boolean(routeRead.error && !routeRead.data && !fallback);
  const projects = projectRead.data?.items ?? (planning?.tasks.projects ?? []);
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const projectFilterLabel = projectId ? (projectMap.get(projectId) ?? "Проект недоступен") : "Все проекты";
  const accessAllows = (action: keyof typeof planningTaskAccessCapabilities): boolean => {
    if (!accessStatus) return true;
    return Boolean(accessStatus.capabilities[planningTaskAccessCapabilities[action]]?.allowed);
  };
  const canCreate = taskMutationAllowed(planning, "create") && accessAllows("create");
  const canEdit = taskMutationAllowed(planning, "edit")
    && accessAllows("edit")
    && Boolean(selectedTask?.status === "open");
  const canComplete = taskMutationAllowed(planning, "complete")
    && accessAllows("complete")
    && Boolean(selectedTask?.status === "open");
  const canArchive = taskMutationAllowed(planning, "archive")
    && accessAllows("archive")
    && Boolean(selectedTask?.status === "open");

  async function ensureTaskCapability(
    action: keyof typeof planningTaskAccessCapabilities,
    title: string
  ): Promise<boolean> {
    const capability = planningTaskAccessCapabilities[action];
    if (accessStatus && !accessStatus.capabilities[capability]) {
      showNotice({
        id: `planning.task.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Для этой операции нет разрешения в текущем профиле. Запрос не отправлен."
      });
      return false;
    }
    const allowed = await ensureCapability(capability, title);
    if (!allowed) {
      showNotice({
        id: `planning.task.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Эта операция запрещена текущим профилем. Запрос не отправлен."
      });
    }
    return allowed;
  }

  async function submitMutation(body: TaskMutationBody): Promise<void> {
    if (!guardMutation()) return;
    const action = mutationSheet === "create" ? "create" : "edit";
    const target = mutationSheet === "edit" ? selectedTask : null;
    if (!await ensureTaskCapability(action, action === "create" ? "Создать задачу" : "Изменить задачу")) return;
    if (!guardMutation()) return;
    try {
      const result = await mutatePlanningTask({
        action,
        idempotencyKey: newPlanningIdempotencyKey("panel-task"),
        taskId: target?.id,
        expectedVersion: target?.version,
        body
      });
      setSelectedTask(result.object);
      setMutationSheet(null);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.task.${action}.${result.object.id}`,
        severity: "success",
        title: action === "create" ? "Задача создана" : "Задача изменена",
        detail: "Изменения сохранены."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedTask(error.reconciledObject as PlanningTask);
        setRetry((value) => value + 1);
        setMutationSheet(null);
        showNotice({
          id: `planning.task.reconciled.${error.reconciledObject.id}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат сохранения проверен."
        });
        return;
      }
      showNotice({
        id: `planning.task.uncertain.${target?.id ?? "create"}`,
        severity: error instanceof PlanningMutationError && error.mutationCode === "conflict" ? "warning" : "error",
        title: error instanceof PlanningMutationError && error.mutationCode === "conflict" ? "Задача изменилась" : "Результат не подтверждён",
        detail: error instanceof PlanningMutationError && error.mutationCode === "conflict"
          ? "Запись уже изменилась. Сначала перечитайте её."
          : "Результат не подтверждён. Повторите чтение перед новой попыткой."
      });
    }
  }

  async function runAction(action: "complete" | "archive"): Promise<void> {
    if (!guardMutation() || !selectedTask || lifecyclePendingRef.current) return;
    const target = selectedTask;
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    try {
      if (!await ensureTaskCapability(action, action === "complete" ? "Завершить задачу" : "Архивировать задачу")) return;
      const confirmation = await confirmAction(planningTaskConfirmationIds[action], {
        target: target.title,
        revision: String(target.version)
      });
      if (!confirmation.confirmed) return;
      if (!guardMutation()) return;
      const result = await mutatePlanningTask({
        action,
        idempotencyKey: newPlanningIdempotencyKey("panel-task"),
        taskId: target.id,
        expectedVersion: target.version,
        body: {}
      });
      setSelectedTask(result.object);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.task.${action}.${result.object.id}`,
        severity: "success",
        title: action === "complete" ? "Задача завершена" : "Задача архивирована",
        detail: action === "archive" ? "Задача убрана из активных списков." : "Статус задачи изменён."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedTask(error.reconciledObject as PlanningTask);
        setRetry((value) => value + 1);
        showNotice({
          id: `planning.task.reconciled.${target.id}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат изменения проверен."
        });
        return;
      }
      showNotice({
        id: `planning.task.action-uncertain.${target.id}`,
        severity: "error",
        title: "Результат не подтверждён",
        detail: "Результат не подтверждён. Повторите чтение перед новой попыткой."
      });
    } finally {
      lifecyclePendingRef.current = false;
      setLifecyclePending(false);
    }
  }

  useEffect(() => {
    setPage(0);
  }, [view, projectId]);

  return (
    <PlanningRouteFrame
      module={tasksModule}
      description="Задачи по сроку, приоритету и проекту."
      sourceStatus={envelope?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      error={routeRead.error}
      hasConfirmedContent={Boolean(routeRead.data)}
      refreshing={routeRead.refreshing}
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
      futureAction={canCreate ? <button type="button" className="planning-primary-button" onClick={() => setMutationSheet("create")}>Создать задачу</button> : undefined}
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
      {selectedTask && !mutationSheet && (
        <TaskDetailSheet
          task={selectedTask}
          projectName={projectNameForTask(selectedTask, projects)}
          onClose={() => setSelectedTask(null)}
          canEdit={canEdit}
          canComplete={canComplete}
          canArchive={canArchive}
          lifecyclePending={lifecyclePending}
          onEdit={() => setMutationSheet("edit")}
          onComplete={() => void runAction("complete")}
          onArchive={() => void runAction("archive")}
        />
      )}
      {mutationSheet && (
        <TaskMutationSheet
          mode={mutationSheet}
          task={selectedTask}
          onClose={() => setMutationSheet(null)}
          onSubmit={submitMutation}
        />
      )}
    </PlanningRouteFrame>
  );
}

const planningCalendarAccessCapabilities = {
  create: "planning.calendar.create",
  edit: "planning.calendar.edit",
  delete: "planning.calendar.delete"
} as const;

function calendarMutationAllowed(
  planning: PlanningSnapshot | null,
  capability: "create" | "edit" | "delete"
): boolean {
  return planningCalendarRouteEnabled
    && planningCalendarMutationsEnabled
    && planning?.sourceStatus === "current"
    && Boolean(planning?.capabilities.calendar[capability]);
}

function CalendarMutationSheet({
  mode,
  event,
  onClose,
  onSubmit
}: {
  mode: EventMutationSheetMode;
  event: PlanningCalendarEvent | null;
  onClose: () => void;
  onSubmit: (body: EventMutationBody) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPlanningEvent>> | null>(null);
  const [proposalAccepted, setProposalAccepted] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProposalAccepted(false);
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setParsing(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      void previewPlanningEvent(
        trimmed,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        DEFAULT_PLANNING_TIME_ZONE,
        controller.signal
      )
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setParsing(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  const candidate = preview?.candidate;
  const fields = candidate?.fields ?? {};
  const proposedEnd = proposedEventEndLabel(fields);
  const previewSaveState = calendarEventPreviewSaveState(preview, proposalAccepted);
  const proposalRequired = previewSaveState.isCanonicalStartOnlyProposal;
  const canSave = previewSaveState.canSave;

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSubmit(eventMutationBodyFromPreview(mode, fields, proposalAccepted));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PlanningSheet
      title={mode === "create" ? "Новое событие" : "Изменить событие"}
      eyebrow="Календарь · проверка перед сохранением"
      description="Сохранить можно только однозначное событие. Внешние календари доступны только для просмотра."
      onClose={onClose}
      testId="planning-calendar-mutation"
    >
      <div className="planning-mutation-form">
        <label className="planning-mutation-form__label" htmlFor="planning-calendar-free-text">Фраза</label>
        <textarea
          id="planning-calendar-free-text"
          className="planning-mutation-form__input"
          value={text}
          onChange={(eventChange) => setText(eventChange.target.value)}
          placeholder="Например: завтра в 18:30–19:30 встреча"
          rows={3}
          autoFocus
        />
        {parsing && <p className="planning-mutation-form__status">Проверяем формулировку…</p>}
        {preview && (
          <section className="planning-mutation-preview" data-testid="planning-calendar-preview" aria-live="polite">
            <p className="planning-mutation-preview__eyebrow">Человеческая расшифровка</p>
            <p className="planning-mutation-preview__restatement">{candidate?.normalized_paraphrase ?? "Предложение пока не сформировано."}</p>
            {proposalRequired && (
              <div className="planning-mutation-preview__ambiguities" data-testid="planning-calendar-proposal">
                <strong>Предлагаемый конец: {proposedEnd ?? "60 минут"}</strong>
                <p>Продолжительность: 60 минут. Это предложение, а не тихое значение по умолчанию.</p>
                <button type="button" className="planning-secondary-button" aria-pressed={proposalAccepted} onClick={() => setProposalAccepted((value) => !value)}>
                  {proposalAccepted ? "60 минут приняты" : "Принять 60 минут"}
                </button>
              </div>
            )}
            {preview.ambiguities.length > 0 && (
              <div className="planning-mutation-preview__ambiguities" data-testid="planning-calendar-ambiguities">
                <strong>Нужно уточнить</strong>
                {preview.ambiguities.map((ambiguity) => (
                  <p key={`${ambiguity.field}-${ambiguity.reason}`}>{ambiguity.reason}{ambiguity.candidates.length ? ` Варианты: ${ambiguity.candidates.join(", ")}.` : ""}</p>
                ))}
              </div>
            )}
            {preview.error_code && <p className="planning-mutation-form__error">Формулировка не подтверждена: {preview.error_code}.</p>}
          </section>
        )}
        <p className="planning-detail-note">
          {mode === "edit" && event ? `Текущая запись: ${event.title}. Заметки и место не меняются при этом редактировании.` : "Сохранить можно только однозначное событие."}
        </p>
      </div>
      <div className="planning-sheet-actions">
        <button type="button" className="planning-secondary-button" onClick={onClose}>Отмена</button>
        <button type="button" className="planning-primary-button" disabled={!canSave || parsing || saving} onClick={() => void save()}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </PlanningSheet>
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

function syncWarningLabel(value: PlanningCalendarEvent["syncState"]): string | null {
  if (value === "local_only") return "Только локально";
  if (value === "pending") return "Ожидает синхронизации";
  if (value === "stale") return "Синхронизация устарела";
  if (value === "conflict") return "Конфликт синхронизации";
  if (value === "error") return "Ошибка синхронизации";
  return null;
}

function providerSourceForEvent(event: PlanningCalendarEvent, sources: PlanningCalendarSource[]): PlanningCalendarSource | null {
  const identity = calendarIdentityForEvent(event);
  return sources.find((source) => source.id === identity.providerId || (source.kind === "native" && identity.providerId === "local-planning")) ?? null;
}

function providerSourceNeedsStaleCue(source: PlanningCalendarSource | null): boolean {
  return Boolean(source?.kind === "external" && (source.status === "stale" || source.status === "error"));
}

function providerStatusLabel(source: PlanningCalendarSource | null): string | null {
  if (!source || source.kind !== "external") return null;
  return {
    current: "Актуально",
    stale: "Сохранённая копия",
    error: "Источник недоступен",
    disabled: "Источник отключён",
    not_configured: "Источник не настроен"
  }[source.status];
}

function CalendarEventRow({ event, overlap, now, onOpen, sourceStale, accentColor }: { event: PlanningCalendarEvent; overlap: boolean; now: Date; onOpen: () => void; sourceStale: boolean; accentColor: string }) {
  const state = eventTemporalState(event, now);
  return (
    <button
      type="button"
      className={`planning-route-row calendar-event-row calendar-event-row--${state}${overlap ? " calendar-event-row--overlap" : ""}`}
      style={{ "--calendar-event-accent": accentColor } as CSSProperties}
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
          {syncWarningLabel(event.syncState) && <span data-testid="planning-calendar-sync-warning">{syncWarningLabel(event.syncState)}</span>}
          {sourceStale && <span data-testid="planning-calendar-stale-cue">Сохранённая копия</span>}
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

function CalendarDetailSheet({
  event,
  overlap,
  onClose,
  canEdit,
  canDelete,
  source,
  mutationPending,
  onEdit,
  onDelete
}: {
  event: PlanningCalendarEvent;
  overlap: boolean;
  onClose: () => void;
  canEdit: boolean;
  canDelete: boolean;
  source: PlanningCalendarSource | null;
  mutationPending: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const identity = calendarIdentityForEvent(event);
  const localEvent = event.localOnlyMutable && event.syncState === "local_only";
  const deleted = Boolean(event.deletedAt);
  return (
    <PlanningSheet title={event.title} eyebrow={localEvent ? "Календарь · локальное событие" : "Календарь · только чтение"} onClose={onClose} testId="planning-calendar-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Тип" value={event.allDay ? "Весь день" : "Событие с временем"} />
        <ReadOnlyField label="Начало и конец" value={formatEventRange(event, true)} />
        <ReadOnlyField label="Часовой пояс" value={event.timezone} />
        <ReadOnlyField label="Провайдер" value={identity.providerLabel} />
        <ReadOnlyField label="Календарь" value={identity.calendarLabel} />
        <ReadOnlyField label="Состояние синхронизации" value={syncStateLabel(event.syncState)} />
        {source && <ReadOnlyField label="Состояние источника" value={providerStatusLabel(source) ?? "Локально"} />}
        {source?.kind === "external" && source.lastSyncedAt && <ReadOnlyField label="Последнее обновление" value={syncTimeLabel(source.lastSyncedAt) ?? source.lastSyncedAt} />}
        {event.notes && <ReadOnlyField label="Заметки" value={event.notes} />}
        {event.location && <ReadOnlyField label="Место" value={event.location} />}
        {overlap && <ReadOnlyField label="Пересечение" value="Пересекается с другим загруженным событием" />}
      </dl>
      {localEvent && !deleted && (canEdit || canDelete) && (
        <div className="planning-sheet-actions planning-sheet-actions--stacked">
          {canEdit && <button type="button" className="planning-secondary-button" disabled={mutationPending} onClick={onEdit}>Изменить</button>}
          {canDelete && <button type="button" className="planning-secondary-button" disabled={mutationPending} onClick={onDelete}>Удалить</button>}
        </div>
      )}
      <p className="planning-detail-note">
        {deleted ? "Событие удалено." : localEvent ? "Локальное событие. Внешняя синхронизация не используется." : "Внешний календарь · только просмотр. Редактирование и удаление недоступны."}
      </p>
    </PlanningSheet>
  );
}

function CalendarMonthControls({
  month,
  onPrevious,
  onToday,
  onNext,
  futureAction,
  onRefresh,
  refreshDisabled,
  refreshing
}: {
  month: { year: number; month: number };
  onPrevious: () => void;
  onToday: () => void;
  onNext: () => void;
  futureAction?: ReactNode;
  onRefresh: () => void;
  refreshDisabled: boolean;
  refreshing: boolean;
}) {
  const rawLabel = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(month.year, month.month - 1, 1)));
  const label = `${rawLabel.slice(0, 1).toLocaleUpperCase("ru-RU")}${rawLabel.slice(1)} ${month.year}`;
  return (
    <div className="planning-calendar-header-controls" data-testid="planning-calendar-header-controls">
      <div className="planning-calendar-month-controls" data-testid="planning-calendar-month-controls" role="group" aria-label="Навигация по месяцам">
        <button type="button" className="planning-secondary-button" aria-label="Предыдущий месяц" onClick={onPrevious}>‹</button>
        <strong className="planning-calendar-month-controls__label" data-testid="planning-calendar-month-heading">{label}</strong>
        <button type="button" className="planning-secondary-button" aria-label="Следующий месяц" onClick={onNext}>›</button>
      </div>
      <div className="planning-calendar-today-control" data-testid="planning-calendar-today-control" role="group" aria-label="Переход к сегодняшнему дню">
        <button type="button" className="planning-secondary-button" onClick={onToday}>Сегодня</button>
        {futureAction && <div className="planning-future-action-slot" data-testid="planning-future-action-slot">{futureAction}</div>}
        <button
          type="button"
          className={`planning-icon-button${refreshing ? " planning-icon-button--busy" : ""}`}
          aria-label={refreshing ? "Обновление календаря" : "Обновить календарь"}
          title="Обновить календарь"
          aria-busy={refreshing}
          data-testid="planning-calendar-refresh"
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={19} />
        </button>
      </div>
    </div>
  );
}

function calendarMonthParts(monthKey: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new RangeError("Calendar month must be YYYY-MM");
  return { year: Number(match[1]), month: Number(match[2]) };
}

const CALENDAR_REFRESH_NOTICE_DWELL_MS = 2_000;

function calendarInitialDate(): string {
  return calendarDateFromSearch(window.location.search)
    ?? currentLocalDate(new Date(), DEFAULT_PLANNING_TIME_ZONE);
}

function useCalendarRefreshNotice(refreshing: boolean, hasConfirmedContent: boolean): void {
  const { showNotice, dismissNotice } = useNoticeCenter();

  useEffect(() => {
    const id = "planning.calendar.refresh";
    if (!refreshing || !hasConfirmedContent) {
      dismissNotice(id);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      showNotice({
        id,
        severity: "progress",
        title: "Календарь обновляется",
        detail: "Обновление выполняется.",
        testId: "planning-calendar-refresh-notice"
      });
    }, CALENDAR_REFRESH_NOTICE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [dismissNotice, hasConfirmedContent, refreshing, showNotice]);

  useEffect(() => () => dismissNotice("planning.calendar.refresh"), [dismissNotice]);
}

export function CalendarPage({ snapshot }: PlanningRouteProps) {
  const [visibleMonthKey, setVisibleMonthKey] = useState(() => calendarMonthKeyForDate(calendarInitialDate()));
  const [selectedDate, setSelectedDate] = useState(calendarInitialDate);
  const [selectedEvent, setSelectedEvent] = useState<PlanningCalendarEvent | null>(null);
  const [mutationSheet, setMutationSheet] = useState<EventMutationSheetMode | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expandedDay, setExpandedDay] = useState(false);
  const [calendarRefreshPending, setCalendarRefreshPending] = useState(false);
  const [liveNow, setLiveNow] = useState(() => new Date());
  const { status: accessStatus, ensureCapability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { confirmAction } = useActionConfirmation();
  const deletePendingRef = useRef(false);
  const calendarRefreshStartedRef = useRef(false);
  const { showNotice } = useNoticeCenter();
  const visibleMonth = useMemo(() => calendarMonthParts(visibleMonthKey), [visibleMonthKey]);
  const monthGrid = useMemo(
    () => calendarMonthGrid(visibleMonth.year, visibleMonth.month, DEFAULT_PLANNING_TIME_ZONE),
    [visibleMonth]
  );
  const routeRead = usePlanningRead(
    {
      queryKey: `events:month:${visibleMonthKey}:${monthGrid.range.fromUtc}:${monthGrid.range.toUtc}`,
      refreshKey: `${snapshot.revision}:${retry}`,
      reader: (signal) => readPlanningEventsForRange(monthGrid.range.fromUtc, monthGrid.range.toUtc, signal)
    }
  );
  const planning = snapshot.planning ?? null;
  const referenceTime = planningRouteReferenceTime(
    routeRead.data?.sourceStatus ?? "unavailable",
    routeRead.data?.generatedAt ?? null,
    routeRead.data?.lastSyncedAt ?? null,
    liveNow,
    false
  );
  const envelope = routeRead.data;
  useCalendarRefreshNotice(routeRead.refreshing, Boolean(envelope));
  const preview = false;
  const routeError = Boolean(routeRead.error && !routeRead.data);
  const events = calendarEventsInRange(envelope?.items ?? [], monthGrid.range);
  const selectedDayEvents = calendarEventsForLocalDay(events, selectedDate, DEFAULT_PLANNING_TIME_ZONE);
  const sources = envelope?.sources ?? planning?.providerStatuses ?? [];
  const overlapIds = eventOverlapIds(selectedDayEvents);
  const accessAllows = (action: "create" | "edit" | "delete"): boolean => {
    if (!accessStatus) return true;
    return Boolean(accessStatus.capabilities[planningCalendarAccessCapabilities[action]]?.allowed);
  };
  const canCreate = calendarMutationAllowed(planning, "create") && accessAllows("create");
  const canEdit = Boolean(selectedEvent?.localOnlyMutable && calendarMutationAllowed(planning, "edit") && accessAllows("edit"));
  const canDelete = Boolean(selectedEvent?.localOnlyMutable && !selectedEvent?.deletedAt && calendarMutationAllowed(planning, "delete") && accessAllows("delete"));
  const createAction = canCreate ? <button type="button" className="planning-primary-button" onClick={() => setMutationSheet("create")}>Создать событие</button> : undefined;

  const monthDates = useMemo(
    () => Array.from({ length: monthGrid.rows * 7 }, (_, index) => addCalendarDays(monthGrid.gridStartLocalDate, index)),
    [monthGrid]
  );

  function selectDate(localDate: string): void {
    setSelectedDate(localDate);
    setSelectedEvent(null);
  }

  function navigateMonth(delta: number): void {
    const nextMonthKey = shiftCalendarMonth(visibleMonthKey, delta);
    setVisibleMonthKey(nextMonthKey);
    setSelectedDate(`${nextMonthKey}-01`);
    setSelectedEvent(null);
  }

  function selectToday(): void {
    const today = currentLocalDate(new Date(), DEFAULT_PLANNING_TIME_ZONE);
    setVisibleMonthKey(calendarMonthKeyForDate(today));
    selectDate(today);
  }

  function refreshCalendarData(): void {
    if (calendarRefreshPending || routeRead.refreshing) return;
    calendarRefreshStartedRef.current = false;
    setCalendarRefreshPending(true);
    setRetry((value) => value + 1);
  }

  async function ensureCalendarCapability(action: "create" | "edit" | "delete", title: string): Promise<boolean> {
    const capability = planningCalendarAccessCapabilities[action];
    if (accessStatus && !accessStatus.capabilities[capability]) {
      showNotice({
        id: `planning.calendar.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Для этой операции нет разрешения в текущем профиле. Запрос не отправлен."
      });
      return false;
    }
    const allowed = await ensureCapability(capability, title);
    if (!allowed) {
      showNotice({
        id: `planning.calendar.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Эта операция запрещена текущим профилем. Запрос не отправлен."
      });
    }
    return allowed;
  }

  async function submitEventMutation(body: EventMutationBody): Promise<void> {
    if (!guardMutation()) return;
    const action = mutationSheet === "create" ? "create" : "edit";
    const target = action === "edit" ? selectedEvent : null;
    if (!await ensureCalendarCapability(action, action === "create" ? "Создать событие" : "Изменить событие")) return;
    if (!guardMutation()) return;
    setMutationPending(true);
    try {
      const result = await mutatePlanningEvent({
        action,
        idempotencyKey: newPlanningIdempotencyKey("panel-calendar"),
        eventId: target?.id,
        expectedVersion: target?.version,
        body
      });
      setSelectedEvent(result.object);
      setMutationSheet(null);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.calendar.${action}.${result.object.id}`,
        severity: "success",
        title: action === "create" ? "Событие создано" : "Событие изменено",
        detail: "Изменения сохранены."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedEvent(error.reconciledObject as PlanningCalendarEvent);
        setRetry((value) => value + 1);
        setMutationSheet(null);
        showNotice({
          id: `planning.calendar.reconciled.${target?.id ?? "create"}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат сохранения проверен."
        });
      } else {
        const conflict = error instanceof PlanningMutationError && error.mutationCode === "conflict";
        showNotice({
          id: `planning.calendar.uncertain.${target?.id ?? "create"}`,
          severity: conflict ? "warning" : "error",
          title: conflict ? "Событие изменилось или недоступно для записи" : "Результат не подтверждён",
          detail: conflict
            ? "Изменять и удалять можно только native local-only событие с актуальной версией."
            : "Успех не показан. Перечитайте событие по ID перед новой попыткой."
        });
      }
    } finally {
      setMutationPending(false);
    }
  }

  async function deleteEvent(): Promise<void> {
    if (!guardMutation() || !selectedEvent || deletePendingRef.current || !canDelete) return;
    const target = selectedEvent;
    deletePendingRef.current = true;
    setMutationPending(true);
    try {
      if (!await ensureCalendarCapability("delete", "Удалить событие")) return;
      const confirmation = await confirmAction("planning.calendar.delete", {
        target: target.title,
        revision: String(target.version)
      });
      if (!confirmation.confirmed) return;
      if (!guardMutation()) return;
      const result = await mutatePlanningEvent({
        action: "delete",
        idempotencyKey: newPlanningIdempotencyKey("panel-calendar"),
        eventId: target.id,
        expectedVersion: target.version,
        body: {}
      });
      setSelectedEvent(result.object);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.calendar.delete.${target.id}`,
        severity: "success",
        title: "Событие удалено",
        detail: "Событие удалено."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedEvent(error.reconciledObject as PlanningCalendarEvent);
        setRetry((value) => value + 1);
        showNotice({
          id: `planning.calendar.delete.reconciled.${target.id}`,
          severity: "warning",
          title: "Удаление подтверждено чтением",
          detail: "Удаление подтверждено."
        });
      } else {
        showNotice({
          id: `planning.calendar.delete.uncertain.${target.id}`,
          severity: "error",
          title: "Результат не подтверждён",
          detail: "Успех не показан. Перечитайте событие по ID перед новой попыткой."
        });
      }
    } finally {
      deletePendingRef.current = false;
      setMutationPending(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!calendarRefreshPending) return;
    if (routeRead.refreshing || routeRead.loading) {
      calendarRefreshStartedRef.current = true;
      return;
    }
    if (calendarRefreshStartedRef.current) {
      calendarRefreshStartedRef.current = false;
      setCalendarRefreshPending(false);
    }
  }, [calendarRefreshPending, routeRead.loading, routeRead.refreshing]);
  return (
    <PlanningRouteFrame
      module={calendarModule}
      eyebrow="Расписание"
      description=""
      sourceStatus={envelope?.sourceStatus ?? planning?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      sources={sources}
      error={routeRead.error}
      hasConfirmedContent={Boolean(routeRead.data)}
      refreshing={routeRead.refreshing}
      suppressRefreshWithConfirmedContent
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <CalendarMonthControls
          month={visibleMonth}
          onPrevious={() => navigateMonth(-1)}
          onToday={selectToday}
          onNext={() => navigateMonth(1)}
          futureAction={createAction}
          onRefresh={refreshCalendarData}
          refreshDisabled={calendarRefreshPending || routeRead.refreshing}
          refreshing={calendarRefreshPending || routeRead.refreshing}
        />
      )}
      testId="route-calendar"
    >
      <PlanningRouteState loading={routeRead.loading} empty={false} error={routeError} preview={preview} onRetry={() => setRetry((value) => value + 1)}>
        {envelope && (
          <div className={`calendar-month-layout${expandedDay ? " calendar-month-layout--expanded" : ""}`} data-testid="planning-calendar-month" data-expanded-day={expandedDay ? "true" : "false"}>
            <section className="calendar-month" aria-label={`Календарь ${visibleMonthKey}`} aria-hidden={expandedDay}>
              <div className="calendar-month__weekdays" aria-hidden="true">
                {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((weekday) => <span key={weekday}>{weekday}</span>)}
              </div>
              <div className="calendar-month__grid">
                {monthDates.map((localDate) => {
                  const dayEvents = calendarEventsForLocalDay(events, localDate, DEFAULT_PLANNING_TIME_ZONE);
                  const colors = [...new Set(dayEvents.map((event) => calendarEventColor(event, sources)))];
                  const inMonth = localDate.startsWith(`${visibleMonthKey}-`);
                  const dateLabel = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
                    .format(new Date(`${localDate}T12:00:00Z`));
                  const eventLabel = dayEvents.length === 0 ? "событий нет" : `событий: ${dayEvents.length}`;
                  return (
                    <button
                      type="button"
                      className={`calendar-month-cell${inMonth ? "" : " calendar-month-cell--outside"}`}
                      key={localDate}
                      data-testid="planning-calendar-month-cell"
                      data-date={localDate}
                      data-current={localDate === currentLocalDate(liveNow, DEFAULT_PLANNING_TIME_ZONE) ? "true" : "false"}
                      aria-current={localDate === currentLocalDate(liveNow, DEFAULT_PLANNING_TIME_ZONE) ? "date" : undefined}
                      aria-selected={selectedDate === localDate}
                      aria-label={`${dateLabel}, ${eventLabel}`}
                      onClick={() => selectDate(localDate)}
                    >
                      <span className="calendar-month-cell__date" aria-hidden="true">{Number(localDate.slice(-2))}</span>
                      <span className="calendar-month-cell__indicators" aria-hidden="true">
                        {colors.slice(0, 3).map((color) => <span className="calendar-month-cell__indicator" data-testid="planning-calendar-event-indicator" data-color={color} style={{ backgroundColor: color }} key={color} />)}
                        {colors.length > 3 && <span className="calendar-month-cell__overflow">+{colors.length - 3}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="calendar-selected-day" data-testid="planning-calendar-selected-day" aria-labelledby="planning-calendar-selected-day-heading">
              <div className="calendar-selected-day__heading">
                <h2 id="planning-calendar-selected-day-heading" data-testid="planning-calendar-selected-day-heading">{calendarDayLabel(selectedDate)}</h2>
                <button
                  type="button"
                  className="planning-secondary-button calendar-selected-day__expand"
                  data-testid="planning-calendar-expand"
                  aria-controls="planning-calendar-selected-day-events"
                  aria-expanded={expandedDay}
                  onClick={() => setExpandedDay((current) => !current)}
                >
                  {expandedDay ? "Свернуть день" : "Развернуть день"}
                </button>
              </div>
              {selectedDayEvents.length === 0 ? (
                <div className="calendar-selected-day__empty" data-testid="planning-calendar-selected-day-empty">Нет событий</div>
              ) : (
                <div className="calendar-selected-day__events" id="planning-calendar-selected-day-events">
                  {selectedDayEvents.filter((event) => event.allDay).length > 0 && (
                    <div className="calendar-band" data-testid="planning-calendar-all-day-band">
                      <p className="calendar-band__label">Весь день</p>
                      {selectedDayEvents.filter((event) => event.allDay).map((event) => {
                        const source = providerSourceForEvent(event, sources);
                        return <CalendarEventRow key={event.id} event={event} overlap={false} now={referenceTime} accentColor={calendarEventColor(event, sources)} sourceStale={providerSourceNeedsStaleCue(source)} onOpen={() => setSelectedEvent(event)} />;
                      })}
                    </div>
                  )}
                  <div className="calendar-timed-list">
                    {selectedDayEvents.filter((event) => !event.allDay).map((event) => {
                      const source = providerSourceForEvent(event, sources);
                      return <CalendarEventRow key={event.id} event={event} overlap={overlapIds.has(event.id)} now={referenceTime} accentColor={calendarEventColor(event, sources)} sourceStale={providerSourceNeedsStaleCue(source)} onOpen={() => setSelectedEvent(event)} />;
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </PlanningRouteState>
      {selectedEvent && !mutationSheet && (
        <CalendarDetailSheet
          event={selectedEvent}
          overlap={overlapIds.has(selectedEvent.id)}
          onClose={() => setSelectedEvent(null)}
          canEdit={canEdit}
          canDelete={canDelete}
          source={providerSourceForEvent(selectedEvent, sources)}
          mutationPending={mutationPending}
          onEdit={() => setMutationSheet("edit")}
          onDelete={() => void deleteEvent()}
        />
      )}
      {mutationSheet && (
        <CalendarMutationSheet
          mode={mutationSheet}
          event={selectedEvent}
          onClose={() => setMutationSheet(null)}
          onSubmit={submitEventMutation}
        />
      )}
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

type ReminderMutationSheetMode = "create" | "edit";

const planningReminderAccessCapabilities = {
  create: "planning.reminders.create",
  edit: "planning.reminders.edit",
  complete: "planning.reminders.complete",
  cancel: "planning.reminders.cancel"
} as const;

const planningReminderConfirmationIds: Record<"complete" | "cancel", ActionConfirmationId> = {
  complete: "planning.reminders.complete",
  cancel: "planning.reminders.cancel"
};

function reminderMutationAllowed(
  planning: PlanningSnapshot | null,
  capability: "create" | "edit" | "complete" | "cancel"
): boolean {
  return planningRemindersRouteEnabled
    && planningReminderMutationsEnabled
    && planning?.sourceStatus === "current"
    && Boolean(planning.capabilities[capability]);
}

function ReminderMutationSheet({
  mode,
  reminder,
  onClose,
  onSubmit
}: {
  mode: ReminderMutationSheetMode;
  reminder: PlanningReminder | null;
  onClose: () => void;
  onSubmit: (body: { title: string; due_at_utc: string; timezone: string }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPlanningReminder>> | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setParsing(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      void previewPlanningReminder(
        trimmed,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        reminder?.timezone ?? DEFAULT_PLANNING_TIME_ZONE,
        controller.signal
      )
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setParsing(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [reminder?.timezone, text]);

  const candidate = preview?.candidate;
  const fields = candidate?.fields ?? {};
  const canSave = Boolean(
    candidate?.domain === "reminder"
    && candidate.operation === "create"
    && preview?.confidence === "high"
    && preview.ambiguities.length === 0
    && !preview.requires_confirmation
    && typeof fields.title === "string"
    && typeof fields.due_at_utc === "string"
    && typeof fields.timezone === "string"
  );

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSubmit({
        title: fields.title as string,
        due_at_utc: fields.due_at_utc as string,
        timezone: fields.timezone as string
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PlanningSheet
      title={mode === "create" ? "Новое напоминание" : "Изменить напоминание"}
      eyebrow="Напоминание · проверка перед сохранением"
      description="Введите напоминание. Неоднозначное время нужно уточнить."
      onClose={onClose}
      testId="planning-reminder-mutation"
    >
      <div className="planning-mutation-form">
        <label className="planning-mutation-form__label" htmlFor="planning-reminder-free-text">Фраза</label>
        <textarea
          id="planning-reminder-free-text"
          className="planning-mutation-form__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Например: завтра в 16:00 напомни позвонить врачу"
          rows={3}
          autoFocus
        />
        {parsing && <p className="planning-mutation-form__status">Проверяем формулировку…</p>}
        {preview && (
          <section className="planning-mutation-preview" data-testid="planning-reminder-preview" aria-live="polite">
            <p className="planning-mutation-preview__eyebrow">Человеческая расшифровка</p>
            <p className="planning-mutation-preview__restatement">
              {candidate?.normalized_paraphrase ?? "Предложение пока не сформировано."}
            </p>
            {preview.ambiguities.length > 0 && (
              <div className="planning-mutation-preview__ambiguities" data-testid="planning-reminder-ambiguities">
                <strong>Нужно уточнить</strong>
                {preview.ambiguities.map((ambiguity) => (
                  <p key={`${ambiguity.field}-${ambiguity.reason}`}>
                    {ambiguity.reason}{ambiguity.candidates.length ? ` Варианты: ${ambiguity.candidates.join(", ")}.` : ""}
                  </p>
                ))}
              </div>
            )}
            {preview.error_code && <p className="planning-mutation-form__error">Формулировка не подтверждена: {preview.error_code}.</p>}
          </section>
        )}
        <p className="planning-detail-note">
          {mode === "edit" && reminder ? `Текущая запись: ${reminder.title}. Изменения появятся после сохранения.` : "Сохранить можно только однозначное напоминание."}
        </p>
      </div>
      <div className="planning-sheet-actions">
        <button type="button" className="planning-secondary-button" onClick={onClose}>Отмена</button>
        <button type="button" className="planning-primary-button" disabled={!canSave || parsing || saving} onClick={() => void save()}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </PlanningSheet>
  );
}

function ReminderDetailSheet({
  reminder,
  onClose,
  canEdit,
  canComplete,
  canCancel,
  lifecyclePending,
  onEdit,
  onComplete,
  onCancel
}: {
  reminder: PlanningReminder;
  onClose: () => void;
  canEdit: boolean;
  canComplete: boolean;
  canCancel: boolean;
  lifecyclePending: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const active = reminder.status === "pending" || reminder.status === "due";
  return (
    <PlanningSheet title={reminder.title} eyebrow="Напоминание" onClose={onClose} testId="planning-reminder-detail">
      <dl className="planning-detail-list">
        <ReadOnlyField label="Срок" value={formatReminderExactDue(reminder)} />
        <ReadOnlyField label="Жизненный цикл" value={lifecycleLabels[reminder.status]} />
        <ReadOnlyField label="Доставка" value={deliveryLabels[reminder.deliveryState]} />
        <ReadOnlyField label="Часовой пояс" value={reminder.timezone} />
        <ReadOnlyField label="Источник" value={reminder.sourceLabel} />
      </dl>
      {active && (canEdit || canComplete || canCancel) && (
        <div className="planning-sheet-actions planning-sheet-actions--stacked">
          {canEdit && <button type="button" className="planning-secondary-button" onClick={onEdit}>Изменить</button>}
          {canComplete && <button type="button" className="planning-primary-button" disabled={lifecyclePending} onClick={onComplete}>Завершить явно</button>}
          {canCancel && <button type="button" className="planning-secondary-button" disabled={lifecyclePending} onClick={onCancel}>Отменить явно</button>}
        </div>
      )}
      <p className="planning-detail-note">Доставлено не означает завершено. Напоминание остаётся активным до явного завершения или отмены.</p>
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
  const [mutationSheet, setMutationSheet] = useState<ReminderMutationSheetMode | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [retry, setRetry] = useState(0);
  const { showNotice } = useNoticeCenter();
  const { status: accessStatus, ensureCapability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { confirmAction } = useActionConfirmation();
  const lifecyclePendingRef = useRef(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const routeRead = usePlanningRead(
    {
      queryKey: `reminders:${view}:${page}`,
      refreshKey: `${snapshot.revision}:${retry}`,
      reader: (signal) => readPlanningReminders(view, 20, page * 20, signal)
    }
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
  const routeError = Boolean(routeRead.error && !routeRead.data && !fallback);
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
  const accessAllows = (action: keyof typeof planningReminderAccessCapabilities): boolean => {
    if (!accessStatus) return true;
    return Boolean(accessStatus.capabilities[planningReminderAccessCapabilities[action]]?.allowed);
  };
  const canCreate = reminderMutationAllowed(planning, "create") && accessAllows("create");
  const canEdit = reminderMutationAllowed(planning, "edit")
    && accessAllows("edit")
    && Boolean(selectedReminder && ["pending", "due"].includes(selectedReminder.status));
  const canComplete = reminderMutationAllowed(planning, "complete")
    && accessAllows("complete")
    && Boolean(selectedReminder && ["pending", "due"].includes(selectedReminder.status));
  const canCancel = reminderMutationAllowed(planning, "cancel")
    && accessAllows("cancel")
    && Boolean(selectedReminder && ["pending", "due"].includes(selectedReminder.status));

  async function ensurePlanningCapability(
    action: keyof typeof planningReminderAccessCapabilities,
    title: string
  ): Promise<boolean> {
    const capability = planningReminderAccessCapabilities[action];
    if (accessStatus && !accessStatus.capabilities[capability]) {
      showNotice({
        id: `planning.reminder.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Для этой операции нет разрешения в текущем профиле. Запрос не отправлен."
      });
      return false;
    }
    const allowed = await ensureCapability(capability, title);
    if (!allowed) {
      showNotice({
        id: `planning.reminder.access.${action}`,
        severity: "warning",
        title: "Действие недоступно",
        detail: "Эта операция запрещена текущим профилем. Запрос не отправлен."
      });
    }
    return allowed;
  }

  async function submitMutation(body: { title: string; due_at_utc: string; timezone: string }): Promise<void> {
    if (!guardMutation()) return;
    const action = mutationSheet === "create" ? "create" : "edit";
    const target = mutationSheet === "edit" ? selectedReminder : null;
    if (!await ensurePlanningCapability(action, action === "create" ? "Создать напоминание" : "Изменить напоминание")) return;
    if (!guardMutation()) return;
    try {
      const result = await mutatePlanningReminder({
        action,
        idempotencyKey: newPlanningIdempotencyKey(),
        reminderId: target?.id,
        expectedVersion: target?.version,
        body
      });
      setSelectedReminder(result.object);
      setMutationSheet(null);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.reminder.${action}.${result.object.id}`,
        severity: "success",
        title: action === "create" ? "Напоминание создано" : "Напоминание изменено",
        detail: "Изменения сохранены."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedReminder(error.reconciledObject as PlanningReminder);
        setRetry((value) => value + 1);
        setMutationSheet(null);
        showNotice({
          id: `planning.reminder.reconciled.${error.reconciledObject.id}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат сохранения проверен."
        });
        return;
      }
      showNotice({
        id: `planning.reminder.uncertain.${target?.id ?? "create"}`,
        severity: error instanceof PlanningMutationError && error.mutationCode === "conflict" ? "warning" : "error",
        title: error instanceof PlanningMutationError && error.mutationCode === "conflict" ? "Напоминание изменилось" : "Результат не подтверждён",
        detail: error instanceof PlanningMutationError && error.mutationCode === "conflict"
          ? "Запись уже изменилась. Сначала перечитайте её."
          : "Результат не подтверждён. Повторите чтение перед новой попыткой."
      });
    }
  }

  async function runAction(action: "complete" | "cancel"): Promise<void> {
    if (!guardMutation() || !selectedReminder || lifecyclePendingRef.current) return;
    const target = selectedReminder;
    const reminderId = target.id;
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    try {
      if (!await ensurePlanningCapability(action, action === "complete" ? "Завершить напоминание" : "Отменить напоминание")) return;
      const confirmation = await confirmAction(planningReminderConfirmationIds[action], {
        target: target.title,
        revision: String(target.version)
      });
      if (!confirmation.confirmed) return;
      if (!guardMutation()) return;
      const result = await mutatePlanningReminder({
        action,
        idempotencyKey: newPlanningIdempotencyKey(),
        reminderId,
        expectedVersion: target.version,
        body: {}
      });
      setSelectedReminder(result.object);
      setRetry((value) => value + 1);
      showNotice({
        id: `planning.reminder.${action}.${result.object.id}`,
        severity: "success",
        title: action === "complete" ? "Напоминание завершено" : "Напоминание отменено",
        detail: "Это явное изменение жизненного цикла; доставка не меняет статус автоматически."
      });
    } catch (error) {
      if (error instanceof PlanningMutationError && error.reconciledObject) {
        setSelectedReminder(error.reconciledObject as PlanningReminder);
        setRetry((value) => value + 1);
        showNotice({
          id: `planning.reminder.reconciled.${reminderId}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат изменения проверен."
        });
        return;
      }
      showNotice({
        id: `planning.reminder.action-uncertain.${reminderId}`,
        severity: "error",
        title: "Результат не подтверждён",
        detail: "Успех не показан. Перечитайте запись перед повторной попыткой."
      });
    } finally {
      lifecyclePendingRef.current = false;
      setLifecyclePending(false);
    }
  }

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
      hasConfirmedContent={Boolean(routeRead.data)}
      refreshing={routeRead.refreshing}
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <>
          <ReminderSegments view={view} onChange={setView} />
          <span className="planning-route-note">Доставка и завершение разделены</span>
        </>
      )}
      futureAction={canCreate ? <button type="button" className="planning-primary-button" onClick={() => setMutationSheet("create")}>Создать напоминание</button> : undefined}
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
      {selectedReminder && !mutationSheet && (
        <ReminderDetailSheet
          reminder={selectedReminder}
          onClose={() => setSelectedReminder(null)}
          canEdit={canEdit}
          canComplete={canComplete}
          canCancel={canCancel}
          lifecyclePending={lifecyclePending}
          onEdit={() => setMutationSheet("edit")}
          onComplete={() => void runAction("complete")}
          onCancel={() => void runAction("cancel")}
        />
      )}
      {mutationSheet && (
        <ReminderMutationSheet
          mode={mutationSheet}
          reminder={selectedReminder}
          onClose={() => setMutationSheet(null)}
          onSubmit={submitMutation}
        />
      )}
    </PlanningRouteFrame>
  );
}
