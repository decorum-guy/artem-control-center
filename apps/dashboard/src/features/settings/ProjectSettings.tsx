import { useRef, useState, type FormEvent } from "react";
import type { ProjectRegistryProject } from "@artem/contracts";
import { useActionConfirmation } from "../../ActionConfirmations";
import { useAccess } from "../../AccessControls";
import { useInteractionLock } from "../../InteractionLock";
import { Sheet } from "../../Sheet";
import {
  PROJECT_REGISTRY_CAPABILITY,
  ProjectRegistryApiError
} from "../../projectRegistryApi";
import type { ProjectRegistryController } from "../../ProjectRegistry";
import {
  DEFAULT_PROJECT_DRAFT,
  normalizeProjectDraft,
  projectDraftFromRegistry,
  projectInputFromDraft,
  projectInputFromRegistry,
  type ProjectDraft,
  type ProjectDraftErrors,
  validateProjectDraft
} from "../../projectRegistryForm";

interface ProjectEditorState {
  projectId: string | null;
  draft: ProjectDraft;
}

function lockNotice(): string {
  return "Панель заблокирована. Удерживайте замок для разблокировки.";
}

function mutationUnavailableNotice(): string {
  return "Изменения проектов сейчас недоступны.";
}

function editableProject(project: ProjectRegistryProject): ProjectDraft | null {
  return projectDraftFromRegistry(project);
}

function projectEntries(project: ProjectRegistryProject): Array<{ environmentId: string; serviceId: string; urlEnv: string }> {
  return project.environments.flatMap((environment) => environment.services.map((service) => ({
    environmentId: environment.id,
    serviceId: service.id,
    urlEnv: service.monitor.urlEnv
  })));
}

