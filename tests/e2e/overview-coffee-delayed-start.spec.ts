import { expect, test, type Page } from "@playwright/test";

const delayedStartPath = "/api/v1/actions/home/coffee/delayed-start";
const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

async function confirmCoffeeTurnOn(page: Page, target?: string | RegExp) {
  const confirmation = page.getByTestId("action-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Включить кофемашину?");
  if (target) await expect(confirmation).toContainText(target);
  await confirmation.getByRole("button", { name: "Включить кофемашину" }).tap();
  await expect(confirmation).toHaveCount(0);
}

function accessStatus(actionConfirmationRequired: boolean) {
  const profile = actionConfirmationRequired ? "standard" : "full";
  return {
    schemaVersion: 1,
    revision: 1,
    baseProfile: profile,
    effectiveProfile: profile,
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    confirmationPolicy: {
      actionConfirmationRequired,
      mode: actionConfirmationRequired ? "profile_default" : "manual_persistent_full"
    },
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {}
  };
}

async function mockAccessPolicy(page: Page, actionConfirmationRequired: boolean) {
  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(accessStatus(actionConfirmationRequired))
      });
      return;
    }
    await route.fallback();
  });
}

async function createPresetSchedule(page: Page, minutes = 5, requiresConfirmation = true) {
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await dialog.getByRole("button", { name: `+${minutes} мин` }).tap();
  if (requiresConfirmation) {
    await confirmCoffeeTurnOn(page, `Кофемашина · запуск через ${minutes} мин`);
  } else {
    await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  }
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toBeVisible();
}

function mutateCoffeeSnapshot(snapshot: Record<string, any>, state: "off" | "stale" | "unavailable") {
  const health = state === "off" ? "healthy" : state;
  return {
    ...snapshot,
    services: snapshot.services.map((service: Record<string, any>) => {
      if (service.id !== "coffee-machine") return service;
      const data = service.data as Record<string, any>;
      const machine = data.machine as Record<string, any>;
      return {
        ...service,
        health,
        summary: state === "off" ? "Выключена" : state === "stale" ? "Последнее состояние кофемашины устарело" : "Состояние кофемашины не подтверждено",
        actions: (service.actions as Array<Record<string, any>>).map((action) => ({
          ...action,
          enabled: state === "off" && action.id === "home.coffee.turn_on"
        })),
        data: {
          ...data,
          machine: {
            ...machine,
            state,
            available: state !== "unavailable",
            stale: state !== "off",
            turnedOnAt: null
          }
        }
      };
    })
  };
}

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
  await confirmCoffeeTurnOn(page, "Кофемашина · запуск через 5 мин");
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toContainText("Включится через");
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toContainText("в ");
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Изменить запуск");

  await page.reload();
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveText("Изменить запуск");
  await page.getByTestId("coffee-delayed-start-action").tap();
  await expect(page.getByTestId("coffee-delayed-start-active")).toContainText("Включится через");

  await dialog.getByRole("button", { name: "Отменить запуск" }).tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);

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
    await confirmCoffeeTurnOn(page, `Кофемашина · запуск через ${minutes} мин`);
    await expect.poll(() => submittedMinutes).toContain(minutes);
  }

  await dialog.getByRole("button", { name: "C" }).tap();
  await dialog.getByRole("button", { name: "Цифра 3" }).tap();
  await dialog.getByRole("button", { name: "Цифра 7" }).tap();
  await dialog.getByRole("button", { name: "Запланировать своё время" }).tap();
  await confirmCoffeeTurnOn(page, "Кофемашина · запуск через 37 мин");
  await expect.poll(() => submittedMinutes).toContain(37);

  const readback = await page.request.get(delayedStartPath);
  expect((await readback.json()).schedule.delayMinutes).toBe(37);
});

