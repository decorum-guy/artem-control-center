import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewLayoutWritesEnabled = process.env.PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED === "true";

type RogStatus = "online" | "offline" | "waking" | "sleeping" | "hibernating" | "unavailable";
type RogAction = "system.rog_g703.wake" | "system.rog_g703.sleep" | "system.rog_g703.hibernate";
type ConnectivityFixture = "available" | "pending" | "unavailable";
type HomeFixture = "one" | "two";
type CoffeeFixtureOverride = "off" | "turning-on" | "warming" | "warming-early" | "warming-mid" | "warming-late" | null;

let rogStatus: RogStatus = "online";
let longRussian = false;
let homeFixture: HomeFixture = "one";
let coffeeFixtureOverride: CoffeeFixtureOverride = null;
let coffeeTimingUnavailable = false;
const postedActions: Array<{ actionId?: string }> = [];

function rogService(status: RogStatus) {
  return {
    id: "rog_g703gi",
    title: "ASUS ROG G703GI",
    enabled: true,
    dataContract: "system.rog-g703.v1",
    health: status === "unavailable" ? "offline" : "healthy",
    source: "live",
    summary: "ASUS companion state",
    actions: [
      { id: "system.rog_g703.wake", title: "Включить", enabled: status === "offline", risk: "low" },
      { id: "system.rog_g703.sleep", title: "Сон", enabled: status === "online", risk: "medium" },
      { id: "system.rog_g703.hibernate", title: "Гибернация", enabled: status === "online", risk: "medium" }
    ],
    presentation: {
      category: "system",
      group: "System",
      overview: "aggregate",
      priority: 95,
      freshnessLabel: "проверено только что"
    },
    data: {
      targetId: "rog_g703gi",
      status,
      observedAt: "2026-08-14T12:00:00Z",
      lastTransitionAt: "2026-08-14T11:59:00Z",
      lastError: null
    }
  };
}

function decision(actionId: RogAction, status: RogStatus) {
  const allowed = (actionId.endsWith("wake") && status === "offline") ||
    (!actionId.endsWith("wake") && status === "online");
  return {
    availability: allowed ? "allowed" : "not_allowed",
    allowed,
    reason: allowed ? null : "action_not_available_for_current_state",
    requiresConfirmation: !actionId.endsWith("wake"),
    capability: "system.rog_g703",
    cooldownUntil: null,
    targetId: "rog_g703gi",
    status
  };
}

async function installCuratedMocks(page: Page) {
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as {
      services: Array<Record<string, unknown>>;
      planning?: { reminders: { upcoming: Array<Record<string, unknown>> }; tasks: { overdue: Array<Record<string, unknown>> }; calendar: { today: Array<Record<string, unknown>> } } | null;
    };
    snapshot.services = [
      ...snapshot.services.filter((service) => service.id !== "rog_g703gi"),
      rogService(rogStatus)
    ];
    if (homeFixture === "two") {
      const kettle = snapshot.services.find((service) => service.id === "kettle");
      if (kettle) {
        snapshot.services.push({
          ...kettle,
          id: "fixture-desk-lamp",
          title: "Рабочая лампа",
          data: {
            ...(kettle.data as Record<string, unknown>),
            stage: "on"
          },
          presentation: {
            ...(kettle.presentation as Record<string, unknown>),
            priority: 79,
            overview: "quick-control"
          }
        });
      }
    }
    if (longRussian && snapshot.planning) {
      const longTitle = "Очень длинное русское название операционного напоминания, которое должно корректно переноситься";
      snapshot.planning.reminders.upcoming = snapshot.planning.reminders.upcoming.map((item) => ({ ...item, title: longTitle }));
      snapshot.planning.tasks.overdue = snapshot.planning.tasks.overdue.map((item) => ({ ...item, title: longTitle }));
      snapshot.planning.calendar.today = snapshot.planning.calendar.today.map((item) => ({ ...item, title: longTitle }));
    }
    if (coffeeFixtureOverride) {
      const coffee = snapshot.services.find((service) => service.id === "coffee-machine");
      const coffeeData = coffee?.data as { machine?: Record<string, unknown>; timingPolicy?: Record<string, unknown> } | undefined;
      if (coffee && coffeeData?.machine) {
        const warmingAt = {
          warming: "2026-07-29T11:54:09Z",
          "warming-early": "2026-07-29T11:58:42Z",
          "warming-mid": "2026-07-29T11:53:30Z",
          "warming-late": "2026-07-29T11:48:18Z"
        } as const;
        const isTurningOn = coffeeFixtureOverride === "turning-on";
        const isWarming = coffeeFixtureOverride !== "off" && !isTurningOn;
        coffeeData.machine.state = isTurningOn ? "turning_on" : isWarming ? "on" : "off";
        coffeeData.machine.available = true;
        coffeeData.machine.stale = false;
        const warmingFixture = isWarming ? coffeeFixtureOverride : null;
        coffeeData.machine.turnedOnAt = warmingFixture ? warmingAt[warmingFixture] : null;
      }
    }
    if (coffeeTimingUnavailable) {
      const coffee = snapshot.services.find((service) => service.id === "coffee-machine");
      const coffeeData = coffee?.data as { machine?: Record<string, unknown>; timingPolicy?: Record<string, unknown> } | undefined;
      if (coffeeData?.machine && coffeeData.timingPolicy) {
        coffeeData.machine.state = "on";
        coffeeData.machine.available = true;
        coffeeData.machine.stale = false;
        coffeeData.machine.turnedOnAt = "2026-07-29T11:54:09Z";
        coffeeData.timingPolicy.warmupDurationSeconds = null;
        coffeeData.timingPolicy.longRunningThresholdSeconds = null;
        coffeeData.timingPolicy.sourceAvailable = true;
        coffeeData.timingPolicy.stale = false;
      }
    }
    await route.fulfill({
      response,
      body: JSON.stringify(snapshot),
      headers: { ...response.headers(), "content-type": "application/json" }
    });
  });

}

