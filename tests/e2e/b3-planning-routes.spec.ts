import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const viewport = { width: 1280, height: 720 };
const v2ShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";

async function assertPlanningTrafficIsReadOnly(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/planning/") && request.method() !== "GET") writes.push(`${request.method()} ${request.url()}`);
  });
  return () => expect(writes, writes.join("\n")).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(result.width).toBeLessThanOrEqual(result.viewport + 1);
}

async function openDetailAndClose(page: Page, rowTestId: string, sheetTestId: string) {
  await page.getByTestId(rowTestId).first().tap();
  await expect(page.getByTestId(sheetTestId)).toBeVisible();
  await page.getByTestId(sheetTestId).getByRole("button", { name: "Закрыть" }).tap();
  await expect(page.getByTestId(sheetTestId)).toHaveCount(0);
}

async function setRouteResponseState(page: Page, routePath: string, status: number, mutate?: (payload: Record<string, unknown>) => void) {
  await page.route(`**${routePath}*`, async (route) => {
    const response = await route.fetch();
    if (status !== 200) {
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
      return;
    }
    const payload = await response.json() as Record<string, unknown>;
    mutate?.(payload);
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function setEmptyPlanningPreview(page: Page, domain: "tasks" | "calendar" | "reminders") {
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    const planning = payload.planning as Record<string, unknown>;
    if (domain === "tasks") {
      planning.tasks = { today: [], overdue: [], upcoming: [], projects: [] };
    } else if (domain === "calendar") {
      planning.calendar = { today: [], upcoming: [], conflicts: [] };
    } else {
      planning.reminders = { upcoming: [], overdue: [], deliveryFailures: [] };
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function expectReminderViewResponse(
  page: Page,
  view: "upcoming" | "overdue" | "delivery",
  action: () => Promise<unknown>,
) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/planning/reminders/view"
      && url.searchParams.get("view") === view;
  });
  await action();
  const response = await responsePromise;
  const payload = await response.json() as Record<string, unknown>;
  expect(response.status()).toBe(200);
  expect(payload.schemaVersion).toBe("planning.panel.v1");
  expect(payload.kind).toBe("list");
  expect(payload.domain).toBe("reminder");
  expect(payload.sourceStatus).toBe("current");
  expect(payload.lastSyncedAt).toBeTruthy();
  expect(Array.isArray(payload.sources)).toBeTruthy();
  expect(payload.sources).not.toBeNull();
  expect(JSON.stringify(payload)).not.toContain("accountId");
  expect(JSON.stringify(payload)).not.toContain("correlation_id");
}

test.describe("B3 Planning monitoring routes", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("Tasks route is segmented, paginated, project-filtered, date-safe, and read-only", async ({ page }) => {
    const assertNoWrites = await assertPlanningTrafficIsReadOnly(page);
    await page.goto("/tasks");
    await expect(page.getByTestId("route-tasks")).toBeVisible();
    await expect(page.getByText("Источник задач ещё не подключён.")).toHaveCount(0);
    await expect(page.locator(".planning-segmented").first().getByRole("button", { name: "Сегодня" })).toBeVisible();
    await expect(page.getByTestId("planning-task-list")).not.toContainText("00:00");

    await page.locator(".planning-segmented").first().getByRole("button", { name: "Скоро" }).tap();
    await expect(page.getByTestId("planning-task-list")).toContainText("Срок");
    await page.getByRole("button", { name: "Проект", exact: true }).tap();
    await expect(page.getByTestId("planning-project-sheet")).toBeVisible();
    await expect(page.getByTestId("planning-project-sheet")).toContainText("Все проекты");
    await page.getByTestId("planning-project-sheet").getByRole("option", { name: "Домашние дела" }).tap();
    await expect(page.getByTestId("planning-project-sheet")).toHaveCount(0);
    await expect(page.getByTestId("planning-task-list")).toBeVisible();
    await openDetailAndClose(page, "planning-task-route-row", "planning-task-detail");

    await page.goto("/tasks");
    await page.unroute("**/api/v1/planning/tasks**").catch(() => undefined);
    let taskTemplate: Record<string, unknown> | null = null;
    await page.route("**/api/v1/planning/tasks**", async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as Record<string, unknown>;
      const url = new URL(route.request().url());
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const source = (payload.items as Array<Record<string, unknown>>)[0] ?? taskTemplate;
      if (!source) throw new Error("B3 pagination fixture has no task template");
      taskTemplate ??= source;
      const items = Array.from({ length: 20 }, (_, index) => ({
        ...source,
        id: `00000000-0000-4000-8000-${String(7000 + offset + index).padStart(12, "0")}`,
        title: `Задача страницы ${offset / 20 + 1} · ${index + 1}`
      }));
      payload.items = items;
      payload.count = items.length;
      payload.offset = offset;
      payload.hasMore = offset === 0;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.reload();
    await expect(page.getByTestId("planning-task-route-row").first()).toContainText("Задача страницы 1");
    await page.getByRole("button", { name: "Ещё" }).tap();
    await expect(page.getByTestId("planning-task-route-row").first()).toContainText("Задача страницы 2");
    await assertNoWrites();
  });

  test("Calendar shows the month grid, selected-day rows, overlaps, local source, and details", async ({ page }) => {
    const assertNoWrites = await assertPlanningTrafficIsReadOnly(page);
    await page.goto("/calendar");
    await expect(page.getByTestId("route-calendar")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-all-day-band")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(6);
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Первая пересекающаяся встреча" })).toContainText("Пересекается");
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Граничная встреча" })).not.toContainText("Пересекается");
    await expect(page.getByTestId("planning-calendar-event-row").first()).toContainText("Только локально");
    await openDetailAndClose(page, "planning-calendar-event-row", "planning-calendar-detail");

    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await page.getByRole("button", { name: "Предыдущий месяц" }).tap();
    await expect(page.getByTestId("planning-calendar-month-heading")).toContainText("Июль");
    await page.getByRole("button", { name: "Следующий месяц" }).tap();
    await expect(page.getByTestId("planning-calendar-month-heading")).toContainText("Август");
    await page.getByRole("button", { name: "Сегодня" }).tap();
    await expectNoHorizontalOverflow(page);
    await assertNoWrites();
  });

  test("Overview reaches the reminder monitor without requiring a placeholder row", async ({ page }) => {
    const assertNoWrites = await assertPlanningTrafficIsReadOnly(page);
    await setEmptyPlanningPreview(page, "tasks");
    await page.goto("/overview");
    const overviewReminder = page.getByTestId("planning-reminder-row");
    if (await overviewReminder.count()) {
      await expectReminderViewResponse(page, "upcoming", () => overviewReminder.tap());
    } else {
      await expectReminderViewResponse(page, "upcoming", () => page.goto("/reminders"));
    }
    await expect(page.getByTestId("route-reminders")).toBeVisible();
    await expect(page.getByRole("link", { name: "Напоминания" })).toHaveCount(v2ShellEnabled ? 1 : 0);
    await expectReminderViewResponse(
      page,
      "overdue",
      () => page.locator(".planning-segmented").getByRole("button", { name: "Пропущено" }).tap(),
    );
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Доставлено · ждёт завершения");
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Открыто");
    await expectReminderViewResponse(
      page,
      "delivery",
      () => page.locator(".planning-segmented").getByRole("button", { name: "Доставка" }).tap(),
    );
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Повторная попытка");
    await expect(page.getByTestId("planning-reminder-list")).toContainText("Не доставлено");
    await expect(page.getByTestId("planning-reminder-list")).not.toContainText("Доставлено · ждёт завершения");
    await openDetailAndClose(page, "planning-reminder-route-row", "planning-reminder-detail");
    await assertNoWrites();
  });

  test("route health distinguishes degraded, cached offline preview, empty, and retry", async ({ page }) => {
    await setRouteResponseState(page, "/api/v1/planning/tasks", 200, (payload) => {
      payload.sourceStatus = "degraded";
    });
    await page.goto("/tasks");
    await page.clock.fastForward(3_600);
    await expect(page.getByTestId("planning-route-health")).toHaveAttribute("data-state", "degraded");
    await expect(page.getByTestId("planning-route-health")).toContainText("Есть проблемы");
    await page.unroute("**/api/v1/planning/tasks**");

    await setRouteResponseState(page, "/api/v1/planning/tasks", 200, (payload) => {
      payload.sourceStatus = "stale";
    });
    await page.goto("/tasks");
    await page.clock.fastForward(3_600);
    await expect(page.getByTestId("planning-route-health")).toHaveAttribute("data-state", "stale");
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные могут быть устаревшими");
    await page.unroute("**/api/v1/planning/tasks**");

    await setRouteResponseState(page, "/api/v1/planning/tasks", 200, (payload) => {
      payload.items = [];
      payload.count = 0;
      payload.hasMore = false;
    });
    await page.goto("/tasks");
    await expect(page.getByTestId("planning-route-empty")).toBeVisible();
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
    await page.unroute("**/api/v1/planning/tasks**");

    await setRouteResponseState(page, "/api/v1/planning/tasks", 503);
    await page.goto("/tasks");
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
    await expect(page.getByTestId("planning-route-health")).toContainText("могут быть неполными");
    await expect(page.getByRole("button", { name: "Ещё" })).toHaveCount(0);
    await page.unroute("**/api/v1/planning/tasks**");

    let failUntilRetry = true;
    await page.route("**/api/v1/planning/tasks**", async (route) => {
      if (failUntilRetry) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
        return;
      }
      await route.continue();
    });
    await page.goto("/tasks");
    const retryButton = page.getByRole("button", { name: "Повторить" }).first();
    await expect(retryButton).toBeVisible();
    failUntilRetry = false;
    await retryButton.tap();
    await expect(page.getByTestId("planning-task-list")).toBeVisible();
  });

  test("Reminder contract failure keeps the fallback and Retry remains read-only", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/") && request.method() !== "GET") {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    await setRouteResponseState(page, "/api/v1/planning/reminders/view", 200, (payload) => {
      payload.sources = null;
    });
    await page.goto("/reminders");
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
    const retryButton = page.getByRole("button", { name: "Повторить" }).first();
    const failedRetryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/planning/reminders/view" && response.status() === 200;
    });
    await retryButton.tap();
    await failedRetryResponse;
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
    expect(writes).toEqual([]);

    await page.unroute("**/api/v1/planning/reminders/view*");
    const recoveredResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/planning/reminders/view" && response.status() === 200;
    });
    await retryButton.tap();
    await recoveredResponse;
    await expect(page.getByTestId("planning-reminder-list")).toBeVisible();
    expect(writes).toEqual([]);
  });

  test("503 with an empty bounded preview is not rendered as successful empty for any route", async ({ page }) => {
    for (const [domain, routePath, routeUrl] of [
      ["tasks", "/api/v1/planning/tasks", "/tasks"],
      ["calendar", "/api/v1/planning/events", "/calendar"],
      ["reminders", "/api/v1/planning/reminders/view", "/reminders"]
    ] as const) {
      await setEmptyPlanningPreview(page, domain);
      await setRouteResponseState(page, routePath, 503);
      await page.goto(routeUrl);
      if (domain === "calendar") {
        await expect(page.getByTestId("planning-route-health")).toContainText("Данные недоступны");
        await expect(page.getByTestId("planning-route-error")).toBeVisible();
        await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
        await expect(page.getByTestId("planning-route-preview-empty")).toContainText("Нет доступных объектов");
        await expect(page.getByTestId("planning-route-preview-empty")).toContainText("Повторите попытку");
        await expect(page.getByTestId("planning-route-empty")).toHaveCount(0);
        await expect(page.getByTestId("planning-route-preview-empty").getByRole("button", { name: "Повторить" })).toBeVisible();
      }
      await page.unroute(`**${routePath}*`);
      await page.unroute("**/api/v1/snapshot**");
    }
  });

  test("unavailable Calendar stays fatal while PlanningSheet retains focus", async ({ page }) => {
    await page.goto("/tasks");
    const opener = page.getByRole("button", { name: "Проект", exact: true });
    await opener.focus();
    await opener.press("Enter");
    const sheet = page.getByTestId("planning-project-sheet");
    await expect(sheet).toBeVisible();
    const activeInsideSheet = () => page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="planning-project-sheet"]');
      return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
    });
    expect(await activeInsideSheet()).toBeTruthy();
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      expect(await activeInsideSheet()).toBeTruthy();
    }
    await page.keyboard.press("Shift+Tab");
    expect(await activeInsideSheet()).toBeTruthy();
    await page.evaluate(() => document.querySelector<HTMLElement>('a[href="/calendar"]')?.focus());
    expect(await activeInsideSheet()).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Закрыть" }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("offline without a global cache stays an unavailable error, not an empty state", async ({ page }) => {
    await page.route("**/api/v1/snapshot**", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.planning = null;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await setRouteResponseState(page, "/api/v1/planning/tasks", 503);
    await page.goto("/tasks");
    await expect(page.getByTestId("planning-route-error")).toContainText("Данные недоступны");
    await expect(page.getByTestId("planning-route-empty")).toHaveCount(0);
  });

  test("captures canonical B3 review screenshots", async ({ page }, testInfo) => {
    const artifactDir = process.env.B3_ARTIFACT_DIR ?? testInfo.outputPath("b3-artifacts");
    await mkdir(artifactDir, { recursive: true });
    for (const [name, url] of [
      ["tasks-today", "/tasks?theme=day"],
      ["tasks-overdue", "/tasks?theme=day"],
      ["calendar-today", "/calendar?theme=day"],
      ["calendar-month", "/calendar?theme=day"],
      ["reminders-soon", "/reminders?theme=day"],
      ["reminders-delivery", "/reminders?theme=night"]
    ] as const) {
      await page.goto(url);
      if (name === "tasks-overdue") await page.locator(".planning-segmented").first().getByRole("button", { name: "Просрочено" }).tap();
      if (name === "reminders-delivery") await page.locator(".planning-segmented").getByRole("button", { name: "Доставка" }).tap();
      await page.screenshot({ path: path.join(artifactDir, `${name}.png`), animations: "disabled" });
    }
    await page.route("**/api/v1/planning/tasks**", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
    });
    await page.goto("/tasks?theme=night");
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
    await page.screenshot({ path: path.join(artifactDir, "tasks-offline-preview.png"), animations: "disabled" });
    await page.unroute("**/api/v1/planning/tasks**");
    await expectNoHorizontalOverflow(page);
  });

  test("renders long Russian and hostile-looking titles as inert text", async ({ page }) => {
    await setRouteResponseState(page, "/api/v1/planning/tasks", 200, (payload) => {
      const items = payload.items as Array<Record<string, unknown>>;
      items[0].title = "Подготовить очень длинную русскую задачу https://example.com light.turn_on /etc/passwd <script>alert(1)</script>";
    });
    await page.goto("/tasks?theme=day");
    await expect(page.getByTestId("planning-task-list")).toContainText("https://example.com");
    await expect(page.getByTestId("planning-task-list")).toContainText("<script>alert(1)</script>");
    await expect(page.getByTestId("planning-task-list").locator("script")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("keeps touch targets and essential text usable in day/night and reduced modes", async ({ page }) => {
    for (const theme of ["day", "night"] as const) {
      for (const motion of ["full", "reduced", "low-performance", "battery-saving"] as const) {
        await page.goto(`/tasks?theme=${theme}&motion=${motion}`);
        const targets = await page.locator(".planning-segmented button, .planning-secondary-button, .planning-route-row, .planning-pagination button").evaluateAll((elements) => elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }));
        expect(targets.every((target) => target.width >= 48 && target.height >= 48)).toBeTruthy();
        const smallText = await page.locator(".planning-route-page *").evaluateAll((elements) => elements.flatMap((element) => {
          const style = getComputedStyle(element);
          const text = element.textContent?.trim() ?? "";
          return text && style.display !== "none" && Number.parseFloat(style.fontSize) < 12 ? [text] : [];
        }));
        expect(smallText).toEqual([]);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
});