test("saving state prevents a fast duplicate preset submission", async ({ page }) => {
  let postCount = 0;
  let releaseResponse!: () => void;
  let savedPayload: Record<string, unknown> | null = null;
  const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route(`**${delayedStartPath}`, async (route) => {
    if (route.request().method() === "GET" && savedPayload) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(savedPayload)
      });
      return;
    }
    if (route.request().method() !== "POST") return route.continue();
    postCount += 1;
    await responseReleased;
    const body = route.request().postDataJSON() as { delayMinutes: number; requestId: string };
    const now = Date.now();
    savedPayload = {
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
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(savedPayload)
    });
  });

  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const preset = page.getByTestId("coffee-delayed-start-dialog").getByRole("button", { name: "+5 мин" });
  await preset.tap();
  await confirmCoffeeTurnOn(page, "Кофемашина · запуск через 5 мин");
  await expect(preset).toBeDisabled();
  await preset.dispatchEvent("click");
  expect(postCount).toBe(1);
  releaseResponse();
  await expect(page.getByTestId("coffee-delayed-start-active")).toBeVisible();
});

test("standard Coffee delayed start waits for the existing turn-on confirmation", async ({ page }) => {
  const delayedPosts: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(delayedStartPath)) delayedPosts.push(request.postDataJSON());
  });
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await dialog.getByRole("button", { name: "+5 мин" }).tap();
  await expect(page.getByTestId("action-confirmation")).toBeVisible();
  expect(delayedPosts).toHaveLength(0);
  await confirmCoffeeTurnOn(page, "Кофемашина · запуск через 5 мин");
  await expect.poll(() => delayedPosts).toHaveLength(1);
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toBeVisible();
});

test("cancelling the existing turn-on confirmation leaves the schedule unchanged", async ({ page }) => {
  let delayedPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(delayedStartPath)) delayedPostCount += 1;
  });
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  const seeded = await page.request.post(delayedStartPath, {
    data: { delayMinutes: 5, requestId: "replace-cancel-test" }
  });
  expect(seeded.ok()).toBeTruthy();
  await page.reload();
  const before = (await page.request.get(delayedStartPath).then((response) => response.json())).schedule;
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await dialog.getByRole("button", { name: "+10 мин" }).tap();
  await expect(page.getByTestId("action-confirmation")).toBeVisible();
  await page.getByTestId("action-confirmation").getByRole("button", { name: "Отмена" }).tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  expect(delayedPostCount).toBe(0);
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toBeVisible();
  expect((await page.request.get(delayedStartPath).then((response) => response.json())).schedule).toEqual(before);
});

test("current Full access waives the delayed turn-on confirmation", async ({ page }) => {
  let delayedPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(delayedStartPath)) delayedPostCount += 1;
  });
  await mockAccessPolicy(page, false);
  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  await page.getByTestId("coffee-delayed-start-dialog").getByRole("button", { name: "+5 мин" }).tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  await expect.poll(() => delayedPostCount).toBe(1);
});

test("fast repeated delayed taps create one confirmation and one POST", async ({ page }) => {
  let delayedPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(delayedStartPath)) delayedPostCount += 1;
  });
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  const preset = dialog.getByRole("button", { name: "+5 мин" });
  await preset.tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(1);
  await preset.dispatchEvent("click");
  await expect(page.getByTestId("action-confirmation")).toHaveCount(1);
  expect(delayedPostCount).toBe(0);
  await confirmCoffeeTurnOn(page, "Кофемашина · запуск через 5 мин");
  await expect.poll(() => delayedPostCount).toBe(1);
});

test("cancelling a pending schedule does not open turn-on confirmation", async ({ page }) => {
  let delayedDeleteCount = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes(delayedStartPath)) delayedDeleteCount += 1;
  });
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  await createPresetSchedule(page);
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await dialog.getByRole("button", { name: "Отменить запуск" }).tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  await expect.poll(() => delayedDeleteCount).toBe(1);
});