async function installConnectivityMock(page: Page, fixture: ConnectivityFixture) {
  await page.route(/\/api\/v1\/actions\/system\/connectivity(?:\/|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (fixture === "unavailable") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "not_found" })
      });
      return;
    }
    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          action: {
            capability: "system.connectivity.restart",
            minimumProfile: "standard",
            effectiveProfile: "standard",
            allowed: true,
            availability: "allowed",
            activeCorrelationId: null
          }
        })
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          correlationId: "curated-connectivity",
          actionId: "system.connectivity.restart",
          status: "requested",
          requestedAt: "2026-08-14T12:00:00Z",
          updatedAt: "2026-08-14T12:00:00Z",
          finishedAt: null,
          result: null,
          error: null
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        correlationId: "curated-connectivity",
        actionId: "system.connectivity.restart",
        status: "restarting",
        requestedAt: "2026-08-14T12:00:00Z",
        updatedAt: "2026-08-14T12:00:00Z",
        finishedAt: null,
        result: null,
        error: null
      })
    });
  });
}

async function setConnectivityFixture(page: Page, fixture: ConnectivityFixture) {
  await installConnectivityMock(page, fixture);
}

async function installRogMocks(page: Page) {
  await page.route("**/api/v1/actions/system/rog-g703/availability", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        targetId: "rog_g703gi",
        status: rogService(rogStatus).data,
        actions: {
          "system.rog_g703.wake": decision("system.rog_g703.wake", rogStatus),
          "system.rog_g703.sleep": decision("system.rog_g703.sleep", rogStatus),
          "system.rog_g703.hibernate": decision("system.rog_g703.hibernate", rogStatus)
        }
      })
    });
  });

  await page.route("**/api/v1/actions/system/rog-g703", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { actionId?: string };
    postedActions.push(body);
    const actionId = body.actionId as RogAction;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        correlationId: `curated-${postedActions.length}`,
        targetId: "rog_g703gi",
        actionId,
        status: actionId.endsWith("wake") ? "waking" : actionId.endsWith("sleep") ? "sleeping" : "hibernating",
        requestedAt: "2026-08-14T12:00:00Z",
        updatedAt: "2026-08-14T12:00:00Z",
        finishedAt: null,
        result: null,
        error: null
      })
    });
  });

  await page.route("**/api/v1/actions/system/rog-g703/curated-*", async (route) => {
    const actionId = postedActions.at(-1)?.actionId ?? "system.rog_g703.wake";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        correlationId: `curated-${postedActions.length}`,
        targetId: "rog_g703gi",
        actionId,
        status: actionId.endsWith("wake") ? "online" : "offline",
        requestedAt: "2026-08-14T12:00:00Z",
        updatedAt: "2026-08-14T12:01:00Z",
        finishedAt: "2026-08-14T12:01:00Z",
        result: actionId.endsWith("wake") ? { onlineConfirmed: true } : { offlineConfirmed: true },
        error: null
      })
    });
  });
}

async function waitForOverview(page: Page) {
  await expect(page.getByTestId("route-overview-v2")).toBeVisible();
  await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", /.+/);
}

async function expectNoOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
}

function item(page: Page, instanceId: string) {
  return page.locator(`.overview-v2-grid-item[data-instance-id="${instanceId}"]`);
}

