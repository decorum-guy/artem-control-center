import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewRouteTestId = process.env.VITE_OVERVIEW_V2_ENABLED === "true"
  ? "route-overview-v2"
  : "route-overview";

type TimingSettings = {
  schemaVersion: 1;
  source: "home-assistant";
  transport: "alice-tg-bot";
  revision: string;
  observedAt: string;
  warmupMinutes: number;
  longRunningMinutes: number;
  sourceMode: "live" | "cached" | "fixture" | "stale";
  writesEnabled: boolean;
};

type NotificationEvent = {
  enabled: boolean;
  channels: { telegram: boolean; iphone: boolean };
};

type NotificationSettings = {
  schemaVersion: 1;
  source: "alice-tg-bot";
  revision: string;
  updatedAt: string;
  warmup: NotificationEvent;
  longRunning: NotificationEvent;
  sourceMode: "live" | "cached" | "fixture" | "stale";
  writesEnabled: boolean;
};

const artifactNames = [
  "settings-default.png",
  "settings-coffee-sheet.png",
  "settings-notifications-sheet.png",
  "settings-access-sheet.png",
  "settings-runtime-sheet.png",
  "settings-disabled-policy.png",
  "settings-200-percent.png",
  "settings-long-russian.png",
  "settings-osk.png",
  "settings-day.png"
];

function timingFixture(writesEnabled = true): TimingSettings {
  return {
    schemaVersion: 1,
    source: "home-assistant",
    transport: "alice-tg-bot",
    revision: "timing-revision-1",
    observedAt: "2026-08-15T00:00:00Z",
    warmupMinutes: 15,
    longRunningMinutes: 60,
    sourceMode: "fixture",
    writesEnabled
  };
}

function notificationFixture(writesEnabled = true): NotificationSettings {
  return {
    schemaVersion: 1,
    source: "alice-tg-bot",
    revision: "notification-revision-1",
    updatedAt: "2026-08-15T00:00:00Z",
    warmup: { enabled: true, channels: { telegram: false, iphone: true } },
    longRunning: { enabled: false, channels: { telegram: true, iphone: false } },
    sourceMode: "fixture",
    writesEnabled
  };
}

async function mockCoffeeSettings(
  page: Page,
  options: { writesEnabled?: boolean; conflictOnce?: boolean } = {}
) {
  let timing = timingFixture(options.writesEnabled ?? true);
  let notifications = notificationFixture(options.writesEnabled ?? true);
  let conflictOnce = options.conflictOnce ?? false;

  await page.route("**/api/v1/settings/coffee/timing", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(timing) });
      return;
    }

    if (request.method() === "PATCH") {
      const payload = request.postDataJSON() as {
        expectedRevision?: string;
        warmupMinutes?: number;
        longRunningMinutes?: number;
      };
      if (conflictOnce) {
        conflictOnce = false;
        timing = { ...timing, revision: "timing-revision-2", warmupMinutes: 17 };
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "revision_conflict" })
        });
        return;
      }
      if (payload.expectedRevision !== timing.revision) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "revision_conflict" })
        });
        return;
      }
      timing = {
        ...timing,
        revision: "timing-revision-saved",
        warmupMinutes: payload.warmupMinutes ?? timing.warmupMinutes,
        longRunningMinutes: payload.longRunningMinutes ?? timing.longRunningMinutes
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(timing) });
      return;
    }

    await route.continue();
  });

  await page.route("**/api/v1/settings/notifications/coffee", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(notifications) });
      return;
    }

    if (request.method() === "PATCH") {
      const payload = request.postDataJSON() as {
        expectedRevision?: string;
        warmup?: Partial<NotificationEvent>;
        longRunning?: Partial<NotificationEvent>;
      };
      if (payload.expectedRevision !== notifications.revision) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "revision_conflict" })
        });
        return;
      }
      const event = payload.warmup ? "warmup" : "longRunning";
      const patch = payload[event];
      if (patch?.enabled !== undefined) notifications[event].enabled = patch.enabled;
      if (patch?.channels) notifications[event].channels = {
        ...notifications[event].channels,
        ...patch.channels
      };
      notifications = { ...notifications, revision: "notification-revision-saved" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(notifications) });
      return;
    }

    await route.continue();
  });
}

async function openSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
  expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
}

async function closeSheet(page: Page) {
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.locator(".cc-sheet")).toHaveCount(0);
}

