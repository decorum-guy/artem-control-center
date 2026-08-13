import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";

type RogStatus = "online" | "offline" | "waking" | "hibernating" | "unavailable";
type RogAction = "system.rog_g703.wake" | "system.rog_g703.hibernate";

let rogStatus: RogStatus = "online";
let longRussian = false;
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
    (actionId.endsWith("hibernate") && status === "online");
  return {
    availability: allowed ? "allowed" : "not_allowed",
    allowed,
    reason: allowed ? null : "action_not_available_for_current_state",
    requiresConfirmation: actionId.endsWith("hibernate"),
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
    if (longRussian && snapshot.planning) {
      const longTitle = "Очень длинное русское название операционного напоминания, которое должно корректно переноситься";
      snapshot.planning.reminders.upcoming = snapshot.planning.reminders.upcoming.map((item) => ({ ...item, title: longTitle }));
      snapshot.planning.tasks.overdue = snapshot.planning.tasks.overdue.map((item) => ({ ...item, title: longTitle }));
      snapshot.planning.calendar.today = snapshot.planning.calendar.today.map((item) => ({ ...item, title: longTitle }));
    }
    await route.fulfill({
      response,
      body: JSON.stringify(snapshot),
      headers: { ...response.headers(), "content-type": "application/json" }
    });
  });

  await page.route("**/api/v1/actions/system/rog-g703/availability", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        targetId: "rog_g703gi",
        status: rogService(rogStatus).data,
        actions: {
          "system.rog_g703.wake": decision("system.rog_g703.wake", rogStatus),
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
        status: actionId.endsWith("wake") ? "waking" : "hibernating",
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

test.describe("PR4 curated Overview", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!overviewV2Enabled || !visualShellEnabled, "Run with both PR4 flags enabled.");
    rogStatus = "online";
    longRussian = false;
    postedActions.length = 0;
    await installCuratedMocks(page);
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

    await expect(page.getByTestId("overview-configure")).toBeDisabled();
    await expect(page.getByTestId("connectivity-recovery-surface")).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("keeps the ROG action contextual and preserves the exact action payload", async ({ page }) => {
    rogStatus = "offline";
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("overview-rog-g703")).toContainText("Не в сети");
    await expect(page.getByTestId("overview-rog-g703-action")).toHaveText("Включить");
    await page.getByTestId("overview-rog-g703-action").click();
    await expect.poll(() => postedActions.length).toBe(1);
    expect(postedActions).toEqual([{ actionId: "system.rog_g703.wake" }]);
    await expect(page.getByTestId("overview-rog-g703")).toContainText("В сети");
    await expectNoOverflow(page);
  });

  test.describe("ROG state projection", () => {
    const states: Array<[RogStatus, string, string | null]> = [
      ["online", "В сети", "Гибернация"],
      ["offline", "Не в сети", "Включить"],
      ["waking", "Пробуждение", "Пробуждение"],
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
          await expect(page.getByTestId("overview-rog-g703-action")).toContainText(action);
          await expect(page.locator(".overview-rog-widget__action button")).toHaveCount(1);
          if (state === "online") await expect(page.getByTestId("overview-rog-g703-action")).not.toContainText("Включить");
          if (state === "offline") await expect(page.getByTestId("overview-rog-g703-action")).not.toContainText("Гибернация");
        } else {
          await expect(page.getByTestId("overview-rog-g703-unavailable")).toContainText("Недоступен");
          await expect(page.getByTestId("overview-rog-g703-action")).toHaveCount(0);
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
    await expect(page.getByTestId("overview-rog-g703-action")).toHaveText("Включить");
    await page.goto("/system?theme=night");
    await expect(page.getByTestId("rog-g703-controls")).toBeVisible();
    await expect(page.getByTestId("rog-g703-controls")).toContainText("Не в сети");
    await expect(page.getByTestId("rog-g703-wake")).toBeEnabled();
    await expect(page.getByTestId("rog-g703-hibernate")).toBeDisabled();
  });

  test("keeps connectivity recovery inside health without changing grid geometry", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=ha-degraded&theme=night");
    await waitForOverview(page);
    await expect(page.getByTestId("connectivity-recovery-surface")).toHaveCount(0);
    await expect(page.getByTestId("overview-health-widget")).toContainText("требуют внимания");
    const health = await item(page, "fixture.health").boundingBox();
    expect(health).not.toBeNull();
    expect(health?.x).toBeCloseTo(824, 0);
    expect(health?.y).toBeCloseTo(496, 0);
    expect(health?.width).toBeCloseTo(436, 0);
    expect(health?.height).toBeCloseTo(132, 0);
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
    await expect(page.getByTestId("planning-reminder-row")).toBeVisible();
    await expect(page.getByTestId("planning-task-row")).toBeVisible();
    await expect(page.getByTestId("planning-event-row")).toBeVisible();
    await expect(page.getByTestId("overview-home-device-kettle")).toContainText("Чайник");
    await expect(page.getByTestId("overview-health-widget")).toContainText("требуют внимания");
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

  test("captures the curated review pack", async ({ page }, testInfo) => {
    const artifactDir = process.env.V2_OVERVIEW_CURATED_ARTIFACT_DIR ?? testInfo.outputPath("v2-overview-curated-review");
    await mkdir(artifactDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    const capture = async (name: string) => {
      await waitForOverview(page);
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled" });
    };

    rogStatus = "online";
    await page.goto("/overview?theme=night");
    await capture("overview-curated-night.png");

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

    await page.goto("/overview?scenario=ha-degraded&theme=night");
    await capture("overview-degraded.png");

    longRussian = true;
    await page.goto("/overview?theme=night");
    await capture("overview-long-russian.png");
  });
});