export function ProjectSettingsSheet({
  onClose,
  controller
}: {
  onClose: () => void;
  controller: ProjectRegistryController;
}) {
  const { registry, loading, error, mutationPending, refresh } = controller;
  const { guardMutation } = useInteractionLock();
  const { ensureCapability } = useAccess();
  const { confirmAction } = useActionConfirmation();
  const [editor, setEditor] = useState<ProjectEditorState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProjectDraftErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [accessPending, setAccessPending] = useState(false);
  const accessPendingRef = useRef(false);

  const canWrite = registry?.available === true && registry.writesEnabled && !error;

  function openEditor(project?: ProjectRegistryProject) {
    if (!registry?.available || error) {
      setNotice(mutationUnavailableNotice());
      return;
    }
    const draft = project ? editableProject(project) : { ...DEFAULT_PROJECT_DRAFT };
    if (!draft) {
      setNotice("Этот проект нельзя безопасно редактировать в текущем режиме.");
      return;
    }
    setEditor({ projectId: project?.id ?? null, draft });
    setFieldErrors({});
    setNotice(null);
  }

  function closeEditor() {
    if (mutationPending) return;
    setEditor(null);
    setFieldErrors({});
    setNotice(null);
  }

  function updateDraft<K extends keyof ProjectDraft>(field: K, value: ProjectDraft[K]) {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, [field]: value } } : current);
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function prepareMutation(kind: "create" | "replace" | "delete", title: string): Promise<boolean> {
    if (!guardMutation()) {
      setNotice(lockNotice());
      return false;
    }
    if (!registry?.available || !registry.writesEnabled || error) {
      setNotice(mutationUnavailableNotice());
      return false;
    }
    if (!controller.beginMutation(kind)) return false;
    setNotice(null);
    try {
      if (!(await ensureCapability(PROJECT_REGISTRY_CAPABILITY, title))) {
        setNotice("Изменение проектов доступно владельцу панели.");
        controller.endMutation();
        return false;
      }
    } catch {
      setNotice("Не удалось проверить доступ к изменению проектов.");
      controller.endMutation();
      return false;
    }
    if (!guardMutation()) {
      setNotice(lockNotice());
      controller.endMutation();
      return false;
    }
    return true;
  }

  async function reconcileMutationFailure(value: unknown) {
    const failure = value instanceof ProjectRegistryApiError
      ? value
      : new ProjectRegistryApiError("project_registry_unavailable", 503);

    if (failure.status === 422 || failure.code === "invalid_project_payload" || failure.code === "project_id_mismatch") {
      setNotice("Проверьте данные проекта. Подтверждённый список проектов не изменён.");
      return;
    }

    // A conflict, 404 or reconciliation failure can mean that the server has
    // already committed a different state. Close any draft before replacing
    // it with the next authoritative GET response.
    setEditor(null);
    setFieldErrors({});
    const refreshed = await refresh();
    if (!refreshed) {
      setNotice("Не удалось подтвердить текущее состояние проектов.");
      return;
    }
    if (failure.status === 409 && failure.code === "revision_conflict") {
      setNotice("Список проектов изменился. Показано последнее подтверждённое состояние.");
      return;
    }
    if (failure.status === 503) {
      setNotice("Не удалось применить изменение к работающей панели. Состояние проектов обновлено.");
      return;
    }
    if (failure.status === 404) {
      setNotice("Проект уже был изменён. Список проектов обновлён.");
      return;
    }
    setNotice("Не удалось сохранить изменение. Показано подтверждённое состояние.");
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const normalized = normalizeProjectDraft(editor.draft);
    const errors = validateProjectDraft(normalized);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setNotice("Проверьте поля проекта.");
      return;
    }

    const projectId = editor.projectId ?? normalized.id;
    const payloadDraft = { ...normalized, id: projectId };
    const kind = editor.projectId ? "replace" : "create";
    if (!(await prepareMutation(kind, editor.projectId ? "Сохранить проект" : "Добавить проект"))) return;
    try {
      const payload = projectInputFromDraft(payloadDraft);
      if (editor.projectId) await controller.replace(projectId, payload);
      else await controller.create(payload);
      setEditor(null);
      setFieldErrors({});
      setNotice(editor.projectId ? "Проект сохранён." : "Проект добавлен.");
    } catch (value) {
      await reconcileMutationFailure(value);
    } finally {
      controller.endMutation();
    }
  }

  async function toggleProject(project: ProjectRegistryProject, enabled: boolean) {
    if (!(await prepareMutation("replace", enabled ? "Включить проект" : "Выключить проект"))) return;
    try {
      await controller.replace(project.id, projectInputFromRegistry({ ...project, enabled }));
      setNotice(enabled ? "Проект включён" : "Проект выключен");
    } catch (value) {
      await reconcileMutationFailure(value);
    } finally {
      controller.endMutation();
    }
  }

  async function deleteProject(project: ProjectRegistryProject) {
    if (!(await prepareMutation("delete", "Удалить проект"))) return;
    try {
      const confirmation = await confirmAction("settings.projects.delete", {
        title: `Удалить проект «${project.name}»?`,
        target: project.name
      });
      if (!confirmation.confirmed) return;
      if (!guardMutation()) {
        setNotice(lockNotice());
        return;
      }
      await controller.remove(project.id);
      setNotice("Проект удалён.");
    } catch (value) {
      await reconcileMutationFailure(value);
    } finally {
      controller.endMutation();
    }
  }

  async function refreshProjects() {
    if (mutationPending || loading) return;
    const next = await refresh();
    if (!next) setNotice("Не удалось подтвердить текущее состояние проектов.");
    else setNotice(null);
  }

  async function requestWriteAccess() {
    if (accessPendingRef.current || mutationPending) return;
    if (!guardMutation()) {
      setNotice(lockNotice());
      return;
    }
    if (!registry?.available || error) {
      setNotice(mutationUnavailableNotice());
      return;
    }
    accessPendingRef.current = true;
    setAccessPending(true);
    setNotice(null);
    try {
      const allowed = await ensureCapability(PROJECT_REGISTRY_CAPABILITY, "Изменить проекты");
      const next = allowed ? await refresh() : null;
      if (next?.writesEnabled) setNotice("Полный доступ включён. Изменения проектов доступны.");
      else if (allowed) setNotice("Панель оставила настройки проектов только для чтения.");
      else setNotice("Для изменения проектов нужен полный доступ.");
    } catch {
      setNotice("Не удалось включить доступ к изменению проектов.");
    } finally {
      accessPendingRef.current = false;
      setAccessPending(false);
    }
  }

  const sheetTitle = editor ? (editor.projectId ? "Изменить проект" : "Добавить проект") : "Проекты";
  const sheetDescription = editor
    ? "Только мониторинг: один HTTP-сервис без действий и учётных данных."
    : "Зарегистрированные проекты только с мониторингом и их настройки проверки.";

  return (
    <Sheet
      testId="settings-projects-sheet"
      className="settings-projects-sheet"
      eyebrow="Настройки"
      title={sheetTitle}
      description={sheetDescription}
      onClose={onClose}
      canClose={() => !mutationPending}
      footer={editor ? (
        <div className="project-settings__footer-actions">
          <button type="button" className="planning-secondary-button" disabled={mutationPending} onClick={closeEditor}>Отмена</button>
          <button type="submit" form="project-editor-form" className="planning-primary-button" disabled={mutationPending} aria-busy={mutationPending}>
            {mutationPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      ) : undefined}
    >
      <div className="settings-v2-sheet-content project-settings" data-testid="project-settings" aria-busy={mutationPending}>
        {loading && !registry && <p className="settings-notice" role="status">Загружаем список проектов…</p>}
        {loading && registry && <p className="settings-notice" role="status">Обновляем подтверждённый список проектов…</p>}
        {error && !registry && <p className="settings-notice" role="status">Не удалось загрузить настройки проектов.</p>}
        {error && registry && <p className="settings-notice" role="status">Не удалось подтвердить текущее состояние проектов.</p>}
        {error && !registry && (
          <button type="button" className="planning-secondary-button project-settings__refresh" disabled={loading} aria-busy={loading} onClick={() => void refreshProjects()}>
            {loading ? "Проверяем…" : "Повторить"}
          </button>
        )}
        {registry && !registry.available && <p className="settings-notice" role="status">Настройки проектов временно недоступны.</p>}

        {!editor && registry?.available && (
          <>
            <div className="project-settings__toolbar">
              <div>
                <p className="section-kicker">Мониторинг</p>
                <h3>Зарегистрированные проекты</h3>
              </div>
              <button
                type="button"
                className="planning-primary-button project-settings__add"
                disabled={!canWrite || mutationPending}
                onClick={() => openEditor()}
              >
                Добавить проект
              </button>
            </div>

            {!canWrite && !error && (
              <div className="project-settings__readonly" role="status">
                <span>Только просмотр: для изменений нужен полный доступ.</span>
                <button type="button" className="planning-secondary-button" disabled={accessPending} aria-busy={accessPending} onClick={() => void requestWriteAccess()}>
                  {accessPending ? "Проверяем доступ…" : "Разрешить изменения"}
                </button>
              </div>
            )}

            {registry.projects.length === 0 && <p className="settings-notice" role="status">Нет добавленных проектов.</p>}
            {registry.projects.length > 0 && (
              <div className="project-settings__list" data-testid="project-list">
                {registry.projects.map((project) => {
                  const draft = editableProject(project);
                  const entries = projectEntries(project);
                  return (
                    <article className="project-settings-card" key={project.id} data-testid={`project-card-${project.id}`}>
                      <div className="project-settings-card__header">
                        <div className="project-settings-card__identity">
                          <h3>{project.name}</h3>
                          <span>ID: <code>{project.id}</code></span>
                          <span className="project-settings-card__badge">Только мониторинг</span>
                        </div>
                        <div className="project-settings-card__enabled">
                          <strong>{project.enabled ? "Включён" : "Выключен"}</strong>
                          <label className="project-settings-card__toggle">
                            <input
                              type="checkbox"
                              checked={project.enabled}
                              disabled={!canWrite || mutationPending}
                              aria-label={`${project.enabled ? "Выключить" : "Включить"} проект «${project.name}»`}
                              onChange={(event) => void toggleProject(project, event.target.checked)}
                            />
                            <span className="project-settings-card__toggle-visual" aria-hidden="true">
                              <span className="project-settings-card__toggle-thumb" />
                              <span>{project.enabled ? "Вкл" : "Выкл"}</span>
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="project-settings-card__details">
                        {entries.length > 0 ? entries.map((entry) => (
                          <div className="project-settings-card__detail" key={`${entry.environmentId}:${entry.serviceId}`}>
                            <strong>{entry.environmentId} · {entry.serviceId}</strong>
                            <span>HTTP · переменная {entry.urlEnv}</span>
                          </div>
                        )) : <span>Окружение и сервис пока не настроены.</span>}
                      </div>

                      <div className="project-settings-card__actions">
                        <button type="button" data-testid={`project-edit-${project.id}`} className="planning-secondary-button" disabled={!canWrite || mutationPending || !draft} onClick={() => openEditor(project)}>Изменить</button>
                        <button type="button" data-testid={`project-delete-${project.id}`} className="project-settings-card__delete" disabled={!canWrite || mutationPending} onClick={() => void deleteProject(project)}>Удалить</button>
                      </div>
                      {!draft && <small className="project-settings-card__note">Редактор доступен для одного окружения и одного HTTP-сервиса.</small>}
                    </article>
                  );
                })}
              </div>
            )}

            <button type="button" className="planning-secondary-button project-settings__refresh" disabled={loading || mutationPending} onClick={() => void refreshProjects()}>
              {loading ? "Обновляем…" : "Обновить список"}
            </button>
          </>
        )}

        {registry && !registry.available && (
          <button type="button" className="planning-secondary-button project-settings__refresh" disabled={loading} onClick={() => void refreshProjects()}>
            {loading ? "Проверяем…" : "Повторить"}
          </button>
        )}

        {editor && (
          <form id="project-editor-form" data-testid="project-editor-form" className="project-editor" onSubmit={(event) => void submitEditor(event)} noValidate>
            <div className="project-editor__intro">
              <button type="button" className="planning-secondary-button project-editor__back" disabled={mutationPending} onClick={closeEditor}>К списку проектов</button>
              <p>Сохраняется только декларативная настройка мониторинга. Сам адрес и любые секреты остаются на компьютере панели.</p>
            </div>

            <label className="project-editor__field">
              <span>Название</span>
              <input name="name" type="text" value={editor.draft.name} maxLength={100} autoComplete="off" placeholder="Мой API" aria-label="Название" aria-invalid={Boolean(fieldErrors.name)} onChange={(event) => updateDraft("name", event.target.value)} />
              {fieldErrors.name && <small role="alert">{fieldErrors.name}</small>}
            </label>

            <label className="project-editor__field">
              <span>ID проекта</span>
              <input name="projectId" type="text" value={editor.draft.id} maxLength={32} autoComplete="off" readOnly={editor.projectId !== null} disabled={editor.projectId !== null} aria-label="ID проекта" aria-invalid={Boolean(fieldErrors.id)} onChange={(event) => updateDraft("id", event.target.value)} />
              <small>Латиница, цифры, - и _. Используется как постоянный идентификатор.</small>
              {fieldErrors.id && <small role="alert">{fieldErrors.id}</small>}
            </label>

            <div className="project-editor__grid">
              <label className="project-editor__field">
                <span>Окружение</span>
                <input name="environmentId" type="text" value={editor.draft.environmentId} maxLength={32} autoComplete="off" aria-label="Окружение" aria-invalid={Boolean(fieldErrors.environmentId)} onChange={(event) => updateDraft("environmentId", event.target.value)} />
                <small>Например, production.</small>
                {fieldErrors.environmentId && <small role="alert">{fieldErrors.environmentId}</small>}
              </label>
              <label className="project-editor__field">
                <span>Сервис</span>
                <input name="serviceId" type="text" value={editor.draft.serviceId} maxLength={32} autoComplete="off" aria-label="Сервис" aria-invalid={Boolean(fieldErrors.serviceId)} onChange={(event) => updateDraft("serviceId", event.target.value)} />
                <small>Например, api.</small>
                {fieldErrors.serviceId && <small role="alert">{fieldErrors.serviceId}</small>}
              </label>
            </div>

            <label className="project-editor__field">
              <span>Переменная с адресом</span>
              <input name="urlEnv" data-testid="project-url-env" type="text" value={editor.draft.urlEnv} maxLength={64} autoComplete="off" spellCheck={false} placeholder="EXTERNAL_API_HEALTH_URL" aria-label="Переменная с адресом" aria-invalid={Boolean(fieldErrors.urlEnv)} onChange={(event) => updateDraft("urlEnv", event.target.value)} />
              <small>Control Center хранит только имя переменной. Сам адрес задаётся на компьютере панели.</small>
              {fieldErrors.urlEnv && <small role="alert">{fieldErrors.urlEnv}</small>}
            </label>

            <fieldset className="project-editor__advanced">
              <legend>Дополнительно</legend>
              <div className="project-editor__grid">
                <label className="project-editor__field">
                  <span>Интервал проверки, секунд</span>
                  <input name="intervalSeconds" type="number" inputMode="numeric" min={5} max={3600} step={1} value={Number.isFinite(editor.draft.intervalSeconds) ? editor.draft.intervalSeconds : ""} aria-label="Интервал проверки, секунд" aria-invalid={Boolean(fieldErrors.intervalSeconds)} onChange={(event) => updateDraft("intervalSeconds", event.target.value === "" ? Number.NaN : Number(event.target.value))} />
                  {fieldErrors.intervalSeconds && <small role="alert">{fieldErrors.intervalSeconds}</small>}
                </label>
                <label className="project-editor__field">
                  <span>Когда считать данные устаревшими, секунд</span>
                  <input name="staleAfterSeconds" type="number" inputMode="numeric" min={15} max={86400} step={1} value={Number.isFinite(editor.draft.staleAfterSeconds) ? editor.draft.staleAfterSeconds : ""} aria-label="Когда считать данные устаревшими, секунд" aria-invalid={Boolean(fieldErrors.staleAfterSeconds)} onChange={(event) => updateDraft("staleAfterSeconds", event.target.value === "" ? Number.NaN : Number(event.target.value))} />
                  {fieldErrors.staleAfterSeconds && <small role="alert">{fieldErrors.staleAfterSeconds}</small>}
                </label>
              </div>
            </fieldset>
          </form>
        )}

        {notice && <p className="settings-notice" role="status" aria-live="polite">{notice}</p>}
      </div>
    </Sheet>
  );
}