test("pending schedule remains manageable while Coffee state is stale", async ({ page }) => {
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  await createPresetSchedule(page);
  await page.goto("/overview?scenario=home-ha-stale");
  const coffee = page.getByTestId("widget-coffee-machine");
  await expect(coffee).toHaveAttribute("data-stage", "stale");
  await expect(coffee).toContainText("Запуск запланирован");
  await expect(coffee).toContainText("в ");
  await expect(coffee).not.toContainText("Выключена");
  await expect(coffee.getByTestId("coffee-delayed-start-action")).toHaveText("Изменить запуск");

  await coffee.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await expect(dialog.getByTestId("coffee-delayed-start-active")).toContainText("в ");
  for (const label of ["+5 мин", "+10 мин", "+15 мин"]) {
    await expect(dialog.getByRole("button", { name: label })).toBeDisabled();
  }
  await expect(dialog.locator(".coffee-delay-dialog__key").first()).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Запланировать своё время" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Отменить запуск" })).toBeEnabled();
  await expect(dialog).toContainText("новый запуск — после восстановления");
});

test("stale schedule can be cancelled without a physical Coffee action", async ({ page }) => {
  let coffeeActionPosts = 0;
  let delayedDeleteCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/actions/home/coffee")) coffeeActionPosts += 1;
    if (request.method() === "DELETE" && request.url().includes(delayedStartPath)) delayedDeleteCount += 1;
  });
  await mockAccessPolicy(page, true);
  await page.goto("/overview?scenario=coffee-off");
  await createPresetSchedule(page);
  await page.goto("/overview?scenario=home-ha-stale");
  await page.getByTestId("coffee-delayed-start-action").tap();
  await page.getByTestId("coffee-delayed-start-dialog").getByRole("button", { name: "Отменить запуск" }).tap();
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  await expect.poll(() => delayedDeleteCount).toBe(1);
  expect(coffeeActionPosts).toBe(0);
  await page.reload();
  await expect(page.getByTestId("coffee-delayed-start-action")).toHaveCount(0);
});

test("replacement controls recover automatically when authoritative OFF returns", async ({ page }) => {
  let degraded = false;
  await mockAccessPolicy(page, true);
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as Record<string, any>;
    const next = degraded ? mutateCoffeeSnapshot(snapshot, "stale") : mutateCoffeeSnapshot(snapshot, "off");
    await route.fulfill({ response, body: JSON.stringify(next), headers: { ...response.headers(), "content-type": "application/json" } });
  });
  await page.route(`**${delayedStartPath}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const payload = await response.json() as Record<string, any>;
    if (degraded) payload.available = false;
    await route.fulfill({ response, body: JSON.stringify(payload), headers: { ...response.headers(), "content-type": "application/json" } });
  });
  await page.goto("/overview?scenario=coffee-off");
  await createPresetSchedule(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("coffee-delayed-start-dialog")).toHaveCount(0);

  degraded = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "stale");
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await expect(dialog.getByRole("button", { name: "+5 мин" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  degraded = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "off");
  await page.getByTestId("coffee-delayed-start-action").tap();
  await expect(page.getByTestId("coffee-delayed-start-dialog").getByRole("button", { name: "+5 мин" })).toBeEnabled();
});

test("executing schedule is visible but not cancellable or replaceable", async ({ page }) => {
  let forceExecuting = false;
  await mockAccessPolicy(page, false);
  await page.route(`**${delayedStartPath}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const payload = await response.json() as Record<string, any>;
    if (forceExecuting && payload.schedule) payload.schedule = { ...payload.schedule, status: "executing" };
    await route.fulfill({ response, body: JSON.stringify(payload), headers: { ...response.headers(), "content-type": "application/json" } });
  });
  await page.goto("/overview?scenario=coffee-off");
  await createPresetSchedule(page, 5, false);
  forceExecuting = true;
  await page.reload();
  await page.getByTestId("coffee-delayed-start-action").tap();
  const dialog = page.getByTestId("coffee-delayed-start-dialog");
  await expect(dialog).toContainText("Запуск выполняется");
  await expect(dialog.getByRole("button", { name: "Отменить запуск" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "+5 мин" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Запланировать своё время" })).toBeDisabled();
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