async function expectSwitchGeometry(row: Locator, state: "Вкл" | "Выкл") {
  await expect(row.locator(".setting-switch-row__state")).toHaveText(state, { exact: true });
  await expect.poll(async () => row.evaluate((element) => {
    const thumb = element.querySelector<HTMLElement>(".setting-switch-row__thumb")?.getBoundingClientRect();
    const stateText = element.querySelector<HTMLElement>(".setting-switch-row__state")?.getBoundingClientRect();
    if (!thumb || !stateText) return true;
    return thumb.left < stateText.right && thumb.right > stateText.left &&
      thumb.top < stateText.bottom && thumb.bottom > stateText.top;
  }), { timeout: 1500, message: "switch thumb and state text must not intersect after settling" }).toBe(false);
}

test.describe("Control Center V2 PR8 Settings information architecture", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the PR8 browser gate.");

  test("canonical first viewport exposes Appearance and two settings columns", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);

    await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Внешний вид", exact: true })).toBeVisible();
    await expect(page.getByText("Appearance", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("settings-summary-coffee")).toBeVisible();
    await expect(page.getByTestId("settings-summary-notifications")).toBeVisible();
    await expect(page.getByTestId("settings-summary-access")).toBeVisible();
    await expect(page.getByTestId("settings-summary-runtime")).toBeVisible();

    const motionLabels = [
      ["full", "Полное"],
      ["reduced", "Уменьшенное"],
      ["low-performance", "Низкая производительность"],
      ["battery-saving", "Экономия батареи"]
    ] as const;
    for (const [value, label] of motionLabels) {
      const button = page.getByTestId(`settings-motion-${value}`);
      await expect(button).toHaveText(label, { exact: true });
      await expect(button).toBeVisible();
    }
    const motionMetrics = await page.locator(".settings-v2-motion-grid button").evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          overflowWrap: style.overflowWrap,
          wordBreak: style.wordBreak,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          lineCount: range.getClientRects().length
        };
      })
    );
    expect(motionMetrics).toHaveLength(4);
    for (const metric of motionMetrics) {
      expect(metric.overflowWrap).toBe("normal");
      expect(metric.wordBreak).toBe("normal");
      expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
      expect(metric.lineCount).toBeLessThanOrEqual(2);
    }

    const appearance = await page.locator(".settings-v2-appearance").boundingBox();
    const columns = await page.locator(".settings-summary-column").evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().left)
    );
    expect(appearance?.height).toBeGreaterThanOrEqual(100);
    expect(appearance?.height).toBeLessThanOrEqual(140);
    expect(columns[1]).toBeGreaterThan(columns[0]);
    await expectNoDocumentOverflow(page);
  });

  test("Appearance controls are direct, reachable, and persist through route navigation", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);

    await page.getByTestId("settings-theme-day").click();
    await page.getByTestId("settings-motion-battery-saving").click();
    await expect(page.locator(".app")).toHaveClass(/theme-day/);
    await expect(page.locator(".app")).toHaveClass(/motion-battery-saving/);

    await page.locator(".v2-nav-link[data-nav-route='/overview']").click();
    await expect(page.getByTestId(overviewRouteTestId)).toBeVisible();
    await page.locator(".v2-nav-link[data-nav-route='/settings']").click();
    await expect(page.getByTestId("settings-theme-day")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("settings-motion-battery-saving")).toHaveAttribute("aria-pressed", "true");
  });

  test("each summary row opens its own shared Sheet and only one Sheet exists", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);

    for (const [row, sheet] of [
      ["settings-summary-coffee", "settings-coffee-sheet"],
      ["settings-summary-notifications", "settings-notifications-sheet"],
      ["settings-summary-access", "settings-access-sheet"],
      ["settings-summary-runtime", "settings-runtime-sheet"]
    ] as const) {
      await page.getByTestId(row).click();
      await expect(page.getByTestId(sheet)).toBeVisible();
      await expect(page.locator(".cc-sheet")).toHaveCount(1);
      await closeSheet(page);
    }
  });

  test("Coffee summary keeps timing controls and Save semantics inside its Sheet", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.getByTestId("settings-summary-coffee").click();

    const sheet = page.getByTestId("settings-coffee-sheet");
    await expect(sheet.getByRole("heading", { name: "Время", exact: true })).toHaveCount(1);
    await expect(sheet.locator('output[aria-label="Время разогрева"]')).toHaveText("15 мин");
    await sheet.getByTestId("coffee-timing-warmup").getByRole("button", { name: /уменьшить/ }).click();
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(sheet.locator(".settings-notice")).toContainText("Сохранено.");
    await expect(sheet.locator('output[aria-label="Время разогрева"]')).toHaveText("14 мин");
  });

  test("Coffee timing retains revision-conflict recovery in the Sheet", async ({ page }) => {
    await mockCoffeeSettings(page, { conflictOnce: true });
    await openSettings(page);
    await page.getByTestId("settings-summary-coffee").click();
    const sheet = page.getByTestId("settings-coffee-sheet");
    await sheet.getByTestId("coffee-timing-warmup").getByRole("button", { name: /уменьшить/ }).click();
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(sheet.getByTestId("timing-conflict")).toContainText("изменились в Telegram");
    await sheet.getByRole("button", { name: "Загрузить актуальные" }).click();
    await expect(sheet.locator('output[aria-label="Время разогрева"]')).toHaveText("17 мин");
  });

  test("Notifications summary separates event and channel switch rows", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.getByTestId("settings-summary-notifications").click();

    const sheet = page.getByTestId("settings-notifications-sheet");
    await expect(sheet.getByRole("heading", { name: "Уведомления", exact: true })).toHaveCount(1);
    const warmup = sheet.locator("fieldset").first();
    await expect(warmup.getByText("Разогрев завершён")).toBeVisible();
    const enabled = warmup.locator(".setting-switch-row").nth(0);
    const telegramRow = warmup.locator(".setting-switch-row").nth(1);
    await expectSwitchGeometry(enabled, "Вкл");
    await expectSwitchGeometry(telegramRow, "Выкл");
    const telegram = warmup.getByLabel("Telegram");
    await expect(telegram).not.toBeChecked();
    await telegram.click();
    await expect(telegram).toBeChecked();
    await expectSwitchGeometry(telegramRow, "Вкл");
    await expect(sheet.getByRole("status")).toContainText("уведомлений сохранены");
  });

  test("writesEnabled=false leaves summaries readable and disables only writes", async ({ page }) => {
    await mockCoffeeSettings(page, { writesEnabled: false });
    await openSettings(page);

    await expect(page.getByTestId("settings-summary-coffee")).toContainText("Только чтение");
    await expect(page.getByTestId("settings-summary-notifications")).toContainText("Только чтение");

    await page.getByTestId("settings-summary-coffee").click();
    const coffeeSheet = page.getByTestId("settings-coffee-sheet");
    await expect(coffeeSheet.locator('output[aria-label="Время разогрева"]')).toHaveText("15 мин");
    await expect(coffeeSheet.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
    await expect(coffeeSheet.getByText("Изменения сейчас недоступны.")).toBeVisible();
    await closeSheet(page);

    await page.getByTestId("settings-summary-notifications").click();
    const notificationSheet = page.getByTestId("settings-notifications-sheet");
    await expect(notificationSheet.locator("input[type=checkbox]").first()).toBeDisabled();
    await expect(notificationSheet.getByText("Изменения сейчас недоступны.")).toBeVisible();
  });

  test("all Settings interaction targets are at least 48px", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.getByTestId("settings-summary-notifications").click();

    const undersized = await page.locator(".settings-v2-page button, .cc-sheet button, .cc-sheet input").evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 48 || rect.height < 48
          ? [{ tag: element.tagName, text: element.textContent?.trim(), width: rect.width, height: rect.height }]
          : [];
      })
    );
    expect(undersized, JSON.stringify(undersized)).toEqual([]);
  });

  test("200 percent effective viewport stacks categories without document overflow", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.setViewportSize({ width: 640, height: 360 });
    await expectNoDocumentOverflow(page);
    await expect(page.locator(".settings-summary-column")).toHaveCount(2);
    await page.getByTestId("settings-summary-runtime").scrollIntoViewIfNeeded();
    await page.getByTestId("settings-summary-runtime").click();
    const sheet = page.getByTestId("settings-runtime-sheet");
    await expect(sheet).toBeVisible();
    const rect = await sheet.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { right: box.right, bottom: box.bottom };
    });
    expect(rect.right).toBeLessThanOrEqual(640);
    expect(rect.bottom).toBeLessThanOrEqual(360);
    await closeSheet(page);
  });

  test("Sheets remain reachable under a reduced visualViewport", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      Object.defineProperty(viewport, "height", { configurable: true, value: 260 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await page.getByTestId("settings-summary-coffee").click();
    const sheet = page.getByTestId("settings-coffee-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).scrollIntoViewIfNeeded();
    const close = sheet.getByRole("button", { name: "Закрыть" });
    const closeRect = await close.evaluate((element) => element.getBoundingClientRect().bottom);
    const saveRect = await sheet.getByRole("button", { name: "Сохранить", exact: true })
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(closeRect).toBeLessThanOrEqual(260);
    expect(saveRect).toBeLessThanOrEqual(260);
  });

  test("long Russian labels stay available in the full Sheet", async ({ page }) => {
    await mockCoffeeSettings(page, { writesEnabled: false });
    await openSettings(page);
    await page.getByTestId("settings-summary-coffee").click();
    const sheet = page.getByTestId("settings-coffee-sheet");
    await expect(sheet.getByText("Предупредить о долгой работе через", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Изменения сейчас недоступны.", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeVisible();
    const longLabel = sheet.getByText("Предупредить о долгой работе через", { exact: true });
    expect(await longLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  });

  test("Settings render no credential fields", async ({ page }) => {
    await mockCoffeeSettings(page);
    await openSettings(page);
    const sensitiveInputs = page.locator("input[type=password], input[name*='token' i], input[name*='secret' i], input[name*='password' i], textarea[name*='token' i], textarea[name*='secret' i]");
    await expect(sensitiveInputs).toHaveCount(0);
    for (const row of ["settings-summary-coffee", "settings-summary-notifications", "settings-summary-access", "settings-summary-runtime"]) {
      await page.getByTestId(row).click();
      await expect(page.locator(".cc-sheet")).toHaveCount(1);
      await expect(page.locator(".cc-sheet").locator("input[type=password], input[name*='token' i], input[name*='secret' i], input[name*='password' i]")).toHaveCount(0);
      await closeSheet(page);
    }
  });

  test("existing access controls remain authoritative inside Access Sheet", async ({ page }) => {
    await page.route("**/api/v1/access", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          baseProfile: "standard",
          effectiveProfile: "standard",
          temporaryFull: false,
          temporaryFullExpiresAt: null,
          pinConfigured: true,
          lockoutUntil: null,
          capabilities: {}
        })
      });
    });
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.getByTestId("settings-summary-access").click();
    const sheet = page.getByTestId("settings-access-sheet");
    await expect(sheet.getByRole("radio", { name: /Обычный доступ/ })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: /Полный доступ/ })).toBeVisible();
    await expect(sheet.getByText("Сейчас: Обычный доступ")).toBeVisible();
  });

  test("existing RuntimeControls remain the only runtime action authority", async ({ page }) => {
    await page.route("**/api/v1/system/runtime", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enabled: true, platform: "fixture", revision: "runtime-revision-1" })
        });
        return;
      }
      await route.continue();
    });
    await mockCoffeeSettings(page);
    await openSettings(page);
    await page.getByTestId("settings-summary-runtime").click();
    const sheet = page.getByTestId("settings-runtime-sheet");
    await expect(sheet.getByRole("button", { name: "Скрыть панель" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Полностью закрыть" })).toBeVisible();
    await expect(sheet.getByText("Системные действия панели.")).toBeVisible();
    await expect(sheet.locator("input, textarea")).toHaveCount(0);
  });

  test("captures the exact PR8 Settings review artifact family", async ({ page }, testInfo) => {
    const artifactDir = path.resolve(process.env.V2_SETTINGS_ARTIFACT_DIR ?? testInfo.outputPath("v2-settings-review"));
    await mkdir(artifactDir, { recursive: true });
    const capture = async (name: string) => {
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled" });
    };

    await mockCoffeeSettings(page);
    await openSettings(page);
    await capture("settings-default.png");

    await page.getByTestId("settings-summary-coffee").click();
    await capture("settings-coffee-sheet.png");
    await closeSheet(page);

    await page.getByTestId("settings-summary-notifications").click();
    await capture("settings-notifications-sheet.png");
    await closeSheet(page);

    await page.getByTestId("settings-summary-access").click();
    await capture("settings-access-sheet.png");
    await closeSheet(page);

    await page.getByTestId("settings-summary-runtime").click();
    await capture("settings-runtime-sheet.png");
    await closeSheet(page);

    await page.route("**/api/v1/settings/coffee/timing", async (route) => {
      if (route.request().method() === "GET") {
        const value = timingFixture(false);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
        return;
      }
      await route.continue();
    });
    await page.reload();
    await page.getByTestId("settings-summary-coffee").click();
    await capture("settings-disabled-policy.png");
    await closeSheet(page);

    await page.setViewportSize({ width: 640, height: 360 });
    await capture("settings-200-percent.png");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByTestId("settings-summary-coffee").click();
    await capture("settings-long-russian.png");
    await page.getByRole("button", { name: "Сохранить", exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      Object.defineProperty(viewport, "height", { configurable: true, value: 260 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await capture("settings-osk.png");
    await closeSheet(page);

    await page.getByTestId("settings-theme-day").click();
    await capture("settings-day.png");

    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(artifactDir));
    expect(entries.sort()).toEqual([...artifactNames].sort());
  });
});

test("shell-off retains the legacy Settings presentation", async ({ page }) => {
  test.skip(v2Enabled, "Run this regression with the V2 visual shell disabled.");
  await page.goto("/settings");
  await expect(page.getByTestId("coffee-settings")).toBeVisible();
  await expect(page.getByTestId("settings-summary-coffee")).toHaveCount(0);
  await expect(page.getByTestId("coffee-settings").getByRole("heading", { name: "Время", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("coffee-settings").getByRole("heading", { name: "Уведомления", exact: true })).toHaveCount(1);
});
