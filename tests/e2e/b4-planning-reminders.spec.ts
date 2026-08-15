import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const remindersRouteEnabled = process.env.B3_PLANNING_REMINDERS_ROUTE_ENABLED === "true";
const reminderMutationsEnabled = process.env.VITE_PLANNING_REMINDER_MUTATIONS_ENABLED === "true";
const artifactDirectory = (testInfo: { outputPath: (name: string) => string }) =>
  process.env.B4_ARTIFACT_DIR ?? testInfo.outputPath("b4-planning-reminders");

const canonicalBase = {
  id: "00000000-0000-4000-8000-000000000001",
  version: 1,
  source: "alice",
  sourceLabel: "AliceTG Bot",
  title: "Synthetic reminder",
  dueAtUtc: "2026-08-12T10:00:00Z",
  timezone: "Europe/Moscow",
  status: "pending",
  deliveryState: "not_due",
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

function objectEnvelope(object: Record<string, unknown>) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "reminder",
    object,
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z"
  };
}

async function installMutationFixtures(page: Page) {
  let canonical = { ...canonicalBase };

  await page.route("**/api/v1/planning/parse", async (route) => {
    const body = route.request().postDataJSON() as { text?: string };
    const text = typeof body.text === "string" ? body.text : "";
    const ambiguous = text.includes("вечером");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "planning.v1",
        kind: "parse_preview",
        candidate: ambiguous ? null : {
          domain: "reminder",
          operation: "create",
          fields: {
            title: text.includes("позвонить") ? "Позвонить врачу" : text,
            due_at_utc: "2026-08-13T13:00:00Z",
            timezone: "Europe/Moscow"
          },
          normalized_paraphrase: "Напомнить 13 августа в 16:00 по Москве: позвонить врачу"
        },
        confidence: ambiguous ? "medium" : "high",
        ambiguities: ambiguous ? [{ field: "time", candidates: ["16:00", "18:00"], reason: "«Вечером» не задаёт точное время." }] : [],
        requires_confirmation: ambiguous,
        normalized_text: text,
        error_code: null,
        correlation_id: "00000000-0000-4000-8000-000000000099"
      })
    });
  });

  await page.route("**/api/v1/planning/reminders", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { title?: string; due_at_utc?: string; timezone?: string };
    canonical = {
      ...canonical,
      id: "00000000-0000-4000-8000-000000000099",
      version: 1,
      title: body.title ?? canonical.title,
      dueAtUtc: body.due_at_utc ?? canonical.dueAtUtc,
      timezone: body.timezone ?? canonical.timezone,
      updatedAt: "2026-08-12T09:01:00Z"
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(canonical)) });
  });

  await page.route("**/api/v1/planning/reminders/**", async (route) => {
    if (route.request().method() !== "PATCH" && route.request().method() !== "POST") return route.fallback();
    const body = route.request().method() === "PATCH"
      ? route.request().postDataJSON() as { title?: string; due_at_utc?: string; timezone?: string }
      : {};
    const action = route.request().url().split("/").pop();
    canonical = {
      ...canonical,
      version: canonical.version + 1,
      title: body.title ?? canonical.title,
      dueAtUtc: body.due_at_utc ?? canonical.dueAtUtc,
      timezone: body.timezone ?? canonical.timezone,
      status: action === "complete" ? "completed" : action === "cancel" ? "cancelled" : canonical.status,
      updatedAt: "2026-08-12T09:02:00Z"
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(canonical)) });
  });
}

test.describe("B4 Phase 1 reminder mutations", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!remindersRouteEnabled, "B3 reminders route is not enabled for this browser run");
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("keeps all mutation controls absent when the writer gate is off", async ({ page }, testInfo) => {
    test.skip(reminderMutationsEnabled, "This assertion covers the default-off writer build");
    await page.goto("/reminders?theme=day");
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(0);
    await page.getByTestId("planning-reminder-route-row").first().click();
    await expect(page.getByTestId("planning-reminder-detail")).toBeVisible();
    await expect(page.getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Завершить явно" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Отменить явно" })).toHaveCount(0);
    const directory = artifactDirectory(testInfo);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, "writer-gate-off.png"), animations: "disabled" });
  });

  test("shows ambiguity before save and replaces local state with canonical create response", async ({ page }, testInfo) => {
    test.skip(!reminderMutationsEnabled, "Gated writer browser pass");
    await installMutationFixtures(page);
    await page.goto("/reminders?theme=day");
    await page.getByRole("button", { name: "Создать напоминание" }).click();
    const sheet = page.getByTestId("planning-reminder-mutation");
    const input = sheet.getByLabel("Фраза");
    const save = sheet.getByRole("button", { name: "Сохранить" });
    await input.fill("завтра вечером напомни позвонить врачу");
    await expect(page.getByTestId("planning-reminder-ambiguities")).toContainText("не задаёт точное время");
    await expect(save).toBeDisabled();

    const directory = artifactDirectory(testInfo);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, "ambiguous-save-disabled.png"), animations: "disabled" });

    await input.fill("завтра в 16:00 напомни позвонить врачу");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("global-notice-stack")).toContainText("Напоминание создано");
    await expect(page.getByTestId("planning-reminder-detail")).toContainText("Позвонить врачу");
    await page.screenshot({ path: path.join(directory, "canonical-create-readback.png"), animations: "disabled" });
  });

  test("keeps delivery separate from explicit lifecycle actions", async ({ page }) => {
    test.skip(!reminderMutationsEnabled, "Gated writer browser pass");
    await installMutationFixtures(page);
    await page.goto("/reminders?theme=day");
    await page.getByRole("button", { name: "Пропущено" }).click();
    const delivered = page.getByTestId("planning-reminder-route-row").filter({ hasText: "Доставлено, ждёт завершения" });
    await delivered.click();
    await expect(page.getByTestId("planning-reminder-detail")).toContainText("Доставка");
    await expect(page.getByTestId("planning-reminder-detail")).toContainText("Доставлено");
    await expect(page.getByRole("button", { name: "Завершить явно" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Отменить явно" })).toBeVisible();
    await page.getByRole("button", { name: "Завершить явно" }).click();
    await expect(page.getByTestId("global-notice-stack")).toContainText("Напоминание завершено");
    await expect(page.getByTestId("planning-reminder-detail")).toContainText("Завершено");
  });
});
