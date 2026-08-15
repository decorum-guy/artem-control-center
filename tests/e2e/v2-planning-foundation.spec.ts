import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const artifactDirectory = (testInfo: { outputPath: (name: string) => string }) =>
  process.env.PR9_ARTIFACT_DIR ?? testInfo.outputPath("v2-planning-foundation-review");

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
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(0);
    await expect(page.locator(".planning-task-row input, .planning-task-row [role='checkbox']")).toHaveCount(0);

    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("route-calendar")).toHaveAttribute("data-planning-module", "planning.calendar-agenda");
    await expect(page.getByRole("button", { name: "Предыдущий день" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-all-day-band")).toContainText("Весь день");
    await expect(page.getByTestId("planning-calendar-all-day-band")).not.toContainText("00:00");
    const overlap = page.getByTestId("planning-calendar-event-row").filter({ hasText: "Первая пересекающаяся встреча" });
    await expect(overlap).toHaveAttribute("data-overlap", "true");
    await expect(overlap).toContainText("Пересекается по времени");
    await expect(overlap).toContainText("Синхронизация");

    await page.goto("/reminders?theme=day");
    await expect(page.getByTestId("route-reminders")).toHaveAttribute("data-planning-module", "planning.reminders-monitoring");
    await expect(page.locator(".planning-segmented button")).toHaveCount(3);
    await expect(page.getByTestId("planning-reminder-lifecycle").first()).toBeVisible();
    await expect(page.getByTestId("planning-reminder-delivery").first()).toBeVisible();
    await expect(page.locator("[data-testid='planning-future-action-slot']")).toHaveCount(0);
  });

  test("captures the bounded PR9 review matrix", async ({ page }, testInfo) => {
    const directory = artifactDirectory(testInfo);
    await mkdir(directory, { recursive: true });

    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-task-list")).toBeVisible();
    await capture(page, directory, "planning-tasks-default");

    await mutatePlanningRoute(page, "/api/v1/planning/tasks", (payload) => { payload.sourceStatus = "stale"; });
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные от");
    await capture(page, directory, "planning-tasks-stale");
    await page.unroute("**/api/v1/planning/tasks**");

    await failPlanningRoute(page, "/api/v1/planning/tasks");
    await page.goto("/tasks?theme=night");
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние данные · краткий снимок");
    await capture(page, directory, "planning-tasks-offline");
    await page.unroute("**/api/v1/planning/tasks**");

    await mutatePlanningRoute(page, "/api/v1/planning/tasks", (payload) => {
      payload.items = [];
      payload.count = 0;
      payload.hasMore = false;
    });
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-route-empty")).toBeVisible();
    await capture(page, directory, "planning-tasks-empty");
    await page.unroute("**/api/v1/planning/tasks**");

    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(6);
    await capture(page, directory, "planning-calendar-default");
    await capture(page, directory, "planning-calendar-all-day");
    await capture(page, directory, "planning-calendar-overlap");

    await mutatePlanningRoute(page, "/api/v1/planning/events", (payload) => {
      const items = payload.items as Array<Record<string, unknown>>;
      items[0].calendarIdentity = {
        providerId: "calendar-provider",
        providerLabel: "Calendar provider",
        calendarId: "personal",
        calendarLabel: "Личный"
      };
      items[1].calendarIdentity = {
        providerId: "calendar-provider",
        providerLabel: "Calendar provider",
        calendarId: "work",
        calendarLabel: "Рабочий"
      };
    });
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-calendar-identity").filter({ hasText: "Личный" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-identity").filter({ hasText: "Рабочий" })).toBeVisible();
    await capture(page, directory, "planning-calendar-multiple-identities");
    await page.unroute("**/api/v1/planning/events**");

    await page.goto("/reminders?theme=day");
    await expect(page.getByTestId("planning-reminder-list")).toBeVisible();
    await capture(page, directory, "planning-reminders-default");
    await page.getByRole("button", { name: "Пропущено" }).tap();
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Доставлено · ждёт завершения");
    await capture(page, directory, "planning-reminders-delivered-pending");
    await page.getByRole("button", { name: "Доставка", exact: true }).tap();
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Не доставлено");
    await capture(page, directory, "planning-reminders-delivery-failure");

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
