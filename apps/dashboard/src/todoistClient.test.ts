import { afterEach, expect, test, vi } from "vitest";
import { closeTodoistTask, createTodoistTask, todoistPriority, todoistProjects, updateTodoistTask } from "./todoistClient";

afterEach(() => vi.unstubAllGlobals());
test("projects follow cursors and deduplicate IDs without browser authorization", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ results: [{ id: "6A", name: "Home" }], nextCursor: "cursor.next" })).mockResolvedValueOnce(Response.json({ results: [{ id: "6A", name: "Home" }, { id: "6B", name: "Work" }], nextCursor: null }));
  vi.stubGlobal("fetch", fetch);
  expect(await todoistProjects()).toEqual([{ id: "6A", name: "Home" }, { id: "6B", name: "Work" }]);
  expect(fetch.mock.calls[1][0]).toBe("/api/v1/todoist/projects?limit=200&cursor=cursor.next");
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("headers.Authorization");
});
test("a project cursor cycle fails without returning partial data", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ results: [{ id: "6A", name: "Home" }], nextCursor: "same" }));
  vi.stubGlobal("fetch", fetch);
  await expect(todoistProjects()).rejects.toThrow("malformed_response"); expect(fetch).toHaveBeenCalledTimes(2);
});
test("mutation methods are POST and an ambiguous fetch is not retried", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetch);
  await expect(createTodoistTask({ content: "X" })).rejects.toThrow("outcome_uncertain");
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBe("POST");
});
test("update and close use their own provider paths", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ accepted: true })); vi.stubGlobal("fetch", fetch);
  await updateTodoistTask("6Task", { priority: "p1" }); await closeTodoistTask("6Task");
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(["/api/v1/todoist/tasks/6Task", "/api/v1/todoist/tasks/6Task/close"]);
  expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "POST"]);
  expect(fetch.mock.calls[1][1]).not.toHaveProperty("body");
});
test.each([[4, "p1"], [3, "p2"], [2, "p3"], [1, "p4"]])("API priority %s renders as %s", (api, ui) => { expect(todoistPriority(api as number)).toBe(ui); });
