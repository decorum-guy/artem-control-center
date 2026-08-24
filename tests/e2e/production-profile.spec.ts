import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const productionProfileEnabled = [
  "VITE_V2_VISUAL_SHELL",
  "VITE_OVERVIEW_V2_ENABLED",
  "VITE_OVERVIEW_EDITOR_ENABLED",
  "VITE_PLANNING_OVERVIEW_ENABLED",
  "VITE_PLANNING_TASKS_ROUTE_ENABLED",
  "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
  "VITE_PLANNING_REMINDERS_ROUTE_ENABLED",
  "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED",
  "VITE_PLANNING_TASK_MUTATIONS_ENABLED",
  "VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED",
  "VITE_TOUCH_INPUT_LOCK_ENABLED",
  "VITE_TOUCH_INPUT_LOCK_START_LOCKED"
].every((name) => process.env[name] === "true");

test.describe("accepted-v2 production profile", () => {
  test.skip(!productionProfileEnabled, "Run through npm run test:e2e:production.");

  const artifactDirectory = "artifacts/production-profile/screenshots";

  async function capture(page: Page, name: string): Promise<void> {
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: path.join(artifactDirectory, name), animations: "disabled" });
  }

  test("exposes the accepted V2 shell, routes, and deliberate nav omissions", async ({ page }) => {
    await page.goto("/overview?theme=night");
    await expect(page.getByTestId("v2-shell")).toBeVisible();
    await expect(page.getByTestId("route-overview-v2")).toBeVisible();
    await expect(page.getByTestId("overview-configure")).toBeVisible();
    await expect(page.locator(".v2-navigation-primary .v2-nav-group-label")).toHaveText("ПЛАНИРОВАНИЕ");
    await expect(page.locator(".v2-nav-link[data-nav-route='/reminders']")).toContainText("Напоминания");
    await expect(page.locator(".v2-nav-link[data-nav-route='/apps'], .v2-nav-link[data-nav-route='/backups']")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("TickTick");
    await capture(page, "overview-night.png");

    const routes = [
      ["/home", "route-home-v2"],
      ["/services", "route-services-v2"],
      ["/system", "route-system"],
      ["/settings", "route-settings"],
      ["/tasks", "route-tasks"],
      ["/calendar", "route-calendar"],
      ["/reminders", "route-reminders"]
    ] as const;
    for (const [route, testId] of routes) {
      await page.goto(route);
      await expect(page.getByTestId(testId)).toBeVisible();
      await capture(page, `${route.slice(1)}.png`);
    }
  });

  test("exposes B4 mutation controls while keeping local policy boundaries visible", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("button", { name: "Создать задачу" })).toBeVisible();
    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: "Создать событие" })).toBeVisible();
    await page.goto("/reminders");
    await expect(page.getByRole("button", { name: "Создать напоминание" })).toBeVisible();
    await expect(page.getByText(/внешн.*только чтение/i)).toHaveCount(0);
    await expect(page.getByTestId("interaction-lock-control")).toHaveAttribute("aria-pressed", "true");
  });

  test("keeps server access policy authoritative for mutation exposure", async ({ page }) => {
    await page.route("**/api/v1/access", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          baseProfile: "read_only",
          effectiveProfile: "read_only",
          temporaryFull: false,
          temporaryFullExpiresAt: null,
          pinConfigured: false,
          lockoutUntil: null,
          capabilities: {
            "planning.tasks.create": {
              capability: "planning.tasks.create",
              minimumProfile: "standard",
              effectiveProfile: "read_only",
              allowed: false,
              availability: "profile_blocked"
            }
          }
        })
      });
    });
    await page.goto("/tasks");
    await expect(page.getByRole("button", { name: "Создать задачу" })).toHaveCount(0);
    await expect(page.getByTestId("planning-future-action-slot")).toHaveCount(0);
  });

  test("starts touch-locked and unlocks through the reviewed hold gesture", async ({ page }) => {
    await page.goto("/overview");
    const control = page.getByTestId("interaction-lock-control");
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await control.hover();
    await page.mouse.down();
    await expect(control.getByRole("progressbar")).toBeVisible();
    await page.waitForTimeout(1_050);
    await page.mouse.up();
    await expect(control).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("interaction-lock-status")).toHaveCount(0);
  });

  test("keeps the development gallery unavailable in the production build", async ({ page }) => {
    await page.goto("/dev/widget-gallery");
    await expect(page.getByTestId("dev-disabled")).toBeVisible();
    await expect(page.getByTestId("dev-disabled")).toContainText("недоступен в production build");
  });
});
