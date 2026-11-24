import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  PlanningCalendarEvent,
  PlanningCalendarSource,
  PlanningProject,
  PlanningSnapshot,
  PlanningTask
} from "@artem/contracts";
import type { ShellNavigationTarget } from "./Shell";
import {
  currentLocalDate,
  DEFAULT_PLANNING_TIME_ZONE,
  addCalendarDays,
  localDateForInstant
} from "./calendarRange";
import { calendarMonthGrid, calendarMonthKeyForDate, shiftCalendarMonth } from "./calendarMonth";
import {
  mutatePlanningEvent,
  mutatePlanningProviderEvent,
  mutatePlanningTask,
  newPlanningIdempotencyKey,
  PlanningMutationError,
  previewPlanningTask,
  readPlanningEventById,
  readPlanningEventsForRange,
  readPlanningCalendarDestinations,
  readPlanningProjects,
  readPlanningTasks,
  refreshPlanningCalendarSources,
  usePlanningRead,
  type TaskRouteView
} from "./planningReadClient";
import {
  eventOverlapIds,
  eventTemporalState,
  calendarEventColor,
  calendarEventsForLocalDay,
  calendarEventsInRange,
  formatEventRange,
  formatTaskDueForRoute,
  lifecycleLabels,
  priorityLabels,
  projectNameForTask,
  planningRouteReferenceTime,
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
  planningCalendarMutationsEnabled,
  planningRemindersRouteEnabled,
  planningTaskMutationsEnabled,
  planningTasksRouteEnabled
} from "./planningRouteConfig";
import { planningModuleForRoute } from "./planningModuleRegistry";
import { calendarIdentityForEvent, calendarIdentityLabel } from "./planningIdentity";
import { useNoticeCenter } from "./NoticeCenter";
import { calendarSourceRefreshPresentation } from "./calendarRefreshPresentation";
import { useAccess } from "./AccessControls";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { useCalendarDisplayPreferences } from "./CalendarDisplayPreferences";
import { resolveCalendarDisplayColor } from "./calendarDisplayColors";
import { CalendarMutationSheet } from "./CalendarMutationSheet";
import type { CalendarEditorDestination } from "./calendarEventEditor";
import { Icon } from "./icons";
import type { ActionConfirmationId } from "./actionConfirmationCatalog";
import {
  TASK_TITLE_MAX_LENGTH,
  taskMutationBodyFromUndatedTitle,
  taskMutationBodyFromPreview,
  type TaskDueMode,
  type TaskMutationBody,
  type TaskMutationSheetMode
} from "./taskMutationBody";
import {
  type EventMutationBody,
  type EventMutationSheetMode
} from "./eventMutationBody";
import { calendarDateFromSearch, calendarLocalDateForEvent } from "./calendarNavigation";
import { localDateTimeForUtc } from "./reminderMutationBody";

const tasksModule = planningModuleForRoute("/tasks")!;
const calendarModule = planningModuleForRoute("/calendar")!;

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

