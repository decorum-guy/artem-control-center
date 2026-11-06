export type TodoistView = "today" | "overdue" | "upcoming" | "undated" | "all";
export type TodoistPriority = "p1" | "p2" | "p3" | "p4";
export interface TodoistDue { date: string; datetime?: string | null; timezone: string | null; is_recurring: boolean; string: string }
export interface TodoistTask { id: string; project_id: string; content: string; description: string; priority: number; due: TodoistDue | null }
export interface TodoistProject { id: string; name: string }
export interface TodoistPage<T> { provider: "todoist"; activeSource: "todoist"; generatedAt: string; lastSyncedAt: string; results: T[]; nextCursor: string | null }
export interface TodoistStatus { provider: "todoist"; enabled: boolean; writesEnabled: boolean; configured: boolean; activeSource: "todoist" | "planning" }
export interface TodoistFields { content?: string; description?: string; priority?: TodoistPriority; due?: string | null; project_id?: string }

export class TodoistClientError extends Error {
  constructor(public code: string, public retryAfter: string | null = null) { super(code); }
}

async function request<T>(path: string, body?: TodoistFields, mutation = false): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/todoist/${path}`, {
      method: mutation ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000)
    });
  } catch { throw new TodoistClientError(mutation ? "outcome_uncertain" : "offline"); }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string };
    throw new TodoistClientError(payload.detail ?? "unavailable", response.headers.get("Retry-After"));
  }
  try { return await response.json() as T; }
  catch { throw new TodoistClientError(mutation ? "outcome_uncertain" : "malformed_response"); }
}

export const todoistStatus = () => request<TodoistStatus>("status");
export function todoistTasks(view: TodoistView, project: string, cursor?: string) {
  const query = new URLSearchParams({ view, limit: "50" });
  if (project) query.set("projectId", project);
  if (cursor) query.set("cursor", cursor);
  return request<TodoistPage<TodoistTask>>(`tasks?${query}`);
}
export async function todoistProjects(): Promise<TodoistProject[]> {
  const seen = new Set<string>();
  const projects = new Map<string, TodoistProject>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const result = await request<TodoistPage<TodoistProject>>(`projects?${query}`);
    result.results.forEach((project) => projects.set(project.id, project));
    if (!result.nextCursor) return [...projects.values()];
    if (seen.has(result.nextCursor)) throw new TodoistClientError("malformed_response");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new TodoistClientError("pagination_limit");
}
export const createTodoistTask = (fields: TodoistFields) => request("tasks", fields, true);
export const updateTodoistTask = (id: string, fields: TodoistFields) => request(`tasks/${encodeURIComponent(id)}`, fields, true);
export const moveTodoistTask = (id: string, project_id: string) => request(`tasks/${encodeURIComponent(id)}/move`, { project_id }, true);
export const closeTodoistTask = (id: string) => request(`tasks/${encodeURIComponent(id)}/close`, undefined, true);
export function todoistPriority(value: number): TodoistPriority { return `p${5 - value}` as TodoistPriority; }
export function todoistErrorCopy(error: unknown): string {
  const code = error instanceof TodoistClientError ? error.code : "unavailable";
  return ({ invalid_token: "Токен Todoist недействителен. Проверьте настройки Panel Agent.",
    forbidden: "Todoist запретил доступ к этим данным.", rate_limited: "Лимит Todoist. Подождите перед обновлением.",
    offline: "Нет связи с Todoist. Проверьте интернет.", outcome_uncertain: "Исход команды неизвестен. Проверьте состояние в Todoist перед повтором.",
    gate_disabled: "Изменения Todoist отключены.", profile_blocked: "Профиль разрешает только чтение.",
    malformed_response: "Todoist вернул некорректный ответ.", pagination_limit: "Слишком много страниц проектов. Список не загружен полностью." } as Record<string, string>)[code] ?? "Todoist недоступен. Попробуйте обновить список позже.";
}
