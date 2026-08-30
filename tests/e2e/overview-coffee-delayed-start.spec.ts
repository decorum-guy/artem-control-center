import { expect, test } from "@playwright/test";

const delayedStartPath = "/api/v1/actions/home/coffee/delayed-start";
const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.request.delete(delayedStartPath);
});

test("confirmed OFF Coffee shows immediate and delayed actions", async ({ page }) => {
  await page.goto("/overview?scenario=coffee-off");
  const coffee = page.getByTestId("widget-coffee-machine");
  await expect(coffee).toBeVisible();
  await expect(coffee.getByRole("button", { name: "Включить" })).toBeVisible();
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Отложить");
});

test("preset schedule survives reload, exposes authoritative countdown, and cancels", async ({ page }) => {
  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();

  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "+5 мин" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "+10 мин" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "+15 мин" })).toBeEnabled();
  await expect(dialog.locator(".coffee-delay-dialog__key")).toHaveCount(12);
  await expect(dialog.locator(".coffee-delay-dialog__key").first()).toHaveCSS("min-height", "52px");

  await dialog.getByRole("button", { name: "+5 мин" }).tap();
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toContainText("Включится через");
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toContainText("в ");
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Изменить запуск");

  await page.reload();
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Изменить запуск");
  await page.getByTestId("coffee-delayed-start-action").tap();
  await expect(page.getByTestId("coffee-delayed-start-active")).toContainText("Включится через");

  const cancelled = await page.request.delete(delayedStartPath);
  expect(cancelled.ok()).toBeTruthy();
  expect((await cancelled.json()).schedule.status).toBe("cancelled");

  await page.reload();
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Отложить");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(overflow).toBe(true);
});

test("presets and custom minutes submit only bounded typed Coffee data", async ({ page }) => {
  const submittedMinutes: number[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes(delayedStartPath)) return;
    const body = request.postDataJSON() as { delayMinutes?: unknown };
    if (typeof body.delayMinutes === "number") submittedMinutes.push(body.delayMinutes);
  });

  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  for (const [label, minutes] of [["+5 мин", 5], ["+10 мин", 10], ["+15 мин", 15]] as const) {
    await dialog.getByRole("button", { name: label }).tap();
    await expect.poll(() => submittedMinutes).toContain(minutes);
  }

  await dialog.getByRole("button", { name: "C" }).tap();
  await dialog.getByRole("button", { name: "Цифра 3" }).tap();
  await dialog.getByRole("button", { name: "Цифра 7" }).tap();
  await dialog.getByRole("button", { name: "Запланировать своё время" }).tap();
  await expect.poll(() => submittedMinutes).toContain(37);

  const readback = await page.request.get(delayedStartPath);
  expect((await readback.json()).schedule.delayMinutes).toBe(37);
});

test("saving state prevents a fast duplicate preset submission", async ({ page }) => {
  let postCount = 0;
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route(`**${delayedStartPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postCount += 1;
    await responseReleased;
    const body = route.request().postDataJSON() as { delayMinutes: number; requestId: string };
    const now = Date.now();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        available: true,
        writesEnabled: true,
        schedule: {
          schemaVersion: "coffee.delayed-start.v1",
          scheduleId: "e2e-saving-schedule",
          requestId: body.requestId,
          delayMinutes: body.delayMinutes,
          status: "pending",
          dueAt: new Date(now + body.delayMinutes * 60_000).toISOString(),
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          failureCode: null
        }
      })
    });
  });

  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const preset = page.getByTestId("coffee-delayed-start-dialog").getByRole("button", { name: "+5 мин" });
  await preset.tap();
  await expect(preset).toBeDisabled();
  await preset.dispatchEvent("click");
  expect(postCount).toBe(1);
  releaseResponse();
  await expect(page.getByTestId("coffee-delayed-start-active")).toBeVisible();
});

test("Coffee action-row enum stays touch-safe across all supported widget sizes", async ({ page }) => {
  test.skip(!overviewV2Enabled, "Run with the Overview V2 flag enabled.");
  const initialResponse = await page.request.get("/api/v1/overview/layout");
  const initial = await initialResponse.json() as {
    schemaVersion: string;
    profileId: string;
    presetId: string;
    presetVersion: number;
    revision: number;
    viewportClass: string;
    updatedAt: string;
    items: Array<Record<string, unknown>>;
    warnings: string[];
    unplaced: unknown[];
    writesEnabled: boolean;
  };
  let layout = initial;
  await page.route("**/api/v1/overview/layout*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store", etag: `"${layout.revision}"`, "x-overview-layout-writes-enabled": "true" },
      body: JSON.stringify(layout)
    });
  });

  for (const buttonLayout of ["compact", "balanced", "wide"] as const) {
    for (const sizeVariant of ["compact", "standard", "large"] as const) {
      layout = {
        ...initial,
        items: initial.items.map((item) => {
          if (item.instanceId === "fixture.coffee") {
            const placement = sizeVariant === "compact"
              ? { x: 0, y: 1, w: 4, h: 3 }
              : sizeVariant === "large"
                ? { x: 0, y: 1, w: 8, h: 5 }
                : { x: 0, y: 1, w: 7, h: 4 };
            return { ...item, sizeVariant, placement, config: { ...(item.config as Record<string, unknown>), buttonLayout } };
          }
          if (item.instanceId === "fixture.planning") {
            return {
              ...item,
              sizeVariant: sizeVariant === "large" ? "compact" : "standard",
              placement: sizeVariant === "compact"
                ? { x: 4, y: 1, w: 8, h: 3 }
                : sizeVariant === "large"
                  ? { x: 8, y: 1, w: 4, h: 3 }
                  : { x: 7, y: 1, w: 5, h: 4 }
            };
          }
          if (item.instanceId === "fixture.quick-actions") {
            return { ...item, placement: sizeVariant === "large" ? { x: 0, y: 6, w: 7, h: 2 } : { x: 0, y: 5, w: 7, h: 2 } };
          }
          if (item.instanceId === "fixture.health") {
            return { ...item, placement: sizeVariant === "large" ? { x: 7, y: 6, w: 5, h: 2 } : { x: 7, y: 5, w: 5, h: 2 } };
          }
          return item;
        })
      };

      await page.goto("/overview?scenario=coffee-off");
      const coffee = page.getByTestId("widget-coffee-machine");
      await expect(coffee).toHaveAttribute("data-overview-size-variant", sizeVariant);
      await expect(coffee.locator(".coffee-action-row")).toHaveAttribute("data-button-layout", buttonLayout);
      const metrics = await coffee.evaluate((element) => {
        const panel = element as HTMLElement;
        const row = element.querySelector<HTMLElement>(".coffee-action-row")!;
        const buttons = Array.from(row.querySelectorAll("button"));
        const panelRect = panel.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return {
          targets: buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
          }),
          rowInsidePanel: rowRect.left >= panelRect.left && rowRect.right <= panelRect.right && rowRect.bottom <= panelRect.bottom,
          rootOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        };
      });
      expect(metrics.targets.every((target) => target.width >= 48 && target.height >= 48)).toBe(true);
      expect(metrics.rowInsidePanel).toBe(true);
      expect(metrics.rootOverflow).toBe(true);
    }
  }
});
