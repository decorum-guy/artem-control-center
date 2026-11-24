import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const artifactDirectory = (testInfo: { outputPath: (name: string) => string }) =>
  process.env.PR9_ARTIFACT_DIR ?? testInfo.outputPath("v2-planning-foundation-review");
const taskMutationsEnabled = process.env.VITE_PLANNING_TASK_MUTATIONS_ENABLED === "true";
const planningMutationControlsEnabled = [
  "VITE_PLANNING_TASK_MUTATIONS_ENABLED",
  "VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED",
  "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED"
].some((name) => process.env[name] === "true");

async function mutatePlanningRoute(page: Page, routePath: string, mutate: (payload: Record<string, unknown>) => void) {
  await page.route(`**${routePath}*`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    mutate(payload);
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function failPlanningRoute(page: Page, routePath: string) {
  await page.route(`**${routePath}*`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "planning_read_unavailable" })
    });
  });
}

async function capture(page: Page, directory: string, name: string) {
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled" });
}

async function expectNoHorizontalDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test.describe("PR9 Planning visual/module foundation", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("keeps canonical route frames, status truth, identity, and mutation absence", async ({ page }) => {
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("route-tasks")).toHaveAttribute("data-planning-module", "planning.tasks");
    await expect(page.getByRole("heading", { name: "Задачи" })).toBeVisible();
    await expect(page.locator(".planning-segmented button").first()).toHaveCSS("min-height", "48px");
    await expect(page.getByTestId("planning-task-route-row").first()).toBeVisible();
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(taskMutationsEnabled ? 1 : 0);
    await expect(page.locator(".planning-task-row input, .planning-task-row [role='checkbox']")).toHaveCount(0);

    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("route-calendar")).toHaveAttribute("data-planning-module", "planning.calendar-agenda");
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-month-heading")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-month-cell")).toHaveCount(42);
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-all-day-band")).toContainText("Весь день");
    await expect(page.getByTestId("planning-calendar-all-day-band")).not.toContainText("00:00");
    const overlap = page.getByTestId("planning-calendar-event-row").filter({ hasText: "Первая пересекающаяся встреча" });
    await expect(overlap).toHaveAttribute("data-overlap", "true");
    await expect(overlap).toContainText("Пересекается");
    await expect(overlap).not.toContainText("Синхронизация: Синхронизировано");
    await expect(overlap).not.toContainText("Europe/Moscow");

    await page.goto("/reminders?theme=day");
    await expect(page.getByTestId("alice-reminders")).toContainText("Источник Алисы не настроен");
    await capture(page, directory, "planning-reminders-alice");

    await page.goto("/overview?theme=day");
    await expect(page.getByTestId("planning-overview-card")).toBeVisible();
    await capture(page, directory, "planning-overview-default");

    await page.goto("/tasks?theme=day");
    await mutatePlanningRoute(page, "/api/v1/planning/tasks", (payload) => {
      const items = payload.items as Array<Record<string, unknown>>;
      items[0].title = "Очень длинная русская задача <script>alert(1)</script> https://example.com light.turn_on /etc/passwd";
    });
    await page.reload();
    await expect(page.getByTestId("planning-task-list")).toContainText("<script>alert(1)</script>");
    await expect(page.getByTestId("planning-task-list").locator("script")).toHaveCount(0);
    await capture(page, directory, "planning-long-russian");
    await page.unroute("**/api/v1/planning/tasks**");

    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto("/tasks?theme=day");
    await expectNoHorizontalDocumentOverflow(page);
    await expect(page.locator(".v2-navigation-route-bar")).toBeVisible();
    const targetViolations = await page.locator(".planning-segmented button, .planning-secondary-button, .planning-route-row").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48 ? [] : [{ text: element.textContent?.trim(), width: rect.width, height: rect.height }];
    }));
    expect(targetViolations).toEqual([]);
    await capture(page, directory, "planning-200-percent");
  });

  test("preserves independent route rollout when the shell is enabled", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByTestId("route-tasks")).toBeVisible();
    await expect(page.locator(".v2-nav-link[data-nav-route='/calendar']")).toBeVisible();
    await expect(page.locator(".v2-nav-link[data-nav-route='/tasks']")).toBeVisible();
    await expect(page.locator(".v2-nav-link[data-nav-route='/reminders']")).toBeVisible();
  });
});
