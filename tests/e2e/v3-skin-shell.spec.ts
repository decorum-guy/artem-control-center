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
    if (viewport.height > viewport.width) {
      const menu = page.getByTestId("portrait-floating-navigation-toggle");
      await menu.click();
      await expect(page.getByRole("dialog", { name: "Разделы" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
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
