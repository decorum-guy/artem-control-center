import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test.describe.configure({ mode: "serial" });

function temporaryAccessStatus() {
  return {
    schemaVersion: 1,
    revision: 3,
    baseProfile: "standard",
    effectiveProfile: "full",
    temporaryFull: true,
    temporaryFullExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {}
  };
}

async function mockTemporaryAccess(page: Page) {
  await page.route("**/api/v1/access**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/access" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(temporaryAccessStatus())
      });
      return;
    }
    await route.continue();
  });
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
}

async function expectTouchTargets(page: Page) {
  const violations = await page.locator("button, a, input, select").evaluateAll((elements) => elements.flatMap((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
    if (rect.width >= 48 && rect.height >= 48) return [];
    const label = element.closest("label");
    if (label) {
      const labelRect = label.getBoundingClientRect();
      if (labelRect.width >= 48 && labelRect.height >= 48) return [];
    }
    return [{ tag: element.tagName, text: (element.textContent ?? "").trim().slice(0, 60), width: rect.width, height: rect.height }];
  }));
  expect(violations, JSON.stringify(violations)).toEqual([]);
}

test("runtime shutdown uses the trusted custom confirmation and cancel has no POST", async ({ page }) => {
  let shutdownPosts = 0;
  await page.addInitScript(() => {
    window.confirm = () => { throw new Error("native confirm must not be used"); };
    window.prompt = () => { throw new Error("native prompt must not be used"); };
    window.alert = () => { throw new Error("native alert must not be used"); };
  });
  await page.route("**/api/v1/system/runtime", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, platform: "win32", revision: "runtime-revision-1" }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/system/runtime/shutdown", async (route) => {
    shutdownPosts += 1;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });

  await page.goto("/settings");
  const shutdown = page.getByRole("button", { name: "Полностью закрыть" });
  await expect(shutdown).toBeEnabled();
  await shutdown.tap();
  const dialog = page.getByTestId("action-confirmation");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Локальная панель Windows");
  await dialog.getByRole("button", { name: "Отмена" }).tap();
  await expect(dialog).toBeHidden();
  expect(shutdownPosts).toBe(0);

  await shutdown.tap();
  await page.getByTestId("action-confirmation").getByRole("button", { name: "Полностью закрыть" }).tap();
  await expect.poll(() => shutdownPosts).toBe(1);
});

test("temporary access and three global notices never overlap", async ({ page }) => {
  await mockTemporaryAccess(page);
  await page.goto("/overview?b0=triple-notice");
  await expect(page.getByTestId("temporary-access-indicator")).toBeVisible();
  const stack = page.getByTestId("global-notice-stack");
  await expect(stack).toBeVisible();
  await expect(stack.getByTestId("global-notice")).toHaveCount(3);

  const boxes = await stack.locator("[data-testid='global-notice']").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }));
  for (let index = 0; index < boxes.length; index += 1) {
    for (let next = index + 1; next < boxes.length; next += 1) {
      expect(boxes[index].bottom).toBeLessThanOrEqual(boxes[next].top + 0.5);
    }
  }
  const temporary = await page.getByTestId("temporary-access-indicator").boundingBox();
  expect(temporary).not.toBeNull();
  expect(boxes.every((box) => box.bottom <= (temporary?.top ?? 0) || box.top >= (temporary?.bottom ?? 0))).toBeTruthy();
});

test("notice stack limits to three and deduplicates correlation IDs", async ({ page }) => {
  await page.goto("/overview?b0=duplicate-notice");
  await expect(page.getByTestId("global-notice-stack").getByTestId("global-notice")).toHaveCount(1);
  await expect(page.getByText("Дубликат устранён")).toBeVisible();
  await page.goto("/overview?b0=triple-notice");
  await expect(page.getByTestId("global-notice-stack").getByTestId("global-notice")).toHaveCount(3);
});

test("all visible product controls meet the touch target floor", async ({ page }) => {
  for (const route of ["/overview", "/weather", "/settings", "/services"]) {
    await page.goto(route);
    await expectTouchTargets(page);
  }
});

