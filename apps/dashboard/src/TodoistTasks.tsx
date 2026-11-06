import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { Sheet } from "./Sheet";
import { RouteHeader } from "./ShellPrimitives";
import { closeTodoistTask, createTodoistTask, moveTodoistTask, TodoistClientError, todoistErrorCopy, todoistPriority, todoistProjects, todoistStatus, todoistTasks, updateTodoistTask, type TodoistFields, type TodoistPage, type TodoistPriority, type TodoistProject, type TodoistStatus, type TodoistTask, type TodoistView } from "./todoistClient";
import "./planningRoutes.css";
import "./todoistTasks.css";

export function TasksProviderBoundary({ fallback }: { fallback: ReactNode }) {
  const [status, setStatus] = useState<TodoistStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    void todoistStatus().then(setStatus).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  if (status?.enabled === false) return fallback;
  if (status?.enabled) return <TodoistTasksPage status={status} />;
  return <section aria-label="Задачи"><RouteHeader title="Задачи" /><p role="status">{failed ? "Не удалось определить источник задач." : "Подключаем задачи…"}</p>{failed && <button className="planning-secondary-button" onClick={load}>Повторить</button>}</section>;
}

const views: [TodoistView, string][] = [["today", "Сегодня"], ["overdue", "Просрочено"], ["upcoming", "Предстоящие"], ["undated", "Без даты"], ["all", "Все"]];
function dueLabel(task: TodoistTask): string {
  if (!task.due) return "Без даты";
  const due = task.due.datetime ?? task.due.date;
  return `${due.replace("T", " ")}${task.due.timezone ? ` · ${task.due.timezone}` : ""}${task.due.is_recurring ? " · Повторяется" : ""}`;
}

