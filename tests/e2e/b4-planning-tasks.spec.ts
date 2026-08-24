import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const tasksRouteEnabled = process.env.B3_PLANNING_TASKS_ROUTE_ENABLED === "true";
const taskMutationsEnabled = process.env.VITE_PLANNING_TASK_MUTATIONS_ENABLED === "true";
const artifactDirectory = (testInfo: { outputPath: (name: string) => string }) =>
  process.env.B4_TASK_ARTIFACT_DIR ?? testInfo.outputPath("b4-task-mutations");

const taskId = "00000000-0000-4000-8000-000000000101";
const canonicalBase = {
  id: taskId,
  version: 1,
  source: "panel-agent",
  sourceLabel: "Panel Agent",
  title: "Открытая задача",
  notes: "Не потерять контекст",
  priority: "high",
  status: "open",
  dueDate: "2026-08-14",
  dueTime: null,
  timezone: null,
  projectId: "00000000-0000-4000-8000-000000000401",
  sourceRef: null,
  completedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const planningAccessIds = [
  "planning.tasks.create",
  "planning.tasks.edit",
  "planning.tasks.complete",
  "planning.tasks.archive"
] as const;

async function installAccessFixture(page: Page, profile: "read_only" | "standard") {
  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/access") {
      await route.fallback();
      return;
    }
    const allowed = profile === "standard";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        baseProfile: profile,
        effectiveProfile: profile,
        temporaryFull: false,
        temporaryFullExpiresAt: null,
        pinConfigured: true,
        lockoutUntil: null,
        capabilities: Object.fromEntries(planningAccessIds.map((capability) => [capability, {
          capability,
          minimumProfile: "standard",
          effectiveProfile: profile,
          allowed,
          availability: allowed ? "allowed" : "profile_blocked"
        }]))
      })
    });
  });
}

function objectEnvelope(object: Record<string, unknown>) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "task",
    object,
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z"
  };
}

async function installMutationFixtures(page: Page, options: { createResponseLost?: boolean } = {}) {
  let canonical = { ...canonicalBase };
  let createAttempts = 0;

  const listEnvelope = () => ({
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain: "task",
    generatedAt: "2026-08-12T09:00:00Z",
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z",
    items: [canonical],
    limit: 20,
    offset: 0,
    count: 1,
    hasMore: false
  });

  await page.route("**/api/v1/planning/parse", async (route) => {
    const body = route.request().postDataJSON() as { text?: string };
    const text = typeof body.text === "string" ? body.text : "";
    const ambiguous = text.includes("вечером");
    const timed = text.includes("18:30");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "planning.v1",
        kind: "parse_preview",
        candidate: ambiguous ? null : {
          domain: "task",
          operation: "create",
          fields: {
            title: timed ? "Отправить отчёт" : text.includes("купить") ? "Купить продукты" : text,
            priority: "none",
            due_date: "2026-08-14",
            due_time: timed ? "18:30" : null,
            timezone: timed ? "Europe/Moscow" : null
          },
          normalized_paraphrase: timed
            ? "Задача «Отправить отчёт» на 14 августа в 18:30 (Europe/Moscow)."
            : "Задача «Купить продукты» на 14 августа без времени."
        },
        confidence: ambiguous ? "medium" : "high",
        ambiguities: ambiguous ? [{ field: "time", candidates: ["18:00", "20:00"], reason: "«Вечером» не задаёт точное время." }] : [],
        requires_confirmation: ambiguous,
        normalized_text: text,
        error_code: null,
        correlation_id: "00000000-0000-4000-8000-000000000099"
      })
    });
  });

  await page.route("**/api/v1/planning/tasks", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listEnvelope()) });
      return;
    }
    if (route.request().method() !== "POST") return route.fallback();
    createAttempts += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    canonical = {
      ...canonical,
      title: typeof body.title === "string" ? body.title : canonical.title,
      notes: body.notes === undefined ? canonical.notes : body.notes,
      priority: typeof body.priority === "string" ? body.priority : canonical.priority,
      dueDate: body.due_date === undefined ? canonical.dueDate : body.due_date,
      dueTime: body.due_time === undefined ? canonical.dueTime : body.due_time,
      timezone: body.timezone === undefined ? canonical.timezone : body.timezone,
      version: 1,
      updatedAt: "2026-08-12T09:01:00Z"
    };
    if (options.createResponseLost && createAttempts === 1) {
      await route.abort("timedout");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(canonical)) });
  });

  await page.route("**/api/v1/planning/tasks/**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(canonical)) });
      return;
    }
    if (method !== "PATCH" && method !== "POST" && method !== "DELETE") return route.fallback();
    const body = method === "PATCH" ? route.request().postDataJSON() as Record<string, unknown> : {};
    canonical = {
      ...canonical,
      title: typeof body.title === "string" ? body.title : canonical.title,
      notes: body.notes === undefined ? canonical.notes : body.notes,
      priority: typeof body.priority === "string" ? body.priority : canonical.priority,
      dueDate: body.due_date === undefined ? canonical.dueDate : body.due_date,
      dueTime: body.due_time === undefined ? canonical.dueTime : body.due_time,
      timezone: body.timezone === undefined ? canonical.timezone : body.timezone,
      status: route.request().url().endsWith("/complete") ? "completed" : method === "DELETE" ? "archived" : canonical.status,
      completedAt: route.request().url().endsWith("/complete") ? "2026-08-12T09:02:00Z" : canonical.completedAt,
      archivedAt: method === "DELETE" ? "2026-08-12T09:02:00Z" : canonical.archivedAt,
      deletedAt: method === "DELETE" ? "2026-08-12T09:02:00Z" : canonical.deletedAt,
      version: canonical.version + 1,
      updatedAt: "2026-08-12T09:02:00Z"
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(canonical)) });
  });
}

