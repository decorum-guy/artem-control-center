import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "Run with the Cabin skin and V2 visual shell.");

const routes = ["overview", "weather", "home", "services", "coffee-diary", "calendar", "tasks", "reminders", "backups", "apps", "system", "settings"];
for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`twelve route titles, telemetry and modal focus at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await page.route(/\/api\/v1\/access(?:\?.*)?$/, (route) => route.fulfill({ json: {
      schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard", temporaryFull: false,
      temporaryFullExpiresAt: null, pinConfigured: true, lockoutUntil: null, capabilities: {}
    } }));
    for (const route of routes) {
      await page.goto("/" + route + "?motion=reduced", { waitUntil: "domcontentloaded" });
      const heading = page.locator(".v2-route-content [data-page-header] h1");
      await expect(heading).toBeVisible();
      await expect(heading).not.toHaveText("");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const clipped = await page.getByTestId("product-header").locator("span:not(.interaction-lock-sr-status)").evaluateAll((nodes) => nodes
      .filter((el) => !el.childElementCount && el.getBoundingClientRect().width > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "hidden")
      .map((el) => el.textContent));
    expect(clipped).toEqual([]);
    await expect(page.getByTestId("product-header").locator(".v2-settings-shortcut")).toHaveCount(0);
    if (viewport.height > viewport.width) {
      const menu = page.getByTestId("portrait-floating-navigation-toggle");
      await menu.click();
      const navigation = page.getByRole("dialog", { name: "Разделы" });
      await expect(navigation.getByRole("link", { name: "Настройки" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
    } else {
      await expect(page.getByRole("navigation").getByRole("link", { name: "Настройки" })).toBeVisible();
    }
  });
}

test("loading and progress notices use the real shell and stay accessible", async ({ page }) => {
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/snapshot**", async (route) => { await pause; await route.continue(); });
  await page.goto("/overview?b0=triple-notice", { waitUntil: "domcontentloaded" });
  const boot = page.locator(".cc-boot");
  try {
    await expect(boot).toHaveText("Загружаем данные…");
    await expect(boot.locator(".cc-skeleton")).toHaveCount(4);
  } finally { release(); }
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  const progress = page.locator(".global-notice--progress");
  await expect(progress).toBeVisible();
  const close = progress.getByRole("button", { name: "Закрыть уведомление" });
  const box = await close.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
  await close.click();
  await expect(progress).toHaveCount(0);
});

test("host battery shows its level before the weather and follows charging changes", async ({ page }) => {
  let telemetry: { percentage: number; charging: boolean; pluggedIn: boolean } | null =
    { percentage: 100, charging: true, pluggedIn: true };
  await page.route("**/api/v1/system/battery", (route) => route.fulfill({ json: telemetry }));

  const header = page.getByTestId("product-header");
  const battery = header.getByRole("img", { name: /Заряд аккумулятора/ });
  const weather = header.getByRole("button", { name: "Открыть погоду" });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/overview?motion=reduced");
    await expect(battery).toHaveText("100%");
    await expect(battery).toHaveAttribute("aria-label", /От сети\. Заряжается/);
    await expect(battery.locator("svg")).toHaveCount(1);
    const batteryBox = (await battery.boundingBox())!;
    const weatherBox = (await weather.boundingBox())!;
    expect(batteryBox.x + batteryBox.width).toBeLessThan(weatherBox.x);
    expect(batteryBox.y).toBeGreaterThanOrEqual(weatherBox.y);
    expect(batteryBox.y + batteryBox.height).toBeLessThanOrEqual(weatherBox.y + weatherBox.height);
    expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (viewport.width > viewport.height) {
      const clipped = await header.locator(".v2-header-time > span > span, .weather-summary__temperature, .cc-status-chip").evaluateAll((nodes) =>
        nodes.some((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1));
      const dateBox = (await header.locator(".cc-header-date").boundingBox())!;
      expect(dateBox.x + dateBox.width).toBeLessThan(batteryBox.x);
      expect(clipped).toBe(false);
    }
  }

  telemetry = { percentage: 17, charging: false, pluggedIn: false };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(battery).toHaveText("17%");
  await expect(battery).toHaveAttribute("aria-label", /От батареи\. Не заряжается/);
  await expect(battery.locator("svg")).toHaveCount(0);

  telemetry = null;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(battery).toHaveCount(0);
  await expect(weather).toBeVisible();
});

test("returning to an open V3 section does not replay the route entrance", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/overview?motion=full");
  const content = page.locator(".v2-route-content");
  await expect(content).toBeVisible();
  await content.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true })
      .filter((animation) => animation instanceof CSSAnimation && animation.animationName === "cc-skin-enter");
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });

  const repeats = await content.evaluate(async (element) => {
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await frame();
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await frame();
    return element.getAnimations({ subtree: true })
      .filter((animation) => animation instanceof CSSAnimation && animation.animationName === "cc-skin-enter").length;
  });
  expect(repeats).toBe(0);
  await page.getByRole("navigation").getByRole("link", { name: "Дом", exact: true }).click();
  await expect(page).toHaveURL(/\/home(?:\?|$)/);
  await expect(content).toHaveCount(1);
  await expect(content.getByRole("heading", { name: "Дом", exact: true })).toBeVisible();
});