export function TodoistTasksPage({ status }: { status: TodoistStatus }) {
  const access = useAccess();
  const { locked, guardMutation } = useInteractionLock();
  const [view, setView] = useState<TodoistView>("today");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<TodoistProject[]>([]);
  const [projectError, setProjectError] = useState("");
  const [page, setPage] = useState<TodoistPage<TodoistTask> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [editor, setEditor] = useState<TodoistTask | "create" | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const seenCursors = useRef(new Set<string>());
  const [runtimeWrites, setRuntimeWrites] = useState(status.writesEnabled);
  const stale = !!page && clock - Date.parse(page.lastSyncedAt) > 90_000;
  const canWrite = runtimeWrites && access.status?.capabilities["todoist.tasks.write"]?.allowed === true && !locked && !stale;
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { void todoistStatus().then((next) => setRuntimeWrites(next.writesEnabled)).catch(() => undefined); }, [access.status?.effectiveProfile]);

  const load = useCallback(async (cursor?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await todoistTasks(view, project, cursor);
      if (current !== generation.current) return false;
      if (cursor && result.nextCursor && seenCursors.current.has(result.nextCursor)) throw new Error("cursor loop");
      if (!cursor) seenCursors.current.clear();
      if (cursor) seenCursors.current.add(cursor);
      setPage((previous) => ({ ...result, results: cursor ? [...new Map([...(previous?.results ?? []), ...result.results].map((task) => [task.id, task])).values()] : result.results }));
      return true;
    } catch (failure) {
      if (current === generation.current) setError(todoistErrorCopy(failure));
      return false;
    } finally { if (current === generation.current) setLoading(false); }
  }, [view, project]);
  const loadProjects = useCallback(() => {
    setProjectError("");
    void todoistProjects().then(setProjects).catch((failure) => setProjectError(todoistErrorCopy(failure)));
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { setPage(null); setMessage(""); void load(); return () => { generation.current++; }; }, [load]);

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (pending.current || !canWrite || !guardMutation()) return false;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (!await access.ensureCapability("todoist.tasks.write", "Изменить задачу Todoist")) return false;
      try { await action(); }
      catch (failure) {
        if (failure instanceof TodoistClientError && failure.code === "outcome_uncertain") { await load(); setEditor(null); }
        setMessage(todoistErrorCopy(failure));
        return false;
      }
      const refreshed = await load();
      setMessage(refreshed ? "Команда принята Todoist. Список обновлён." : "Команда принята Todoist, но перечитать список не удалось. Проверьте состояние перед повтором.");
      setEditor(null);
      return refreshed;
    } finally { pending.current = false; setBusy(false); }
  }

  return <section className="planning-route-page todoist-tasks" data-testid="todoist-tasks">
    <RouteHeader title="Задачи" eyebrow="Todoist" variant="compact" actions={<button className="planning-primary-button" disabled={!canWrite || busy || loading || !!error} onClick={() => { setMessage(""); setEditor("create"); }}>Новая задача</button>} />
    <div className="todoist-controls">
      <div className="planning-segmented" aria-label="Период задач">{views.map(([key, label]) => <button key={key} aria-pressed={view === key} disabled={busy} onClick={() => setView(key)}>{label}</button>)}</div>
      <select aria-label="Проект" value={project} disabled={busy} onChange={(event) => setProject(event.target.value)}><option value="">Все проекты</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button className="planning-secondary-button" disabled={loading || busy} onClick={() => { void load(); loadProjects(); }}>Обновить</button>
    </div>
    <p className="todoist-freshness" role="status">Todoist · {loading ? "Обновляем…" : error ? page ? "Сохранённые данные · Нет связи" : "Недоступен" : stale ? "Данные устарели · Обновите список" : "Подключён"}{page && ` · Обновлено ${new Date(page.lastSyncedAt).toLocaleTimeString("ru-RU")}`}{!canWrite && " · Только чтение"}</p>
    {error && <p role="alert">{error}</p>}
    {projectError && <p role="alert">Проекты: {projectError}</p>}
    {message && <p role="status">{message}</p>}
    {!loading && !error && page?.results.length === 0 && <p>{page.nextCursor ? "В этой части списка нет задач выбранного проекта. Загрузите следующую страницу." : "Активных задач в этом разделе нет."}</p>}
    <ul className="todoist-list">{page?.results.map((task) => <li key={task.id}>
      <button className="todoist-complete" aria-label={`Завершить: ${task.content}`} disabled={!canWrite || busy || loading || !!error} onClick={() => void mutate(() => closeTodoistTask(task.id))}>✓</button>
      <button className="todoist-row" disabled={busy} onClick={() => setEditor(task)}><strong>{task.content}</strong><span>{todoistPriority(task.priority).toUpperCase()} · {projects.find((item) => item.id === task.project_id)?.name ?? "Проект недоступен"} · {dueLabel(task)}</span></button>
    </li>)}</ul>
    {page?.nextCursor && <button className="planning-secondary-button" disabled={loading || busy} onClick={() => void load(page.nextCursor!)}>Загрузить ещё</button>}
    {editor && <TodoistEditor task={editor} projects={projects} error={message} disabled={!canWrite || busy || !!error} pending={busy} onClose={() => { if (!busy) setEditor(null); }} onSave={(fields) => mutate(() => editor === "create" ? createTodoistTask(fields) : updateTodoistTask(editor.id, fields))} onMove={(id) => editor !== "create" && void mutate(() => moveTodoistTask(editor.id, id))} />}
  </section>;
}