async function openTaskCreator(page: Page) {
  await page.goto("/tasks?theme=day");
  await unlockTouchLockIfNeeded(page);
  await page.getByRole("button", { name: "Создать задачу" }).click();
  return page.getByTestId("planning-task-mutation");
}

async function saveTask(page: Page, text: string) {
  const sheet = page.getByTestId("planning-task-mutation");
  await sheet.getByLabel("Фраза").fill(text);
  const save = sheet.getByRole("button", { name: "Сохранить" });
  await expect(save).toBeEnabled();
  await save.click();
}

test.describe("B4.2 task mutations", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!tasksRouteEnabled, "B3 tasks route is not enabled for this browser run");
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("keeps task mutation controls absent when the writer gate is off", async ({ page }, testInfo) => {
    test.skip(taskMutationsEnabled, "This assertion covers the default-off writer build");
    await installAccessFixture(page, "read_only");
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(0);
    await page.getByTestId("planning-task-route-row").first().click();
    await expect(page.getByTestId("planning-task-detail")).toBeVisible();
    await expect(page.getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Завершить" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Архивировать" })).toHaveCount(0);
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-gate-off.png"), animations: "disabled" });
  });

  test("read-only profile sends zero task mutation requests", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "read_only");
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/tasks") && request.method() !== "GET") mutations.push(request.method());
    });
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(0);
    await page.getByTestId("planning-task-route-row").first().click();
    await expect(page.getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Завершить" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Архивировать" })).toHaveCount(0);
    expect(mutations).toEqual([]);
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-read-only.png"), animations: "disabled" });
  });

  test("creates a date-only task without inventing time or timezone", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    const requests: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/planning/tasks") && request.method() === "POST") requests.push(request.postDataJSON() as Record<string, unknown>);
    });
    await openTaskCreator(page);
    await saveTask(page, "завтра купить продукты");
    await expect(page.getByTestId("global-notice-stack")).toContainText("Задача создана");
    expect(requests[0]).toMatchObject({ priority: "none", due_date: "2026-08-14", due_time: null, timezone: null });
    await expect(page.getByTestId("planning-task-detail")).toContainText("14 авг.");
    await expect(page.getByTestId("planning-task-detail")).not.toContainText("00:00");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-date-only-create.png"), animations: "disabled" });
  });

  test("creates a timed task with explicit local time and IANA timezone", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    const requests: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/planning/tasks") && request.method() === "POST") requests.push(request.postDataJSON() as Record<string, unknown>);
    });
    await openTaskCreator(page);
    await saveTask(page, "завтра в 18:30 отправить отчёт");
    expect(requests[0]).toMatchObject({ priority: "none", due_date: "2026-08-14", due_time: "18:30", timezone: "Europe/Moscow" });
    await expect(page.getByTestId("planning-task-detail")).toContainText("18:30");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-timed-create.png"), animations: "disabled" });
  });

  test("edits owned fields without resetting priority, notes, or project", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    await page.goto("/tasks?theme=day");
    await unlockTouchLockIfNeeded(page);
    await page.getByTestId("planning-task-route-row").first().click();
    const patchBodies: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/tasks/") && request.method() === "PATCH") {
        patchBodies.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    const detail = page.getByTestId("planning-task-detail");
    await expect(detail).toContainText("Высокий");
    await page.getByRole("button", { name: "Изменить" }).click();
    await saveTask(page, "завтра в 18:30 отправить отчёт");
    await expect.poll(() => patchBodies.length).toBe(1);
    expect(patchBodies[0]).toMatchObject({
      title: "Отправить отчёт",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    });
    expect(patchBodies[0]).not.toHaveProperty("priority");
    expect(patchBodies[0]).not.toHaveProperty("notes");
    expect(patchBodies[0]).not.toHaveProperty("project_id");
    await expect(detail).toContainText("Отправить отчёт");
    await expect(detail).toContainText("Высокий");
    await expect(detail).toContainText("Не потерять контекст");
    await expect(detail).toContainText("18:30");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-edit-preserves-priority.png"), animations: "disabled" });
  });

  test("keeps Save disabled for a materially ambiguous time", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    await openTaskCreator(page);
    const sheet = page.getByTestId("planning-task-mutation");
    await sheet.getByLabel("Фраза").fill("завтра вечером купить продукты");
    await expect(page.getByTestId("planning-task-ambiguities")).toContainText("не задаёт точное время");
    await expect(sheet.getByRole("button", { name: "Сохранить" })).toBeDisabled();
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-ambiguous.png"), animations: "disabled" });
  });

  test("complete uses shared confirmation and double tap creates one logical request", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    await page.goto("/tasks?theme=day");
    await unlockTouchLockIfNeeded(page);
    await page.getByTestId("planning-task-route-row").first().click();
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/tasks/") && request.method() === "POST") mutations.push(request.method());
    });
    await page.getByRole("button", { name: "Завершить" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    const confirmation = page.getByTestId("action-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("Завершить задачу");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-complete-confirmation.png"), animations: "disabled" });
    await confirmation.getByRole("button", { name: "Отмена" }).click();
    expect(mutations).toEqual([]);
    await page.getByRole("button", { name: "Завершить" }).click();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Завершить задачу" }).click();
    await expect.poll(() => mutations.length).toBe(1);
    await expect(page.getByTestId("global-notice-stack")).toContainText("Задача завершена");
  });

  test("archive uses DELETE as logical removal and confirms before one request", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    await page.goto("/tasks?theme=day");
    await unlockTouchLockIfNeeded(page);
    await page.getByTestId("planning-task-route-row").first().click();
    const methods: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/tasks/") && request.method() !== "GET") methods.push(request.method());
    });
    await page.getByRole("button", { name: "Архивировать" }).click();
    const confirmation = page.getByTestId("action-confirmation");
    await expect(confirmation).toContainText("логическое архивирование");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-archive-confirmation.png"), animations: "disabled" });
    await confirmation.getByRole("button", { name: "Отмена" }).click();
    expect(methods).toEqual([]);
    await page.getByRole("button", { name: "Архивировать" }).click();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Архивировать задачу" }).click();
    await expect.poll(() => methods).toEqual(["DELETE"]);
    await expect(page.getByTestId("global-notice-stack")).toContainText("Задача архивирована");
  });

  test("reconciles create response loss with same key replay and warning semantics", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page, { createResponseLost: true });
    await openTaskCreator(page);
    await saveTask(page, "завтра купить продукты");
    await expect(page.getByTestId("global-notice-stack")).toContainText("Результат подтверждён чтением");
    await expect(page.getByTestId("global-notice-stack")).not.toContainText("Задача создана");
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-reconciled.png"), animations: "disabled" });
  });

  test("keeps touch targets usable at 200 percent and during OSK-style editing", async ({ page }, testInfo) => {
    test.skip(!taskMutationsEnabled, "Gated writer browser pass");
    await installAccessFixture(page, "standard");
    await installMutationFixtures(page);
    await page.goto("/tasks?theme=day");
    await unlockTouchLockIfNeeded(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; document.body.style.zoom = "2"; });
    await page.getByRole("button", { name: "Создать задачу" }).click();
    const input = page.getByTestId("planning-task-mutation").getByLabel("Фраза");
    await input.fill("завтра купить продукты");
    await input.focus();
    const targetHeights = await page.locator("button, textarea, input").evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)).filter((height) => height > 0));
    expect(Math.min(...targetHeights)).toBeGreaterThanOrEqual(48);
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory(testInfo), "b4-tasks-200-percent.png"), animations: "disabled" });
  });
});