test("Weather management actions work with touch tap", async ({ page }) => {
  await page.goto("/weather");
  const managementTrigger = page.getByRole("button", { name: "Управление" });
  await managementTrigger.tap();
  const sheet = page.getByTestId("weather-management-sheet");
  await expect(sheet).toBeVisible();
  const manager = sheet.locator(".weather-location-manager");
  await expect(manager).toBeVisible();
  await manager.getByRole("button", { name: /Сохранить/ }).first().tap();
  await sheet.getByRole("button", { name: "Закрыть" }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(managementTrigger).toBeFocused();
  await page.getByRole("button", { name: "+ Место" }).tap();
  await expect(page.getByTestId("weather-location-search")).toBeVisible();
  await page.getByTestId("weather-location-search").getByRole("button", { name: "Закрыть поиск" }).tap();
  await expect(sheet).toHaveCount(0);
});

test("coffee timing uses touch steppers without an editable numeric input", async ({ page }) => {
  await page.goto("/settings");
  const warmup = page.locator('output[aria-label="Время разогрева"]');
  await expect(warmup).toHaveText("15 мин");
  await expect(page.locator("input[type=number], input[inputmode=numeric]")).toHaveCount(0);
  await page.getByTestId("coffee-timing-warmup").getByRole("button", { name: /увеличить/ }).tap();
  await expect(warmup).toHaveText("16 мин");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
});

test("Overview and Weather fit the canonical first viewport", async ({ page }) => {
  await page.goto("/overview");
  const primary = page.getByTestId("overview-primary-content");
  const coffee = page.locator(".overview-coffee .coffee-panel");
  const primaryBox = await primary.boundingBox();
  const coffeeBox = await coffee.boundingBox();
  expect(primaryBox).not.toBeNull();
  expect(coffeeBox).not.toBeNull();
  expect(coffeeBox?.height).toBeGreaterThanOrEqual(280);
  expect(coffeeBox?.height).toBeLessThanOrEqual(330);
  expect((coffeeBox?.width ?? 0) / (primaryBox?.width ?? 1)).toBeGreaterThanOrEqual(0.5);
  expect((coffeeBox?.width ?? 0) / (primaryBox?.width ?? 1)).toBeLessThanOrEqual(0.65);
  await expectNoDocumentOverflow(page);

  await page.goto("/weather");
  await expect(page.getByTestId("weather-hero")).toBeVisible();
  const hero = await page.getByTestId("weather-hero").boundingBox();
  expect(hero?.height).toBeLessThanOrEqual(300);
  const hourlyCards = page.locator(".weather-hour");
  const visibleCards = await hourlyCards.evaluateAll((elements) => elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }).length);
  expect(visibleCards).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".weather-hourly-more")).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("only the hourly strip intentionally scrolls horizontally", async ({ page }) => {
  await page.goto("/weather");
  const scrollers = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("*"))
    .filter((element) => element.scrollWidth > element.clientWidth + 1)
    .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowX))
    .map((element) => element.className));
  expect(scrollers.every((name) => String(name).includes("weather-hourly")), JSON.stringify(scrollers)).toBeTruthy();
});

test("reduced, low-performance and battery-saving modes stop Weather ambience", async ({ page }) => {
  for (const motion of ["reduced", "low-performance", "battery-saving"]) {
    await page.goto(`/weather?motion=${motion}`);
    const animations = await page.locator(".weather-ambient *").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationName));
    expect(animations.every((animation) => animation === "none")).toBeTruthy();
  }
});

test("essential metadata stays at or above 12px and Russian labels do not cover controls", async ({ page }) => {
  await page.goto("/settings?motion=reduced");
  const smallMetadata = await page.locator(".section-kicker, .source-chip, .mode-badge, .system-summary, .settings-section p, .timing-stepper-field > span").evaluateAll((elements) => elements.flatMap((element) => {
    const size = Number.parseFloat(getComputedStyle(element).fontSize);
    return size < 12 ? [{ text: element.textContent?.trim(), size }] : [];
  }));
  expect(smallMetadata, JSON.stringify(smallMetadata)).toEqual([]);
  const label = await page.getByText("Предупредить о долгой работе через", { exact: true }).boundingBox();
  const stepper = await page.getByTestId("coffee-timing-long-running").boundingBox();
  expect(label).not.toBeNull();
  expect(stepper).not.toBeNull();
  expect((label?.right ?? 0) <= (stepper?.left ?? 0) || (label?.bottom ?? 0) <= (stepper?.top ?? 0) || (stepper?.bottom ?? 0) <= (label?.top ?? 0)).toBeTruthy();
});

test("200 percent zoom keeps the product usable without document overflow", async ({ page }) => {
  await page.goto("/settings");
  // Browser zoom halves the effective CSS viewport.  Playwright has no
  // browser-zoom API, so use the equivalent 640px layout viewport.
  await page.setViewportSize({ width: 640, height: 720 });
  await expectNoDocumentOverflow(page);
  await page.getByRole("button", { name: "Полностью закрыть" }).scrollIntoViewIfNeeded();
  const control = await page.getByRole("button", { name: "Полностью закрыть" }).boundingBox();
  expect(control?.width).toBeGreaterThanOrEqual(48);
  expect(control?.height).toBeGreaterThanOrEqual(48);
});

test("B0 screenshot set", async ({ page }, testInfo) => {
  const artifactDir = process.env.B0_ARTIFACT_DIR ?? testInfo.outputPath("b0-artifacts");
  await mkdir(artifactDir, { recursive: true });
  const screenshot = async (name: string) => page.screenshot({ path: path.join(artifactDir, name), animations: "disabled" });

  await page.goto("/overview?theme=day");
  await expect(page.getByTestId("route-overview")).toBeVisible();
  await expect(page.locator(".coffee-panel")).toBeVisible();
  await screenshot("overview-day.png");
  await page.goto("/overview?theme=night");
  await expect(page.getByTestId("route-overview")).toBeVisible();
  await expect(page.locator(".coffee-panel")).toBeVisible();
  await screenshot("overview-night.png");
  await page.goto("/weather?theme=day");
  await expect(page.getByTestId("weather-hero")).toBeVisible();
  await screenshot("weather-day.png");
  await page.goto("/weather?theme=night");
  await expect(page.getByTestId("weather-hero")).toBeVisible();
  await screenshot("weather-night.png");
  await page.goto("/settings");
  await expect(page.getByTestId("coffee-settings")).toBeVisible();
  await screenshot("settings.png");
  await mockTemporaryAccess(page);
  await page.goto("/overview?b0=triple-notice");
  await expect(page.getByTestId("global-notice-stack")).toBeVisible();
  await screenshot("triple-notice.png");
  await page.route("**/api/v1/system/runtime", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, platform: "win32", revision: "runtime-revision-1" }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Полностью закрыть" }).tap();
  await expect(page.getByTestId("action-confirmation")).toBeVisible();
  await screenshot("runtime-shutdown-confirmation.png");
});