function TodoistEditor({ task, projects, error, disabled, pending, onClose, onSave, onMove }: { task: TodoistTask | "create"; projects: TodoistProject[]; error: string; disabled: boolean; pending: boolean; onClose: () => void; onSave: (fields: TodoistFields) => Promise<boolean>; onMove: (id: string) => void }) {
  const original = task === "create" ? null : task;
  const [content, setContent] = useState(original?.content ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [priority, setPriority] = useState<TodoistPriority>(todoistPriority(original?.priority ?? 1));
  const [project, setProject] = useState(original?.project_id ?? "");
  const [due, setDue] = useState(original?.due?.datetime ?? original?.due?.date ?? "");
  const [dueChanged, setDueChanged] = useState(false);
  const [timed, setTimed] = useState(due.includes("T"));
  const [time, setTime] = useState(due.slice(11, 16) || "12:00");
  const [offset, setOffset] = useState(due.endsWith("Z") ? "+00:00" : due.match(/[+-]\d{2}:\d{2}$/)?.[0] ?? "+03:00");
  const [validation, setValidation] = useState("");
  const unsaved = !!original && (content !== original.content || description !== original.description || priority !== todoistPriority(original.priority) || dueChanged);
  function changeDate(day: string, withTime = timed, at = time, zone = offset) {
    setDue(day ? withTime ? `${day}T${at}:00${zone}` : day : "");
    setDueChanged(true);
  }
  function save() {
    if (!content.trim()) { setValidation("Введите название задачи."); return; }
    if (dueChanged && due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(due))) {
      setValidation("Дата: ГГГГ-ММ-ДД. Время: ГГГГ-ММ-ДДTЧЧ:ММ:СС+03:00."); return;
    }
    const fields: TodoistFields = {};
    if (!original || content !== original.content) fields.content = content;
    if (!original || description !== original.description) fields.description = description;
    if (!original || priority !== todoistPriority(original.priority)) fields.priority = priority;
    if (dueChanged) fields.due = due || null;
    if (!original && project) fields.project_id = project;
    if (!Object.keys(fields).length) { onClose(); return; }
    void onSave(fields);
  }
  return <Sheet title={original ? "Задача Todoist" : "Новая задача"} onClose={onClose} canClose={() => !pending} className="todoist-editor" footer={<button className="planning-primary-button" disabled={disabled} onClick={save}>{pending ? "Отправляем…" : "Сохранить"}</button>}>
    <div className="todoist-form">
      {error && <p role="alert">{error}</p>}
      <label>Название<input value={content} maxLength={500} disabled={disabled} onChange={(event) => setContent(event.target.value)} /></label>
      <label>Описание<textarea aria-label="Описание" value={description} maxLength={4000} disabled={disabled} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Приоритет<select aria-label="Приоритет" value={priority} disabled={disabled} onChange={(event) => setPriority(event.target.value as TodoistPriority)}>{["p1", "p2", "p3", "p4"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Дата<input type="date" value={due.slice(0, 10)} disabled={disabled} onChange={(event) => changeDate(event.target.value)} /></label>
      <button className="planning-secondary-button" aria-pressed={timed} disabled={disabled} onClick={() => { setTimed(!timed); changeDate(due.slice(0, 10), !timed); }}>{timed ? "С временем" : "Без времени"}</button>
      {timed && <div className="todoist-date-time"><label>Время<input type="time" value={time} disabled={disabled} onChange={(event) => { setTime(event.target.value); changeDate(due.slice(0, 10), true, event.target.value); }} /></label><label>Часовой пояс<select aria-label="Часовой пояс" value={offset} disabled={disabled} onChange={(event) => { setOffset(event.target.value); changeDate(due.slice(0, 10), true, time, event.target.value); }}>{[...new Set([offset, ...Array.from({ length: 27 }, (_, index) => `${index < 12 ? "-" : "+"}${String(Math.abs(index - 12)).padStart(2, "0")}:00`)])].sort().map((zone) => <option key={zone} value={zone}>UTC{zone}{zone === "+03:00" ? " · Москва" : ""}</option>)}</select></label></div>}
      <button className="planning-secondary-button" disabled={disabled || !due} onClick={() => changeDate("")}>Убрать дату</button>
      <p>Неизменённая дата сохраняет повторение и часовой пояс Todoist.</p>
      {original?.due?.is_recurring && <p>Повторяется: {original.due.string}. Изменение даты заменит расписание.</p>}
      <label>Проект задачи<select aria-label="Проект задачи" value={project} disabled={disabled} onChange={(event) => setProject(event.target.value)}>{!original && <option value="">Входящие</option>}{original && !projects.some((item) => item.id === original.project_id) && <option value={original.project_id}>Текущий проект</option>}{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {original && <><p>Перенос — отдельное действие. Сохраните остальные изменения перед переносом.</p><button className="planning-secondary-button" disabled={disabled || unsaved || project === original.project_id} onClick={() => onMove(project)}>Перенести в проект</button></>}
      {validation && <p role="alert">{validation}</p>}
    </div>
  </Sheet>;
}
