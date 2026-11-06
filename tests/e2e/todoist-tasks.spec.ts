import { expect, test, type Page } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const task = { id: "6Task", project_id: "6Project", content: "Купить кофе", description: "Зёрна", priority: 4, due: { date: "2026-11-06", timezone: null, is_recurring: false, string: "today" } };
async function fixtures(page: Page, options: { writes?: boolean; error?: string } = {}) {
  await page.clock.setFixedTime(new Date("2026-11-06T10:00:00Z"));
  let tasks = [{ ...task }];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/access", (route) => route.fulfill({ json: { schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard", temporaryFull: false, temporaryFullExpiresAt: null, pinConfigured: true, lockoutUntil: null, confirmationPolicy: { actionConfirmationRequired: true, mode: "profile_default" }, capabilities: { "todoist.tasks.write": { capability: "todoist.tasks.write", minimumProfile: "standard", effectiveProfile: "standard", allowed: options.writes !== false, availability: options.writes === false ? "profile_blocked" : "allowed" } } } }));
  await page.route("**/api/v1/todoist/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() === "POST") {
      calls.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      if (options.error === "outcome_uncertain") return route.fulfill({ status: 503, json: { detail: options.error } });
      if (path.endsWith("/close")) tasks = [];
      else if (path.endsWith("/move")) tasks[0].project_id = request.postDataJSON().project_id;
      else if (path.endsWith("/6Task")) tasks[0] = { ...tasks[0], ...request.postDataJSON() };
      else tasks.push({ ...task, ...request.postDataJSON(), priority: 5 - Number(String(request.postDataJSON().priority ?? "p4").slice(1)), id: "6NewTask" });
      return route.fulfill({ json: { provider: "todoist", accepted: true } });
    }
    if (path.endsWith("/status")) return route.fulfill({ json: { provider: "todoist", enabled: true, configured: true, activeSource: "todoist", writesEnabled: options.writes !== false } });
    if (options.error && options.error !== "outcome_uncertain" && path.endsWith("/tasks")) return route.fulfill({ status: 502, json: { detail: options.error } });
    return route.fulfill({ json: { provider: "todoist", activeSource: "todoist", generatedAt: "2026-11-06T10:00:00Z", lastSyncedAt: "2026-11-06T10:00:00Z", results: path.endsWith("/projects") ? [{ id: "6Project", name: "Личное" }, { id: "6Other", name: "Работа" }] : tasks, nextCursor: null } });
  });
  await page.goto("/tasks"); await unlockTouchLockIfNeeded(page);
  return calls;
}

for (const theme of ["day", "night"]) {
  test(`Todoist touch geometry and mutations at 1280x720 ${theme}`, async ({ page }, testInfo) => {
    const calls = await fixtures(page);
    await page.goto(`/tasks?theme=${theme}`); await unlockTouchLockIfNeeded(page);
    await expect(page.getByTestId("todoist-tasks")).toBeVisible();
    await expect(page.getByText("Купить кофе", { exact: true })).toBeVisible();
    await expect(page.getByText(/P1 · Личное/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const control of await page.getByTestId("todoist-tasks").locator("button,select").all()) {
      const box = await control.boundingBox(); expect(box?.height).toBeGreaterThanOrEqual(48);
    }
    await page.screenshot({ path: testInfo.outputPath(`todoist-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Новая задача" }).click();
    await page.getByLabel("Название", { exact: true }).fill("Заказать фильтры");
    await page.getByLabel("Приоритет", { exact: true }).selectOption("p2");
    await page.getByLabel("Проект задачи", { exact: true }).selectOption("6Other");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByText("Заказать фильтры", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Купить кофе P1/ }).click();
    await page.getByLabel("Описание", { exact: true }).fill("Обновлено");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /Купить кофе P1/ }).click();
    await page.getByLabel("Проект задачи", { exact: true }).selectOption("6Other");
    await page.getByRole("button", { name: "Перенести в проект" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Завершить: Купить кофе", exact: true }).click();
    await expect(page.getByText("Активных задач в этом разделе нет.")).toBeVisible();
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/todoist/tasks", "/api/v1/todoist/tasks/6Task", "/api/v1/todoist/tasks/6Task/move", "/api/v1/todoist/tasks/6Task/close"]);
    expect(calls[0].body).toMatchObject({ priority: "p2", project_id: "6Other" });
    expect(calls[1].body).toEqual({ description: "Обновлено" });
  });
}
for (const error of ["offline", "invalid_token", "rate_limited", "outcome_uncertain"]) {
  test(`honest ${error} state without live Todoist`, async ({ page }) => {
    const calls = await fixtures(page, { error });
    if (error === "outcome_uncertain") {
      await page.getByRole("button", { name: "Завершить: Купить кофе", exact: true }).click();
      await expect(page.getByText(/Исход команды неизвестен/)).toBeVisible(); expect(calls).toHaveLength(1);
      await expect(page.getByText("Купить кофе", { exact: true })).toBeVisible();
    } else await expect(page.getByRole("alert")).toBeVisible();
  });
}
test("read-only controls are disabled", async ({ page }) => {
  const calls = await fixtures(page, { writes: false });
  await expect(page.getByRole("button", { name: "Новая задача" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Завершить: Купить кофе", exact: true })).toBeDisabled(); expect(calls).toHaveLength(0);
});
