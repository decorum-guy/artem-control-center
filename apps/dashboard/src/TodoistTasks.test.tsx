// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TasksProviderBoundary, TodoistTasksPage } from "./TodoistTasks";
import * as client from "./todoistClient";

vi.mock("./AccessControls", () => ({ useAccess: () => ({ status: { capabilities: { "todoist.tasks.write": { allowed: true } } }, ensureCapability: async () => true }) }));
vi.mock("./InteractionLock", () => ({ useInteractionLock: () => ({ locked: false, guardMutation: () => true }) }));
vi.mock("./Sheet", () => ({ Sheet: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => <div role="dialog">{children}{footer}</div> }));
vi.mock("./todoistClient", async (original) => ({ ...await original<typeof client>(), todoistTasks: vi.fn(), todoistStatus: vi.fn(), todoistProjects: vi.fn(), createTodoistTask: vi.fn(), updateTodoistTask: vi.fn(), moveTodoistTask: vi.fn(), closeTodoistTask: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const task = { id: "6Task", project_id: "6Project", content: "Test task <script>", description: "Details", priority: 4, due: null };
const page = { provider: "todoist" as const, activeSource: "todoist" as const, generatedAt: "2026-11-06T10:00:00Z", lastSyncedAt: "2026-11-06T10:00:00Z", results: [task], nextCursor: null };
const status = { provider: "todoist" as const, enabled: true, configured: true, writesEnabled: true, activeSource: "todoist" as const };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(page.lastSyncedAt));
  vi.mocked(client.todoistStatus).mockResolvedValue(status);
  vi.mocked(client.todoistTasks).mockResolvedValue(page);
  vi.mocked(client.todoistProjects).mockResolvedValue([{ id: "6Project", name: "Home" }]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(writesEnabled = true) { vi.mocked(client.todoistStatus).mockResolvedValue({ ...status, writesEnabled }); await act(async () => root.render(<TodoistTasksPage status={{ ...status, writesEnabled }} />)); }
function button(label: string) { return [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(label))!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function input(label: string, value: string) {
  const node = [...host.querySelectorAll("label")].find((element) => element.textContent?.startsWith(label))!.querySelector("input,textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}

test("loading then escaped rows, real projects and priority p1", async () => {
  let resolve!: (result: typeof page) => void;
  vi.mocked(client.todoistTasks).mockReturnValue(new Promise((done) => { resolve = done; }));
  await mount(); expect(host.textContent).toContain("Обновляем");
  await act(async () => resolve(page));
  expect(host.textContent).toContain("P1 · Home"); expect(host.querySelector("script")).toBeNull();
});
test("empty differs from offline and readonly blocks writes", async () => {
  vi.mocked(client.todoistTasks).mockResolvedValue({ ...page, results: [] });
  await mount(false); expect(host.textContent).toContain("Активных задач"); expect(button("Новая задача").disabled).toBe(true);
  vi.mocked(client.todoistTasks).mockRejectedValue(new client.TodoistClientError("offline"));
  await click("Обновить"); expect(host.textContent).toContain("Нет связи"); expect(host.textContent).not.toContain("Активных задач");
});
test("create is guarded while pending then list refreshes", async () => {
  let resolve!: (result: unknown) => void;
  vi.mocked(client.createTodoistTask).mockReturnValue(new Promise((done) => { resolve = done; }));
  await mount(); await click("Новая задача"); await input("Название", "New task");
  await act(async () => { button("Сохранить").click(); button("Сохранить").click(); });
  expect(client.createTodoistTask).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ accepted: true }));
  expect(client.todoistTasks).toHaveBeenCalledTimes(2); expect(host.textContent).toContain("Список обновлён");
});
test("edit uses sparse fields and preserves unchanged due schedule", async () => {
  await mount(); await click("Test task"); await input("Описание", "Updated"); await click("Сохранить");
  expect(client.updateTodoistTask).toHaveBeenCalledWith("6Task", { description: "Updated" });
});
test("uncertain close refreshes without retry or fake success", async () => {
  vi.mocked(client.closeTodoistTask).mockRejectedValue(new client.TodoistClientError("outcome_uncertain"));
  await mount(); await click("✓");
  expect(client.closeTodoistTask).toHaveBeenCalledTimes(1); expect(client.todoistTasks).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Исход команды неизвестен"); expect(host.textContent).not.toContain("Команда принята Todoist");
});
test("quota rejection keeps the draft and does not retry reads or writes", async () => {
  vi.mocked(client.updateTodoistTask).mockRejectedValue(new client.TodoistClientError("rate_limited", "60"));
  await mount(); await click("Test task"); await input("Описание", "Updated"); await click("Сохранить");
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Лимит Todoist");
  expect(client.updateTodoistTask).toHaveBeenCalledTimes(1); expect(client.todoistTasks).toHaveBeenCalledTimes(1);
});
test("cursor pages deduplicate task IDs", async () => {
  vi.mocked(client.todoistTasks).mockResolvedValueOnce({ ...page, nextCursor: "next" }).mockResolvedValueOnce(page);
  await mount(); await click("Загрузить ещё");
  expect(client.todoistTasks).toHaveBeenLastCalledWith("today", "", "next"); expect(host.querySelectorAll("li")).toHaveLength(1);
});
test("disabled Todoist preserves legacy fallback", async () => {
  vi.mocked(client.todoistStatus).mockResolvedValue({ ...status, enabled: false, activeSource: "planning" });
  await act(async () => root.render(<TasksProviderBoundary fallback={<div>Legacy Tasks</div>} />));
  expect(host.textContent).toBe("Legacy Tasks"); expect(client.todoistTasks).not.toHaveBeenCalled();
});
test("status failure exposes retry instead of claiming an empty list", async () => {
  vi.mocked(client.todoistStatus).mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<TasksProviderBoundary fallback={<div>Legacy Tasks</div>} />));
  expect(host.textContent).toContain("Не удалось определить источник"); expect(button("Повторить")).toBeDefined();
});