function TasksSegments({ view, onChange }: { view: TaskRouteView; onChange: (view: TaskRouteView) => void }) {
  return (
    <div className="planning-segmented" role="group" aria-label="Представление задач">
      {(Object.keys(taskViewLabels) as TaskRouteView[]).map((value) => (
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
    && planning?.taskMutationsEnabled === true
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
  const [dueMode, setDueMode] = useState<TaskDueMode>(() => (
    mode === "edit"
    && task?.dueDate === null
    && task.dueTime === null
    && task.timezone === null
      ? "undated"
      : "dated"
  ));
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPlanningTask>> | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dueMode === "undated") {
      setPreview(null);
      setParsing(false);
      return undefined;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setParsing(false);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => {
      setParsing(true);
      void previewPlanningTask(
        trimmed,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        DEFAULT_PLANNING_TIME_ZONE,
        controller.signal
      )
        .then((nextPreview) => {
          if (active) setPreview(nextPreview);
        })
        .catch(() => {
          if (active) setPreview(null);
        })
        .finally(() => {
          if (active) setParsing(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [dueMode, text]);

  const visiblePreview = dueMode === "dated" ? preview : null;
  const candidate = visiblePreview?.candidate;
  const fields = candidate?.fields ?? {};
  const priority = fields.priority;
  const datedCanSave = Boolean(
    candidate?.domain === "task"
    && candidate.operation === "create"
    && visiblePreview?.confidence === "high"
    && visiblePreview.ambiguities.length === 0
    && !visiblePreview.requires_confirmation
    && typeof fields.title === "string"
    && (priority === "none" || priority === "low" || priority === "normal" || priority === "high")
  );
  const undatedBody = dueMode === "undated" ? taskMutationBodyFromUndatedTitle(mode, text) : null;
  const canSave = dueMode === "undated" ? Boolean(undatedBody) : datedCanSave;
  const undatedTitle = text.trim();
  const undatedTitleError = dueMode === "undated"
    ? !undatedTitle
      ? "Введите название задачи."
      : [...undatedTitle].length > TASK_TITLE_MAX_LENGTH
        ? `Название не должно превышать ${TASK_TITLE_MAX_LENGTH} символов.`
        : null
    : null;

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    const body = dueMode === "undated"
      ? undatedBody
      : taskMutationBodyFromPreview(mode, fields);
    if (!body) {
      setSaving(false);
      return;
    }
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
      description="Выберите режим срока. В режиме «Со сроком» текст проверяется Alice, а «Без срока» сохраняет введённый текст как название без разбора даты."
      onClose={onClose}
      testId="planning-task-mutation"
    >
      <div className="planning-mutation-form">
        <div className="planning-segmented" role="group" aria-label="Срок задачи" data-testid="planning-task-due-mode">
          <button
            type="button"
            className={dueMode === "dated" ? "is-active" : ""}
            aria-pressed={dueMode === "dated"}
            onClick={() => setDueMode("dated")}
          >
            Со сроком
          </button>
          <button
            type="button"
            className={dueMode === "undated" ? "is-active" : ""}
            aria-pressed={dueMode === "undated"}
            onClick={() => setDueMode("undated")}
          >
            Без срока
          </button>
        </div>
        <label className="planning-mutation-form__label" htmlFor="planning-task-free-text">Фраза</label>
        <textarea
          id="planning-task-free-text"
          className="planning-mutation-form__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={dueMode === "undated" ? "Например: Разобрать входящие" : "Например: завтра купить продукты или завтра в 18:30 отправить отчёт"}
          rows={3}
          autoFocus
        />
        {dueMode === "dated" && parsing && <p className="planning-mutation-form__status">Проверяем формулировку…</p>}
        {undatedTitleError && <p className="planning-mutation-form__error" data-testid="planning-task-undated-error">{undatedTitleError}</p>}
        {visiblePreview && (
          <section className="planning-mutation-preview" data-testid="planning-task-preview" aria-live="polite">
            <p className="planning-mutation-preview__eyebrow">Человеческая расшифровка</p>
            <p className="planning-mutation-preview__restatement">{candidate?.normalized_paraphrase ?? "Предложение пока не сформировано."}</p>
            {visiblePreview.ambiguities.length > 0 && (
              <div className="planning-mutation-preview__ambiguities" data-testid="planning-task-ambiguities">
                <strong>Нужно уточнить</strong>
                {visiblePreview.ambiguities.map((ambiguity) => (
                  <p key={`${ambiguity.field}-${ambiguity.reason}`}>{ambiguity.reason}{ambiguity.candidates.length ? ` Варианты: ${ambiguity.candidates.join(", ")}.` : ""}</p>
                ))}
              </div>
            )}
            {visiblePreview.error_code && <p className="planning-mutation-form__error">Формулировка не подтверждена: {visiblePreview.error_code}.</p>}
          </section>
        )}
        <p className="planning-detail-note">
          {dueMode === "undated"
            ? "Текст сохранится буквально, без даты, времени, часового пояса и скрытого разбора других полей."
            : mode === "edit" && task
              ? `Текущая запись: ${task.title}. Изменения появятся после сохранения.`
              : "Сохранить можно только однозначную задачу."}
        </p>
      </div>
      <div className="planning-sheet-actions">
        <button type="button" className="planning-secondary-button" onClick={onClose}>Отмена</button>
        <button type="button" className="planning-primary-button" disabled={!canSave || (dueMode === "dated" && parsing) || saving} onClick={() => void save()}>
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
  const [view, setView] = useState<TaskRouteView>("today");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<PlanningTask | null>(null);
  const [mutationSheet, setMutationSheet] = useState<TaskMutationSheetMode | null>(null);
  const [retry, setRetry] = useState(0);
  const { showNotice } = useNoticeCenter();
  const { status: accessStatus, available: accessAvailable, ensureCapability } = useAccess();
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
    ? previewEnvelope("task", view === "undated" ? (planning.tasks.undated ?? []) : planning.tasks[view], planning)
    : null;
  const envelope = routeRead.data ?? fallback;
  const preview = !routeRead.data && Boolean(fallback) && Boolean(routeRead.error);
  const routeError = Boolean(routeRead.error && !routeRead.data && !fallback);
  const projects = projectRead.data?.items ?? (planning?.tasks.projects ?? []);
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const projectFilterLabel = projectId ? (projectMap.get(projectId) ?? "Проект недоступен") : "Все проекты";
  const accessAllows = (action: keyof typeof planningTaskAccessCapabilities): boolean => {
    if (!accessAvailable || !accessStatus) return false;
    return Boolean(accessStatus.capabilities[planningTaskAccessCapabilities[action]]?.allowed);
  };
  const currentPlanning = planning?.sourceStatus === "current";
  const taskFrontendWriterDisabled = !planningTaskMutationsEnabled;
  const taskServerWriterDisabled = currentPlanning
    && planningTaskMutationsEnabled
    && planning?.taskMutationsEnabled === false;
  const taskWriterGateMetadataUnavailable = currentPlanning
    && planningTaskMutationsEnabled
    && planning?.taskMutationsEnabled === undefined;
  const taskAccessUnavailable = currentPlanning
    && !taskFrontendWriterDisabled
    && !taskServerWriterDisabled
    && !taskWriterGateMetadataUnavailable
    && (!accessAvailable || !accessStatus);
  const taskAccessBlocked = currentPlanning
    && !taskFrontendWriterDisabled
    && !taskServerWriterDisabled
    && !taskWriterGateMetadataUnavailable
    && accessAvailable
    && Boolean(accessStatus)
    && !(Object.keys(planningTaskAccessCapabilities) as Array<keyof typeof planningTaskAccessCapabilities>).some(accessAllows);
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
    if (taskFrontendWriterDisabled) {
      showNotice({
        id: `planning.task.frontend-gate.${action}`,
        severity: "warning",
        title: "Изменения задач отключены в этой сборке",
        detail: "Интерфейс записи задач отключён. Запрос не отправлен."
      });
      return false;
    }
    if (taskServerWriterDisabled) {
      showNotice({
        id: `planning.task.server-gate.${action}`,
        severity: "warning",
        title: "Изменения задач отключены сервером",
        detail: "Серверный gate записи задач отключён. Запрос не отправлен."
      });
      return false;
    }
    if (taskWriterGateMetadataUnavailable) {
      showNotice({
        id: `planning.task.gate-unavailable.${action}`,
        severity: "warning",
        title: "Серверный gate не подтверждён",
        detail: "Серверный gate записи задач не подтверждён. Запрос не отправлен."
      });
      return false;
    }
    if (!accessAvailable || !accessStatus) {
      showNotice({
        id: `planning.task.access.unavailable.${action}`,
        severity: "warning",
        title: "Проверка доступа недоступна",
        detail: "Профиль доступа не подтверждён. Запрос не отправлен."
      });
      return false;
    }
    const capability = planningTaskAccessCapabilities[action];
    if (!accessStatus.capabilities[capability]) {
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
      const mutationError = error instanceof PlanningMutationError ? error : null;
      const conflict = mutationError?.mutationCode === "conflict";
      const disabled = mutationError?.mutationCode === "disabled";
      const notFound = mutationError?.mutationCode === "not_found";
      if (notFound) {
        setSelectedTask(null);
        setMutationSheet(null);
        setRetry((value) => value + 1);
      }
      showNotice({
        id: `planning.task.uncertain.${target?.id ?? "create"}`,
        severity: conflict || disabled || notFound ? "warning" : "error",
        title: conflict
          ? "Задача изменилась"
          : disabled
            ? "Изменения задач отключены"
            : notFound
              ? "Задача больше не найдена"
              : "Результат не подтверждён",
        detail: conflict
          ? "Запись уже изменилась. Сначала перечитайте её."
          : disabled
            ? "Серверный gate записи задач отключён. Запрос не отправлен повторно."
            : notFound
              ? "Актуальная запись не найдена. Список обновлён."
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
      const mutationError = error instanceof PlanningMutationError ? error : null;
      const conflict = mutationError?.mutationCode === "conflict";
      const disabled = mutationError?.mutationCode === "disabled";
      const notFound = mutationError?.mutationCode === "not_found";
      if (notFound) {
        setSelectedTask(null);
        setRetry((value) => value + 1);
      }
      showNotice({
        id: `planning.task.action-uncertain.${target.id}`,
        severity: conflict || disabled || notFound ? "warning" : "error",
        title: conflict
          ? "Задача изменилась"
          : disabled
            ? "Изменения задач отключены"
            : notFound
              ? "Задача больше не найдена"
              : "Результат не подтверждён",
        detail: conflict
          ? "Запись уже изменилась. Сначала перечитайте её."
          : disabled
            ? "Серверный gate записи задач отключён."
            : notFound
              ? "Актуальная запись не найдена. Список обновлён."
              : "Результат не подтверждён. Перечитайте запись перед повторной попыткой."
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
      sourceStatus={envelope?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      error={routeRead.error}
      loading={routeRead.loading}
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
          {taskFrontendWriterDisabled && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-task-mutation-frontend-gate">
              Запись задач отключена в этой сборке. Доступ к профилю этого не меняет.
            </span>
          )}
          {taskServerWriterDisabled && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-task-mutation-gate">
              Запись задач отключена серверным gate. Доступ к профилю этого не меняет.
            </span>
          )}
          {taskWriterGateMetadataUnavailable && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-task-mutation-gate-unavailable">
              Серверный gate записи задач не подтверждён. Запись временно заблокирована.
            </span>
          )}
          {taskAccessBlocked && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-task-access-blocked">
              Текущий профиль не разрешает изменять задачи. Запрос не отправляется.
            </span>
          )}
          {taskAccessUnavailable && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-task-access-unavailable">
              Проверка профиля доступа недоступна. Запись задач временно заблокирована.
            </span>
          )}
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
    && planning?.calendarMutationsEnabled === true
    && planning?.sourceStatus === "current"
    && Boolean(planning?.capabilities.calendar[capability]);
}

function providerCalendarMutationAllowed(
  planning: PlanningSnapshot | null,
  capability: "create" | "edit" | "delete"
): boolean {
  return planningCalendarRouteEnabled
    && planningCalendarMutationsEnabled
    && planning?.providerCalendarMutationsEnabled === true
    && planning?.sourceStatus === "current"
    && Boolean(planning?.capabilities.calendar[capability]);
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
  if (value === "local_only") return null;
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

function calendarRowTimeLabel(event: PlanningCalendarEvent): string {
  if (event.allDay) return "Весь день";
  if (!event.startAtUtc || !event.endAtUtc) return "Время не указано";
  const clock = (utc: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: event.timezone }).format(new Date(utc));
  const nextDay = localDateForInstant(new Date(event.startAtUtc), event.timezone) !== localDateForInstant(new Date(event.endAtUtc), event.timezone);
  return `${clock(event.startAtUtc)}–${clock(event.endAtUtc)}${nextDay ? " +1" : ""}`;
}

function calendarDetailTimeLabel(event: PlanningCalendarEvent): string {
  if (!event.startAtUtc || !event.endAtUtc) return "Время не указано";
  const start = localDateTimeForUtc(event.startAtUtc, event.timezone);
  const end = localDateTimeForUtc(event.endAtUtc, event.timezone);
  return `${start.time} — ${start.date === end.date ? "" : `${end.date} `}${end.time}`;
}

function CalendarEventRow({ event, overlap, now, onOpen, sourceStale, accentColor, markerStyle }: { event: PlanningCalendarEvent; overlap: boolean; now: Date; onOpen: () => void; sourceStale: boolean; accentColor: string; markerStyle: "dots" | "bars" }) {
  const state = eventTemporalState(event, now);
  const identity = calendarIdentityForEvent(event);
  return (
    <button
      type="button"
      className={`planning-route-row calendar-event-row calendar-event-row--${state}${overlap ? " calendar-event-row--overlap" : ""}`}
      style={{ "--calendar-event-accent": accentColor } as CSSProperties}
      data-testid="planning-calendar-event-row"
      data-marker-style={markerStyle}
      data-sync-state={event.syncState}
      data-overlap={overlap ? "true" : "false"}
      onClick={onOpen}
    >
      <span className="calendar-event-row__time">{calendarRowTimeLabel(event)}</span>
      {markerStyle === "dots" && <span className="calendar-event-row__dot" data-testid="planning-calendar-event-color-dot" data-color={accentColor} aria-hidden="true" />}
      <span className="planning-route-row__main">
        <strong>{event.title}</strong>
        <span className="planning-route-row__source planning-calendar-state-line">
          <span data-testid="planning-calendar-identity" title={calendarIdentityLabel(event)}>{identity.calendarLabel}</span>
          {syncWarningLabel(event.syncState) && <span data-testid="planning-calendar-sync-warning">{syncWarningLabel(event.syncState)}</span>}
          {sourceStale && <span data-testid="planning-calendar-stale-cue">Сохранённая копия</span>}
        </span>
      </span>
      <span className="calendar-event-row__badges">
        {state === "running" && <span className="calendar-badge calendar-badge--running">Идёт</span>}
        {state === "past" && <span className="calendar-badge">Завершено</span>}
        {overlap && <span className="calendar-badge calendar-badge--overlap">Пересекается</span>}
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
  const deleted = Boolean(event.deletedAt);
  const eventDate = calendarLocalDateForEvent(event);
  return (
    <PlanningSheet
      title={event.title}
      eyebrow="Календарь"
      onClose={onClose}
      testId="planning-calendar-detail"
      footer={!deleted && (canEdit || canDelete) ? <div className="calendar-detail__actions">
        {canEdit && <button type="button" className="planning-primary-button" disabled={mutationPending} onClick={onEdit}>Изменить</button>}
        {canDelete && <button type="button" className="planning-secondary-button calendar-detail__delete" disabled={mutationPending} onClick={onDelete}>Удалить</button>}
      </div> : undefined}
    >
      <div className="calendar-detail__lead">
        {eventDate && <p className="calendar-detail__date">{calendarDayLabel(eventDate)}</p>}
        <p className="calendar-detail__time">{event.allDay ? "Весь день" : calendarDetailTimeLabel(event)}</p>
        {event.allDay && event.startDate !== (event.endDateExclusive ? addCalendarDays(event.endDateExclusive, -1) : null) && <p className="calendar-detail__span">{formatEventRange(event)}</p>}
        {event.location && <p className="calendar-detail__location">{event.location}</p>}
        {event.notes && <div className="calendar-detail__notes"><span>Заметки</span><p>{event.notes}</p></div>}
      </div>
      {!deleted && !canEdit && !canDelete && <p className="calendar-detail__readonly">Только просмотр · редактирование недоступно</p>}
      {deleted && <p className="calendar-detail__readonly">Событие удалено.</p>}
      <section className="calendar-detail__metadata" aria-label="Источник и состояние">
        <h3>Источник и состояние</h3>
        <dl className="planning-detail-list">
          <ReadOnlyField label="Календарь" value={identity.calendarLabel} />
          <ReadOnlyField label="Источник" value={identity.providerLabel} />
          <ReadOnlyField label="Синхронизация" value={syncStateLabel(event.syncState)} />
          {source && <ReadOnlyField label="Данные источника" value={providerStatusLabel(source) ?? "Локально"} />}
          {source?.kind === "external" && source.lastSyncedAt && <ReadOnlyField label="Обновлено" value={syncTimeLabel(source.lastSyncedAt) ?? source.lastSyncedAt} />}
          <ReadOnlyField label="Часовой пояс" value={event.timezone} />
          {overlap && <ReadOnlyField label="Пересечение" value="Пересекается с другим событием" />}
        </dl>
      </section>
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
        <button type="button" className="planning-secondary-button planning-calendar-month-nav-button" aria-label="Предыдущий месяц" onClick={onPrevious}>‹</button>
        <strong className="planning-calendar-month-controls__label" data-testid="planning-calendar-month-heading">{label}</strong>
        <button type="button" className="planning-secondary-button planning-calendar-month-nav-button" aria-label="Следующий месяц" onClick={onNext}>›</button>
      </div>
      <div className="planning-calendar-today-control" data-testid="planning-calendar-today-control" role="group" aria-label="Переход к сегодняшнему дню">
        <button type="button" className="planning-secondary-button" onClick={onToday}>Сегодня</button>
        {futureAction && <div className="planning-future-action-slot" data-testid="planning-future-action-slot">{futureAction}</div>}
        <button
          type="button"
          className={`planning-icon-button${refreshing ? " planning-icon-button--busy" : ""}`}
          aria-label={refreshing ? "Обновляются источники календаря" : "Обновить источники календаря"}
          title="Обновить источники календаря"
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
  const [mutationConflict, setMutationConflict] = useState(false);
  const [editorReloadRevision, setEditorReloadRevision] = useState(0);
  const [mutationPending, setMutationPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [providerDestinations, setProviderDestinations] = useState<Awaited<ReturnType<typeof readPlanningCalendarDestinations>> | null>(null);
  const [expandedDay, setExpandedDay] = useState(false);
  const [calendarRefreshPending, setCalendarRefreshPending] = useState(false);
  const [liveNow, setLiveNow] = useState(() => new Date());
  const { status: accessStatus, available: accessAvailable, ensureCapability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { preferences: calendarDisplayPreferences } = useCalendarDisplayPreferences();
  const calendarEventMarkerStyle = calendarDisplayPreferences?.eventMarkerStyle ?? "dots";
  const { confirmAction } = useActionConfirmation();
  const deletePendingRef = useRef(false);
  const calendarRefreshLockRef = useRef(false);
  const calendarRefreshInFlightRef = useRef(false);
  const calendarRefreshControllerRef = useRef<AbortController | null>(null);
  const planningSourcesRef = useRef(snapshot.planning?.providerStatuses ?? []);
  planningSourcesRef.current = snapshot.planning?.providerStatuses ?? planningSourcesRef.current;
  const calendarRouteMountedRef = useRef(true);
  const { showNotice } = useNoticeCenter();
  useEffect(() => {
    calendarRouteMountedRef.current = true;
    return () => {
      calendarRouteMountedRef.current = false;
      calendarRefreshControllerRef.current?.abort();
      if (calendarRefreshInFlightRef.current) {
        showNotice({
          id: "planning.calendar.refresh.result",
          severity: "warning",
          title: "Обновление календаря не подтверждено",
          detail: "Страница была закрыта до проверки результата. Последние подтверждённые данные сохранены.",
          timeoutMs: 8_000,
          testId: "planning-calendar-refresh-result"
        });
      }
    };
  }, [showNotice]);
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
  useEffect(() => {
    const controller = new AbortController();
    void readPlanningCalendarDestinations(controller.signal)
      .then(setProviderDestinations)
      .catch(() => setProviderDestinations(null));
    return () => controller.abort();
  }, [snapshot.revision, retry]);
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
    if (!accessAvailable || !accessStatus) return false;
    return Boolean(accessStatus.capabilities[planningCalendarAccessCapabilities[action]]?.allowed);
  };
  const currentPlanning = planning?.sourceStatus === "current";
  const calendarFrontendWriterDisabled = !planningCalendarMutationsEnabled;
  const calendarServerWriterDisabled = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.calendarMutationsEnabled === false;
  const providerServerWriterDisabled = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.providerCalendarMutationsEnabled === false;
  const providerWriterGateMetadataUnavailable = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.providerCalendarMutationsEnabled === undefined;
  const calendarWriterGateMetadataUnavailable = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.calendarMutationsEnabled === undefined;
  const calendarAccessUnavailable = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.calendarMutationsEnabled === true
    && (!accessAvailable || !accessStatus);
  const calendarAccessBlocked = currentPlanning
    && planningCalendarMutationsEnabled
    && planning?.calendarMutationsEnabled === true
    && accessAvailable
    && Boolean(accessStatus)
    && !(Object.keys(planningCalendarAccessCapabilities) as Array<keyof typeof planningCalendarAccessCapabilities>).some(accessAllows);
  const nativeSource = sources.find((source) => source.kind === "native");
  const nativeCalendar = nativeSource?.calendars[0];
  const localDestination: CalendarEditorDestination = {
    id: `${nativeSource?.id ?? "local-planning"}:${nativeCalendar?.id ?? "local"}`,
    label: nativeCalendar?.label ?? "Локальный календарь",
    color: resolveCalendarDisplayColor({
      providerId: nativeSource?.id ?? "local-planning",
      calendarId: nativeCalendar?.id ?? "local",
      providerColor: nativeCalendar?.color,
      overrides: calendarDisplayPreferences?.overrides ?? [],
      local: true
    }),
    writable: mutationSheet === "edit"
      ? Boolean(selectedEvent?.canEdit ?? (selectedEvent?.localOnlyMutable && selectedEvent.syncState === "local_only"))
      : calendarMutationAllowed(planning, "create") && accessAllows("create"),
    providerKind: "local"
  };
  const providerEditorDestinations: CalendarEditorDestination[] = (providerDestinations?.items ?? []).map((destination) => {
    const source = sources.find((candidate) => candidate.kind === "external" && candidate.calendars.some((calendar) => calendar.id === destination.id));
    return {
      id: destination.id,
      label: destination.label,
      color: resolveCalendarDisplayColor({
        providerId: source?.id ?? "external-icloud",
        calendarId: destination.id,
        providerColor: destination.color,
        overrides: calendarDisplayPreferences?.overrides ?? []
      }),
      writable: destination.canCreateEvent && providerCalendarMutationAllowed(planning, "create") && accessAllows("create"),
      providerKind: "icloud"
    };
  });
  const selectedIsLocal = Boolean(selectedEvent?.localOnlyMutable && selectedEvent.syncState === "local_only");
  const selectedCapabilityEdit = selectedEvent?.canEdit ?? selectedIsLocal;
  const selectedCapabilityDelete = selectedEvent?.canDelete ?? selectedIsLocal;
  const canCreate = (
    (calendarMutationAllowed(planning, "create") || providerEditorDestinations.some((destination) => destination.writable))
    && accessAllows("create")
  );
  const canEdit = Boolean(
    selectedEvent
    && selectedCapabilityEdit
    && (selectedIsLocal ? calendarMutationAllowed(planning, "edit") : providerCalendarMutationAllowed(planning, "edit"))
    && accessAllows("edit")
  );
  const canDelete = Boolean(
    selectedEvent
    && !selectedEvent.deletedAt
    && selectedCapabilityDelete
    && (selectedIsLocal ? calendarMutationAllowed(planning, "delete") : providerCalendarMutationAllowed(planning, "delete"))
    && accessAllows("delete")
  );
  const selectedProviderDestination: CalendarEditorDestination | null = selectedEvent && !selectedIsLocal
    ? (() => {
      const identity = calendarIdentityForEvent(selectedEvent);
      const known = providerEditorDestinations.find((destination) => destination.id === identity.calendarId);
      if (known) return { ...known, writable: canEdit };
      return {
        id: identity.calendarId,
        label: identity.calendarLabel,
        color: resolveCalendarDisplayColor({
          providerId: identity.providerId,
          calendarId: identity.calendarId,
          overrides: calendarDisplayPreferences?.overrides ?? []
        }),
        writable: canEdit,
        providerKind: "icloud"
      };
    })()
    : null;
  const editorDestinations = mutationSheet === "edit"
    ? [selectedIsLocal ? localDestination : selectedProviderDestination].filter(Boolean) as CalendarEditorDestination[]
    : [...providerEditorDestinations, localDestination];
  const createAction = canCreate ? <button type="button" className="planning-primary-button planning-calendar-create" onClick={() => { setMutationConflict(false); setMutationSheet("create"); }}>Создать событие</button> : undefined;

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

  async function refreshCalendarData(): Promise<void> {
    if (calendarRefreshLockRef.current || routeRead.refreshing) return;
    calendarRefreshLockRef.current = true;
    setCalendarRefreshPending(true);
    const controller = new AbortController();
    calendarRefreshControllerRef.current = controller;
    let timeout: number | null = null;
    try {
      if (!(await ensureCapability("planning.calendar_sources.refresh", "Обновить источники календаря"))) {
        showNotice({
          id: "planning.calendar.refresh.result",
          severity: "warning",
          title: "Обновление источников не разрешено",
          detail: "Проверка доступа не разрешила запрос. Синхронизация не запускалась.",
          timeoutMs: 10_000,
          testId: "planning-calendar-refresh-result"
        });
        return;
      }
      if (controller.signal.aborted || !calendarRouteMountedRef.current) return;
      calendarRefreshInFlightRef.current = true;
      showNotice({
        id: "planning.calendar.refresh.result",
        severity: "progress",
        title: "Обновляются источники календаря",
        detail: "Запрашиваем синхронизацию, затем проверим полученные данные и статусы источников.",
        testId: "planning-calendar-refresh-result"
      });
      // PIN/elevation time is not provider-sync time; start the bounded request
      // deadline only after the access capability has been confirmed.
      timeout = window.setTimeout(() => controller.abort(), 20_000);
      const result = await refreshPlanningCalendarSources(controller.signal, 15_000);
      let refreshedEvents;
      try {
        refreshedEvents = await readPlanningEventsForRange(
          monthGrid.range.fromUtc,
          monthGrid.range.toUtc,
          controller.signal
        );
      } catch {
        if (controller.signal.aborted || !calendarRouteMountedRef.current) return;
        const fallbackPresentation = calendarSourceRefreshPresentation(result, null, planningSourcesRef.current);
        showNotice({
          id: "planning.calendar.refresh.result",
          severity: fallbackPresentation.severity,
          title: "Источники обновлены, но календарь не удалось перечитать",
          detail: `${fallbackPresentation.detail} События месяца оставлены без изменений.`,
          timeoutMs: 12_000,
          testId: "planning-calendar-refresh-result"
        });
        return;
      }
      if (controller.signal.aborted || !calendarRouteMountedRef.current) return;
      const presentation = calendarSourceRefreshPresentation(
        result,
        refreshedEvents.sources ?? null,
        planningSourcesRef.current
      );
      showNotice({
        id: "planning.calendar.refresh.result",
        severity: presentation.severity,
        title: presentation.title,
        detail: presentation.detail,
        timeoutMs: presentation.severity === "error" ? 12_000 : 10_000,
        testId: "planning-calendar-refresh-result"
      });
      if (calendarRouteMountedRef.current) setRetry((value) => value + 1);
    } catch {
      if (!calendarRouteMountedRef.current) return;
      const timedOut = controller.signal.aborted;
      const fallbackPresentation = calendarSourceRefreshPresentation(null, null, planningSourcesRef.current);
      showNotice({
        id: "planning.calendar.refresh.result",
        severity: fallbackPresentation.severity,
        title: timedOut ? "Не удалось подтвердить обновление календаря вовремя" : fallbackPresentation.title,
        detail: `${fallbackPresentation.detail}${timedOut ? " Запрос завершился по тайм-ауту." : ""}`,
        timeoutMs: 12_000,
        testId: "planning-calendar-refresh-result"
      });
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
      if (calendarRefreshControllerRef.current === controller) calendarRefreshControllerRef.current = null;
      calendarRefreshLockRef.current = false;
      calendarRefreshInFlightRef.current = false;
      if (calendarRouteMountedRef.current) setCalendarRefreshPending(false);
    }
  }

  async function ensureCalendarCapability(action: "create" | "edit" | "delete", title: string, provider = false): Promise<boolean> {
    if (calendarFrontendWriterDisabled) {
      showNotice({
        id: `planning.calendar.frontend-gate.${action}`,
        severity: "warning",
        title: "Изменения календаря отключены в этой сборке",
        detail: "Запись календаря отключена в этой сборке. Запрос не отправлен."
      });
      return false;
    }
    if (calendarServerWriterDisabled) {
      showNotice({
        id: `planning.calendar.server-gate.${action}`,
        severity: "warning",
        title: "Изменения календаря отключены сервером",
        detail: "Запись локального календаря отключена серверным gate. Запрос не отправлен."
      });
      return false;
    }
    if (calendarWriterGateMetadataUnavailable) {
      showNotice({
        id: `planning.calendar.gate-unavailable.${action}`,
        severity: "warning",
        title: "Серверный gate записи календаря не подтверждён",
        detail: "Серверный gate записи календаря не подтверждён. Запрос не отправлен."
      });
      return false;
    }
    if (provider && providerServerWriterDisabled) {
      showNotice({
        id: `planning.calendar.provider-server-gate.${action}`,
        severity: "warning",
        title: "Запись провайдера отключена сервером",
        detail: "Запись событий iCloud отключена отдельным серверным gate. Запрос не отправлен."
      });
      return false;
    }
    if (provider && providerWriterGateMetadataUnavailable) {
      showNotice({
        id: `planning.calendar.provider-gate-unavailable.${action}`,
        severity: "warning",
        title: "Серверный gate провайдера не подтверждён",
        detail: "Серверный gate записи iCloud не подтверждён. Запрос не отправлен."
      });
      return false;
    }
    if (!accessAvailable || !accessStatus) {
      showNotice({
        id: `planning.calendar.access.unavailable.${action}`,
        severity: "warning",
        title: "Проверка доступа недоступна",
        detail: "Проверка профиля доступа недоступна. Запрос не отправлен."
      });
      return false;
    }
    const capability = planningCalendarAccessCapabilities[action];
    if (!accessStatus.capabilities[capability]) {
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

  async function submitEventMutation(body: EventMutationBody, destination: CalendarEditorDestination): Promise<void> {
    if (!guardMutation()) return;
    if (!destination.writable) return;
    const provider = destination.providerKind === "icloud";
    if (!provider && destination.id !== localDestination.id) return;
    const action = mutationSheet === "create" ? "create" : "edit";
    const target = action === "edit" ? selectedEvent : null;
    if (!await ensureCalendarCapability(action, action === "create" ? "Создать событие" : "Изменить событие", provider)) return;
    if (!guardMutation()) return;
    setMutationPending(true);
    try {
      const result = provider
        ? await mutatePlanningProviderEvent({
          action,
          idempotencyKey: newPlanningIdempotencyKey("panel-calendar-provider"),
          destinationId: action === "create" ? destination.id : undefined,
          eventId: target?.id,
          expectedVersion: target?.version,
          body
        })
        : await mutatePlanningEvent({
          action,
          idempotencyKey: newPlanningIdempotencyKey("panel-calendar"),
          eventId: target?.id,
          expectedVersion: target?.version,
          body
        });
      setSelectedEvent(result.object);
      setMutationSheet(null);
      setMutationConflict(false);
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
        setMutationConflict(false);
        showNotice({
          id: `planning.calendar.reconciled.${target?.id ?? "create"}`,
          severity: "warning",
          title: "Результат подтверждён чтением",
          detail: "Результат сохранения проверен."
        });
      } else {
        const mutationError = error instanceof PlanningMutationError ? error : null;
        const conflict = mutationError?.mutationCode === "conflict";
        if (conflict) setMutationConflict(true);
        const disabled = mutationError?.mutationCode === "disabled";
        const notFound = mutationError?.mutationCode === "not_found";
        if (provider && mutationError?.mutationCode === "uncertain") {
          // Re-read authoritative Calendar state once; never replay the provider write.
          setRetry((value) => value + 1);
        }
        if (notFound) {
          setSelectedEvent(null);
          setMutationSheet(null);
          setRetry((value) => value + 1);
        }
        showNotice({
          id: `planning.calendar.uncertain.${target?.id ?? "create"}`,
          severity: conflict || disabled || notFound ? "warning" : "error",
          title: conflict
            ? "Событие изменилось"
            : disabled
              ? "Изменения календаря отключены"
              : notFound
                ? "Событие больше не найдено"
                : "Результат не подтверждён",
          detail: conflict
            ? "Запись уже изменилась. Сначала перечитайте её."
            : disabled
              ? "Серверный gate записи календаря отключён. Запрос не отправлен повторно."
              : notFound
                ? "Актуальная запись не найдена. Календарь обновлён."
                : "Результат не подтверждён. Перечитайте событие перед новой попыткой."
        });
      }
    } finally {
      setMutationPending(false);
    }
  }

  async function reloadConflictedEvent(): Promise<void> {
    if (!selectedEvent || mutationSheet !== "edit") return;
    try {
      const current = await readPlanningEventById(selectedEvent.id);
      setSelectedEvent(current);
      setMutationConflict(false);
      setEditorReloadRevision((value) => value + 1);
      setRetry((value) => value + 1);
    } catch {
      showNotice({ id: "planning.calendar.reload-failed", severity: "error", title: "Не удалось перечитать событие", detail: "Повторите попытку после восстановления связи." });
    }
  }

  async function deleteEvent(): Promise<void> {
    if (!guardMutation() || !selectedEvent || deletePendingRef.current || !canDelete) return;
    const target = selectedEvent;
    deletePendingRef.current = true;
    setMutationPending(true);
    try {
      const provider = !(target.localOnlyMutable && target.syncState === "local_only");
      if (!await ensureCalendarCapability("delete", "Удалить событие", provider)) return;
      const confirmation = await confirmAction("planning.calendar.delete", {
        target: target.title,
        revision: String(target.version)
      });
      if (!confirmation.confirmed) return;
      if (!guardMutation()) return;
      const result = provider
        ? await mutatePlanningProviderEvent({
          action: "delete",
          idempotencyKey: newPlanningIdempotencyKey("panel-calendar-provider"),
          eventId: target.id,
          expectedVersion: target.version,
          body: {}
        })
        : await mutatePlanningEvent({
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
        const mutationError = error instanceof PlanningMutationError ? error : null;
        const conflict = mutationError?.mutationCode === "conflict";
        const disabled = mutationError?.mutationCode === "disabled";
        const notFound = mutationError?.mutationCode === "not_found";
        if (notFound) {
          setSelectedEvent(null);
          setMutationSheet(null);
          setRetry((value) => value + 1);
        }
        showNotice({
          id: `planning.calendar.delete.uncertain.${target.id}`,
          severity: conflict || disabled || notFound ? "warning" : "error",
          title: conflict
            ? "Событие изменилось"
            : disabled
              ? "Изменения календаря отключены"
              : notFound
                ? "Событие больше не найдено"
                : "Результат не подтверждён",
          detail: conflict
            ? "Запись уже изменилась. Сначала перечитайте её."
            : disabled
              ? "Серверный gate записи календаря отключён. Запрос не отправлен повторно."
              : notFound
                ? "Актуальная запись не найдена. Календарь обновлён."
                : "Результат не подтверждён. Перечитайте событие перед новой попыткой."
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
  return (
    <PlanningRouteFrame
      module={calendarModule}
      eyebrow="Расписание"
      sourceStatus={envelope?.sourceStatus ?? planning?.sourceStatus ?? "unavailable"}
      lastSyncedAt={envelope?.lastSyncedAt ?? null}
      sources={sources.some((source) => source.status !== "current") ? sources : []}
      error={routeRead.error}
      loading={routeRead.loading}
      hasConfirmedContent={Boolean(routeRead.data)}
      refreshing={routeRead.refreshing}
      suppressRefreshWithConfirmedContent
      preview={preview}
      onRetry={() => setRetry((value) => value + 1)}
      controls={(
        <>
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
          {calendarFrontendWriterDisabled && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-calendar-mutation-frontend-gate">
              Запись календаря отключена в этой сборке.
            </span>
          )}
          {calendarServerWriterDisabled && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-calendar-mutation-gate">
              Запись локального календаря отключена серверным gate.
            </span>
          )}
          {calendarWriterGateMetadataUnavailable && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-calendar-mutation-gate-unavailable">
              Серверный gate записи календаря не подтверждён.
            </span>
          )}
          {calendarAccessBlocked && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-calendar-access-blocked">
              Текущий профиль не разрешает изменять календарь.
            </span>
          )}
          {calendarAccessUnavailable && (
            <span className="planning-route-note planning-route-note--warning" data-testid="planning-calendar-access-unavailable">
              Проверка профиля доступа недоступна.
            </span>
          )}
        </>
      )}
      testId="route-calendar"
    >
      <PlanningRouteState loading={routeRead.loading} empty={false} error={routeError} preview={preview} onRetry={() => setRetry((value) => value + 1)}>
        {envelope && (
          <div className={`calendar-month-layout${expandedDay ? " calendar-month-layout--expanded" : ""}`} data-testid="planning-calendar-month" data-expanded-day={expandedDay ? "true" : "false"} data-rows={monthGrid.rows}>
            <section className="calendar-month" aria-label={`Календарь ${visibleMonthKey}`} aria-hidden={expandedDay}>
              <div className="calendar-month__weekdays" aria-hidden="true">
                {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((weekday) => <span key={weekday}>{weekday}</span>)}
              </div>
              <div className="calendar-month__grid">
                {monthDates.map((localDate) => {
                  const dayEvents = calendarEventsForLocalDay(events, localDate, DEFAULT_PLANNING_TIME_ZONE);
                  const colors = [...new Set(dayEvents.map((event) => calendarEventColor(event, sources, calendarDisplayPreferences?.overrides ?? [])))];
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
                        return <CalendarEventRow key={event.id} event={event} overlap={false} now={referenceTime} accentColor={calendarEventColor(event, sources, calendarDisplayPreferences?.overrides ?? [])} markerStyle={calendarEventMarkerStyle} sourceStale={providerSourceNeedsStaleCue(source)} onOpen={() => setSelectedEvent(event)} />;
                      })}
                    </div>
                  )}
                  <div className="calendar-timed-list">
                    {selectedDayEvents.filter((event) => !event.allDay).map((event) => {
                      const source = providerSourceForEvent(event, sources);
                      return <CalendarEventRow key={event.id} event={event} overlap={overlapIds.has(event.id)} now={referenceTime} accentColor={calendarEventColor(event, sources, calendarDisplayPreferences?.overrides ?? [])} markerStyle={calendarEventMarkerStyle} sourceStale={providerSourceNeedsStaleCue(source)} onOpen={() => setSelectedEvent(event)} />;
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
          onEdit={() => { setMutationConflict(false); setMutationSheet("edit"); }}
          onDelete={() => void deleteEvent()}
        />
      )}
      {mutationSheet && (
        <CalendarMutationSheet
          key={`${mutationSheet}:${selectedEvent?.id ?? selectedDate}:${selectedEvent?.version ?? 0}:${editorReloadRevision}`}
          mode={mutationSheet}
          event={selectedEvent}
          selectedDate={selectedDate}
          destinations={editorDestinations}
          onClose={() => { setMutationConflict(false); setMutationSheet(null); }}
          onSubmit={submitEventMutation}
          conflict={mutationConflict}
          onReload={reloadConflictedEvent}
        />
      )}
    </PlanningRouteFrame>
  );
}