async function expectHealthGeometry(page: Page) {
  const box = await item(page, "fixture.health").boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeCloseTo(824, 0);
  expect(box?.y).toBeCloseTo(496, 0);
  expect(box?.width).toBeCloseTo(436, 0);
  expect(box?.height).toBeCloseTo(132, 0);
}

test.describe("PR4 curated Overview", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!overviewV2Enabled || !visualShellEnabled, "Run with both PR4 flags enabled.");
    rogStatus = "online";
    longRussian = false;
    homeFixture = "one";
    coffeeFixtureOverride = null;
    coffeeTimingUnavailable = false;
    postedActions.length = 0;
    await installCuratedMocks(page);
    await installRogMocks(page);
  });

  test("renders the exact canonical toolbar and curated first viewport geometry", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);

    const expected = [
      ["overview-toolbar", 196, 76, 1064, 48],
      ["fixture.rog", 196, 136, 1064, 60],
      ["fixture.coffee", 196, 208, 616, 276],
      ["fixture.planning", 824, 208, 436, 276],
      ["fixture.quick-actions", 196, 496, 616, 132],
      ["fixture.health", 824, 496, 436, 132]
    ] as const;

    for (const [testId, x, y, width, height] of expected) {
      const box = await (testId === "overview-toolbar"
        ? page.getByTestId(testId)
        : item(page, testId)).boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x).toBeCloseTo(x, 0);
      expect(box?.y).toBeCloseTo(y, 0);
      expect(box?.width).toBeCloseTo(width, 0);
      expect(box?.height).toBeCloseTo(height, 0);
    }

    const rog = page.getByTestId("overview-rog-g703");
    await expect(rog).not.toContainText("Система · Windows");
    const rogBox = await rog.boundingBox();
    const rogIdentity = await rog.locator(".overview-rog-widget__identity h2").boundingBox();
    const rogStatus = await rog.locator(".overview-rog-widget__status").boundingBox();
    const rogFreshness = await rog.locator(".overview-rog-widget__freshness").boundingBox();
    const rogSleep = await rog.getByTestId("overview-rog-g703-sleep").boundingBox();
    const rogHibernate = await rog.getByTestId("overview-rog-g703-hibernate").boundingBox();
    const coffeeDelayedAction = page.getByTestId("widget-coffee-machine").getByTestId("coffee-delayed-start-action");
    expect(rogBox).not.toBeNull();
    for (const child of [rogIdentity, rogStatus, rogFreshness]) {
      expect(child).not.toBeNull();
      expect(child?.y).toBeGreaterThanOrEqual((rogBox?.y ?? 0) - 1);
      expect((child?.y ?? 0) + (child?.height ?? 0)).toBeLessThanOrEqual((rogBox?.y ?? 0) + (rogBox?.height ?? 0) + 1);
    }
    expect(rogIdentity?.height).toBeLessThanOrEqual(20);
    expect(rogStatus?.height).toBeLessThanOrEqual(20);
    expect(rogFreshness?.height).toBeLessThanOrEqual(18);
    expect(rogSleep?.height).toBeGreaterThanOrEqual(48);
    expect(rogHibernate?.height).toBeGreaterThanOrEqual(48);

    if (overviewLayoutWritesEnabled) {
      await expect(page.getByTestId("overview-configure")).toBeEnabled();
    } else {
      await expect(page.getByTestId("overview-configure")).toBeDisabled();
    }
    for (const control of [
      page.getByTestId("overview-configure"),
      rog.getByTestId("overview-rog-g703-sleep"),
      rog.getByTestId("overview-rog-g703-hibernate"),
      page.getByTestId("widget-coffee-machine").locator("[data-coffee-action]"),
      coffeeDelayedAction,
      page.getByTestId("overview-home-device-kettle"),
      page.getByTestId("planning-overview-card").locator(".planning-row").first()
    ]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(48);
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }
    await expect(page.getByTestId("connectivity-recovery-surface")).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("keeps the ROG action contextual and preserves the exact action payload", async ({ page }) => {
    rogStatus = "offline";
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const rog = page.getByTestId("overview-rog-g703");
    const actionRegion = rog.locator(".overview-rog-widget__action");
    const wake = page.getByTestId("overview-rog-g703-wake");
    await expect(rog).toContainText("Не в сети");
    await expect(wake).toHaveText("Включить");
    const [actionRegionBox, wakeBox] = await Promise.all([
      actionRegion.boundingBox(),
      wake.boundingBox()
    ]);
    expect(actionRegionBox).not.toBeNull();
    expect(wakeBox).not.toBeNull();
    expect((wakeBox?.x ?? 0) + (wakeBox?.width ?? 0)).toBeCloseTo(
      (actionRegionBox?.x ?? 0) + (actionRegionBox?.width ?? 0),
      0
    );
    expect(wakeBox?.height).toBeGreaterThanOrEqual(48);
    await wake.click();
    await expect.poll(() => postedActions.length).toBe(1);
    expect(postedActions).toEqual([{ actionId: "system.rog_g703.wake" }]);
    await expect(page.getByTestId("overview-rog-g703")).toContainText("В сети");
    await expectNoOverflow(page);
  });

  test.describe("ROG state projection", () => {
    const states: Array<[RogStatus, string, string | null]> = [
      ["online", "В сети", "Сон"],
      ["offline", "Не в сети", "Включить"],
      ["waking", "Пробуждение", null],
      ["sleeping", "Сон", "Сон"],
      ["hibernating", "Гибернация", "Гибернация"],
      ["unavailable", "Недоступен", null]
    ];

    for (const [state, label, action] of states) {
      test(`renders ${state} without a guessed opposite action`, async ({ page }) => {
        rogStatus = state;
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto("/overview?theme=night");
        await waitForOverview(page);
        await expect(page.getByTestId("overview-rog-g703")).toContainText(label);
        if (action) {
          if (state === "online") {
            await expect(page.getByTestId("overview-rog-g703-sleep")).toContainText("Сон");
            await expect(page.getByTestId("overview-rog-g703-hibernate")).toContainText("Гибернация");
          } else {
            const actionButton = state === "offline"
              ? page.getByTestId("overview-rog-g703-wake")
              : page.getByTestId(state === "sleeping" ? "overview-rog-g703-sleep" : "overview-rog-g703-hibernate");
            await expect(actionButton).toContainText(action);
          }
          await expect(page.locator(".overview-rog-widget__action button")).toHaveCount(state === "online" || state === "sleeping" || state === "hibernating" ? 2 : 1);
          if (state === "online") await expect(page.getByTestId("overview-rog-g703-wake")).toHaveCount(0);
          if (state === "offline") await expect(page.getByTestId("overview-rog-g703-hibernate")).toHaveCount(0);
        } else {
          if (state === "waking") {
            await expect(page.getByTestId("overview-rog-g703-wake")).toBeDisabled();
          } else {
            await expect(page.getByTestId("overview-rog-g703-unavailable")).toContainText("Недоступен");
            await expect(page.getByTestId("overview-rog-g703-wake")).toHaveCount(0);
          }
        }
        await expectNoOverflow(page);
      });
    }
  });

  test("uses the same ROG controller semantics on Overview and System", async ({ page }) => {
    rogStatus = "offline";
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("overview-rog-g703-wake")).toHaveText("Включить");
    await page.goto("/system?theme=night");
    if (visualShellEnabled) {
      await expect(page.getByTestId("system-rog-g703")).toBeVisible();
      await expect(page.getByTestId("system-rog-g703")).toContainText("Не в сети");
      await expect(page.getByTestId("system-rog-wake")).toHaveText("Включить");
    } else {
      await expect(page.getByTestId("rog-g703-controls")).toBeVisible();
      await expect(page.getByTestId("rog-g703-controls")).toContainText("Не в сети");
      await expect(page.getByTestId("rog-g703-wake")).toBeEnabled();
      await expect(page.getByTestId("rog-g703-sleep")).toHaveCount(0);
      await expect(page.getByTestId("rog-g703-hibernate")).toHaveCount(0);
    }
  });

  test("keeps connectivity recovery inside health without changing grid geometry", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=ha-degraded&theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("connectivity-recovery-surface")).toHaveCount(0);
    await expect(page.getByTestId("overview-health-widget")).toContainText("требуют внимания");
    await expectHealthGeometry(page);
    await expect(page.getByTestId("overview-health-recovery-unavailable")).toHaveText("Восстановление недоступно");
    await expectNoOverflow(page);
  });

  test("localizes Health incidents and keeps each recovery state in one fixed slot", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    await setConnectivityFixture(page, "available");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("overview-health-widget")).toContainText("Home Assistant: Недоступен");
    await expect(page.getByTestId("overview-health-widget")).not.toContainText("Connected with stale dependency data");
    const available = page.getByTestId("overview-health-recovery");
    await expect(available).toHaveText("Восстановить");
    await expect(available).toBeEnabled();
    const availableBox = await available.boundingBox();
    expect(availableBox?.height).toBeGreaterThanOrEqual(48);
    await expectHealthGeometry(page);

    await setConnectivityFixture(page, "pending");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await waitForOverview(page);
    const pending = page.getByTestId("overview-health-recovery");
    await pending.click();
    await expect(pending).toHaveText("Проверяем…");
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    const pendingBox = await pending.boundingBox();
    expect(pendingBox).toMatchObject({
      x: availableBox?.x,
      y: availableBox?.y,
      width: availableBox?.width,
      height: availableBox?.height
    });
    await expectHealthGeometry(page);

    await setConnectivityFixture(page, "unavailable");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await waitForOverview(page);
    const unavailable = page.getByTestId("overview-health-recovery-unavailable");
    const unavailableSlot = page.getByTestId("overview-health-recovery-slot");
    await expect(unavailable).toHaveText("Восстановление недоступно");
    await expect(unavailableSlot.locator("button")).toHaveCount(0);
    const [unavailableBox, unavailableSlotBox, unavailableLayout] = await Promise.all([
      unavailable.boundingBox(),
      unavailableSlot.boundingBox(),
      unavailable.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    ]);
    expect(unavailableBox).not.toBeNull();
    expect(unavailableSlotBox).not.toBeNull();
    expect(unavailableBox?.x).toBeGreaterThanOrEqual((unavailableSlotBox?.x ?? 0) - 1);
    expect((unavailableBox?.x ?? 0) + (unavailableBox?.width ?? 0)).toBeLessThanOrEqual((unavailableSlotBox?.x ?? 0) + (unavailableSlotBox?.width ?? 0) + 1);
    expect(unavailableLayout.scrollWidth).toBeLessThanOrEqual(unavailableLayout.clientWidth + 1);
    await expectHealthGeometry(page);
    await expectNoOverflow(page);
  });

  test("keeps Planning child labels and metadata readable in the canonical shell", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);

    for (const route of ["/calendar", "/tasks", "/reminders"]) {
      const link = page.locator(`[data-nav-route="${route}"]`);
      await expect(link).toHaveAttribute("class", /v2-nav-link--child/);
      await expect(link).toHaveCSS("min-height", "48px");
      const label = link.locator(":scope > span");
      await expect(label).toHaveCSS("white-space", "nowrap");
      const layout = await label.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }));
      expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);
    }

    const metadata = page.getByTestId("planning-overview-card").locator(".planning-row__meta").first();
    await expect(metadata).toHaveCSS("font-size", "13px");
    await expect(metadata).toHaveCSS("line-height", "18px");
  });

  test("spans one truthful Home device and preserves the two-device projection", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const oneCells = page.getByTestId("overview-home-cells");
    const oneCell = page.getByTestId("overview-home-device-kettle");
    const oneCellsBox = await oneCells.boundingBox();
    const oneCellBox = await oneCell.boundingBox();
    expect(await oneCells.getAttribute("data-device-count")).toBe("1");
    expect(oneCellBox?.width).toBeCloseTo(oneCellsBox?.width ?? 0, 0);
    await expect(page.getByTestId("overview-home-device-fixture-desk-lamp")).toHaveCount(0);

    homeFixture = "two";
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("overview-home-cells")).toHaveAttribute("data-device-count", "2");
    await expect(page.getByTestId("overview-home-device-kettle")).toBeVisible();
    await expect(page.getByTestId("overview-home-device-fixture-desk-lamp")).toBeVisible();
    const twoCellsBox = await page.getByTestId("overview-home-cells").boundingBox();
    const twoCellBox = await page.getByTestId("overview-home-device-kettle").boundingBox();
    expect(twoCellBox?.width).toBeLessThan((twoCellsBox?.width ?? 0) - 8);
    await expectNoOverflow(page);
  });

  test("keeps long Russian Planning text collision-free", async ({ page }) => {
    longRussian = true;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const titles = page.getByTestId("planning-overview-card").locator(".planning-row__title");
    for (let index = 0; index < await titles.count(); index += 1) {
      const title = titles.nth(index);
      const layout = await title.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflow: getComputedStyle(element).overflow,
        lineClamp: getComputedStyle(element).webkitLineClamp
      }));
      expect(layout.clientHeight).toBeLessThanOrEqual(36);
      expect(layout.overflow).toBe("hidden");
      expect(layout.lineClamp).toBe("2");
    }
    await expectNoOverflow(page);
  });

  test("uses the real snapshot presentation for Coffee states and Planning/Home/health", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    for (const [scenario, stage] of [
      ["coffee-off", "off"],
      ["coffee-warming", "warming"],
      ["coffee-ready", "ready"],
      ["coffee-stale", "stale"],
      ["ha-offline-policy-available", "unavailable"]
    ] as const) {
      await page.goto(`/overview?scenario=${scenario}&theme=night`);
      await waitForOverview(page);
      await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", stage);
    }

    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const planning = page.getByTestId("planning-overview-card");
    await expect(planning).toHaveAttribute("data-visible-item-count", "3");
    await expect(planning.locator(".planning-row")).toHaveCount(3);
    await expect(page.getByTestId("overview-home-device-kettle")).toContainText("Чайник");
    await expect(page.getByTestId("overview-health-widget")).toContainText("требуют внимания");
    await expectNoOverflow(page);
  });

  test("keeps Coffee authority and optimized imagery bounded on the zone surface", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const coffee = page.getByTestId("widget-coffee-machine");
    const image = coffee.locator(".coffee-asset__image");
    const asset = coffee.locator(".coffee-asset");
    const online = coffee.locator(".coffee-panel__status .health-mark");
    const spaciousImageBox = await image.boundingBox();
    const onlineBox = await online.boundingBox();
    const coffeeBox = await coffee.boundingBox();
    expect(await coffee.getAttribute("data-overview-copy-density")).toBe("spacious");
    expect(spaciousImageBox?.width).toBeGreaterThan(136);
    expect(spaciousImageBox?.width).toBeLessThanOrEqual(164);
    expect(spaciousImageBox?.height).toBeLessThanOrEqual(240);
    expect(await online).toContainText("Онлайн");
    expect(await online).not.toContainText("Работает");
    expect(onlineBox!.y).toBeGreaterThanOrEqual(coffeeBox!.y);
    expect(onlineBox!.x + onlineBox!.width).toBeLessThanOrEqual(coffeeBox!.x + coffeeBox!.width);
    await expect(coffee.locator(".coffee-state-marker")).toHaveCount(0);
    await expect(coffee).toContainText("Источник: Home Assistant");
    await expect(asset).toHaveCSS("border-left-width", "0px");
    expect(await asset.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

    await page.goto("/overview?scenario=coffee-warming&theme=night");
    await waitForOverview(page);
    const warmingCoffee = page.getByTestId("widget-coffee-machine");
    const warmingImageBox = await warmingCoffee.locator(".coffee-asset__image").boundingBox();
    const warmingProgressBox = await warmingCoffee.locator(".coffee-progress").boundingBox();
    expect(await warmingCoffee.getAttribute("data-overview-copy-density")).toBe("dense");
    const warmingAssetBox = await warmingCoffee.locator(".coffee-asset").boundingBox();
    expect(warmingImageBox!.x).toBeGreaterThanOrEqual((warmingAssetBox?.x ?? 0) - 1);
    expect(warmingImageBox!.x + warmingImageBox!.width).toBeLessThanOrEqual((warmingAssetBox?.x ?? 0) + (warmingAssetBox?.width ?? 0) + 1);
    expect(warmingProgressBox).not.toBeNull();

    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await waitForOverview(page);
    const denseCoffee = page.getByTestId("widget-coffee-machine");
    const denseImage = denseCoffee.locator(".coffee-asset__image");
    const denseAsset = denseCoffee.locator(".coffee-asset");
    const denseImageBox = await denseImage.boundingBox();
    const denseAssetBox = await denseAsset.boundingBox();
    expect(await denseCoffee.getAttribute("data-overview-copy-density")).toBe("dense");
    expect(denseImageBox?.width).toBeLessThan(spaciousImageBox?.width ?? Number.POSITIVE_INFINITY);
    expect(Math.abs(
      (denseImageBox!.x + denseImageBox!.width / 2) - (denseAssetBox!.x + denseAssetBox!.width / 2)
    )).toBeLessThanOrEqual(1);
    expect(denseImageBox!.y + denseImageBox!.height).toBeLessThanOrEqual(denseAssetBox!.y + denseAssetBox!.height + 1);
    await expect(denseCoffee.locator(".coffee-state-marker")).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("keeps the Overview grid stable while a NoticeCenter operation is visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const before = await item(page, "fixture.health").boundingBox();
    expect(before).not.toBeNull();

    await page.goto("/overview?theme=night&b0=triple-notice");
    await waitForOverview(page);
    await expect(page.getByTestId("global-notice-stack")).toBeVisible();
    const after = await item(page, "fixture.health").boundingBox();
    expect(after).toMatchObject({
      x: before?.x,
      y: before?.y,
      width: before?.width,
      height: before?.height
    });
    await expectNoOverflow(page);
  });

  test("renders canonical Coffee states, semantic progress colors, and quiet ON action", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const cases = [
      ["coffee-off", "off", "unknown", false],
      ["coffee-turning-on", "turning_on", "unknown", false],
      ["coffee-warming", "warming", "transition-teal", true],
      ["coffee-ready", "ready", "ready-green", true],
      ["coffee-running", "running", "unknown", false],
      ["coffee-stale", "stale", "unknown", false],
      ["coffee-turning-off", "turning_off", "unknown", false],
      ["ha-offline-policy-available", "unavailable", "unknown", false]
    ] as const;

    for (const [scenario, stage, tone, hasProgress] of cases) {
      await page.goto(`/overview?scenario=${scenario}&theme=night`);
      await waitForOverview(page);
      const coffee = page.getByTestId("widget-coffee-machine");
      await expect(coffee).toHaveAttribute("data-stage", stage);
      await expect(coffee).toHaveAttribute("data-progress-tone", tone);
      const immediateAction = coffee.locator("[data-coffee-action]");
      await expect(immediateAction).toHaveCount(1);
      await expect(immediateAction).toHaveAttribute(
        "data-coffee-action",
        stage === "off" ? "off-primary" : "on-quiet"
      );
      await expect(immediateAction).toHaveCSS(
        "background-color",
        stage === "off" ? /rgb/ : /rgba\(0, 0, 0, 0\)|transparent/
      );
      await expect(immediateAction).toHaveCSS("min-height", "56px");
      if (hasProgress) await expect(coffee.getByTestId("coffee-progress")).toBeVisible();
      else await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
      if (stage === "ready") {
        await expect(coffee.locator(".coffee-panel__state strong")).toHaveText("Готова");
        await expect(coffee.locator(".coffee-panel__state strong")).toHaveCSS("font-size", "32px");
      }
      await expectNoOverflow(page);
    }
  });

  test("shows truthful degraded timing copy when canonical progress is unavailable", async ({ page }) => {
    coffeeTimingUnavailable = true;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const coffee = page.getByTestId("widget-coffee-machine");
    await expect(coffee).toHaveAttribute("data-stage", "running");
    await expect(coffee).toHaveAttribute("data-progress-tone", "unknown");
    await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
    await expect(coffee).toContainText("Параметры разогрева временно недоступны");
  });

  test("animates only an observed OFF to confirmed heating transition and settles truthfully", async ({ page }) => {
    await page.addInitScript(() => {
      type Handler = (event: Event) => void;
      const sources: Array<{ handlers: Map<string, Handler[]>; close: () => void }> = [];
      class FakeEventSource {
        handlers = new Map<string, Handler[]>();
        constructor() { sources.push(this); }
        addEventListener(type: string, handler: Handler) {
          this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as unknown as { emitSnapshot: () => void }).emitSnapshot = () => {
        for (const source of sources) {
          for (const handler of source.handlers.get("snapshot") ?? []) handler(new MessageEvent("snapshot", { data: "{}" }));
        }
      };
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    coffeeFixtureOverride = "off";
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const coffee = page.getByTestId("widget-coffee-machine");
    await expect(coffee).toHaveAttribute("data-transition", "idle");
    await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
    const adjacentBefore = await item(page, "fixture.health").boundingBox();

    coffeeFixtureOverride = "warming";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-canonical-state", "on");
    await expect(coffee).toHaveAttribute("data-transition", "moving");
    await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
    const adjacentDuring = await item(page, "fixture.health").boundingBox();
    expect(adjacentDuring?.x).toBeCloseTo(adjacentBefore?.x ?? Number.NaN, 1);
    expect(adjacentDuring?.y).toBeCloseTo(adjacentBefore?.y ?? Number.NaN, 1);
    await page.waitForTimeout(420);
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    await expect(coffee.getByTestId("coffee-progress")).toBeVisible();
    await expect(coffee.getByTestId("coffee-progress")).toContainText("45%");
    const adjacentSettled = await item(page, "fixture.health").boundingBox();
    expect(adjacentSettled?.x).toBeCloseTo(adjacentBefore?.x ?? Number.NaN, 1);
    expect(adjacentSettled?.y).toBeCloseTo(adjacentBefore?.y ?? Number.NaN, 1);

    coffeeFixtureOverride = "off";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-canonical-state", "off");
    await expect(coffee).toHaveAttribute("data-transition", "idle");
    await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
    await expectNoOverflow(page);

    coffeeFixtureOverride = null;
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-transition", "idle");
    await expect(page.getByTestId("widget-coffee-machine").getByTestId("coffee-progress")).toBeVisible();
  });

  test("holds the settled composition through a slow canonical turning_on state", async ({ page }) => {
    await page.addInitScript(() => {
      type Handler = (event: Event) => void;
      const sources: Array<{ handlers: Map<string, Handler[]> }> = [];
      class FakeEventSource {
        handlers = new Map<string, Handler[]>();
        constructor() { sources.push(this); }
        addEventListener(type: string, handler: Handler) {
          this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as unknown as { emitSnapshot: () => void }).emitSnapshot = () => {
        for (const source of sources) {
          for (const handler of source.handlers.get("snapshot") ?? []) handler(new MessageEvent("snapshot", { data: "{}" }));
        }
      };
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    coffeeFixtureOverride = "off";
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    const coffee = page.getByTestId("widget-coffee-machine");
    const visual = coffee.locator(".coffee-asset__visual");
    const resting = await visual.boundingBox();
    expect(resting).not.toBeNull();
    const restingTransform = await visual.evaluate((element) => getComputedStyle(element).transform);

    coffeeFixtureOverride = "turning-on";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-canonical-state", "turning_on");
    await expect(coffee).toHaveAttribute("data-transition", "moving");
    await expect(coffee.getByTestId("coffee-progress")).toHaveCount(0);
    await page.waitForTimeout(420);
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    await page.waitForTimeout(320);
    const settled = await visual.boundingBox();
    expect(Math.abs((settled?.x ?? Number.NaN) - (resting?.x ?? Number.NaN))).toBeLessThanOrEqual(1);
    expect(Math.abs((settled?.width ?? Number.NaN) - (resting?.width ?? Number.NaN))).toBeLessThanOrEqual(1);
    const settledTransform = await visual.evaluate((element) => getComputedStyle(element).transform);
    expect(settledTransform).toBe(restingTransform);

    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await page.waitForTimeout(80);
    await expect(coffee).toHaveAttribute("data-canonical-state", "turning_on");
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    expect(await visual.evaluate((element) => getComputedStyle(element).transform)).toBe(settledTransform);

    coffeeFixtureOverride = "warming";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-canonical-state", "on");
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    await expect(coffee.getByTestId("coffee-progress")).toBeVisible();
  });

  test("reduced motion renders the confirmed Coffee composition immediately", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=coffee-warming&theme=night&motion=reduced");
    await waitForOverview(page);
    const coffee = page.getByTestId("widget-coffee-machine");
    await expect(coffee).toHaveAttribute("data-transition", "idle");
    await expect(coffee).toHaveAttribute("data-progress-visible", "true");
    const transitionDuration = await coffee.locator(".coffee-asset__visual").evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
    expect(transitionDuration).toBeLessThanOrEqual(0.01);
    await expectNoOverflow(page);
  });

  test("captures the curated review pack", async ({ page }, testInfo) => {
    const artifactDir = process.env.V2_OVERVIEW_CURATED_ARTIFACT_DIR ?? testInfo.outputPath("v2-overview-curated-review");
    await mkdir(artifactDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    const capture = async (name: string) => {
      await waitForOverview(page);
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled" });
    };

    rogStatus = "online";
    await setConnectivityFixture(page, "unavailable");
    homeFixture = "one";
    coffeeFixtureOverride = "off";
    await page.goto("/overview?theme=night");
    await capture("overview-curated-night.png");

    for (const [state, name] of [
      ["warming-early", "overview-coffee-warming-early.png"],
      ["warming-mid", "overview-coffee-warming-mid.png"],
      ["warming-late", "overview-coffee-warming-late.png"]
    ] as const) {
      coffeeFixtureOverride = state;
      await page.goto("/overview?theme=night");
      await capture(name);
    }

    coffeeFixtureOverride = null;
    await page.goto("/overview?scenario=coffee-ready&theme=night");
    await capture("overview-coffee-ready.png");

    await page.goto("/overview?theme=day");
    await capture("overview-curated-day.png");

    rogStatus = "offline";
    await page.goto("/overview?theme=night");
    await capture("overview-rog-offline.png");

    rogStatus = "waking";
    await page.goto("/overview?theme=night");
    await capture("overview-rog-transition.png");

    rogStatus = "online";
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    await capture("overview-coffee-warming.png");

    await page.goto("/overview?scenario=coffee-warming&theme=night&motion=reduced");
    await capture("overview-coffee-warming-reduced-motion.png");

    await page.goto("/overview?scenario=ha-degraded&theme=night");
    await capture("overview-degraded.png");

    await setConnectivityFixture(page, "available");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await expect(page.getByTestId("overview-health-recovery")).toHaveText("Восстановить");
    await capture("overview-health-recovery-available.png");

    await setConnectivityFixture(page, "pending");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await page.getByTestId("overview-health-recovery").click();
    await expect(page.getByTestId("overview-health-recovery")).toHaveText("Проверяем…");
    await capture("overview-health-recovery-pending.png");

    await setConnectivityFixture(page, "unavailable");
    await page.goto("/overview?scenario=ha-offline-policy-available&theme=night");
    await expect(page.getByTestId("overview-health-recovery-unavailable")).toHaveText("Восстановление недоступно");
    await capture("overview-health-recovery-unavailable.png");

    longRussian = true;
    await page.goto("/overview?theme=night");
    await capture("overview-long-russian.png");
  });
});
