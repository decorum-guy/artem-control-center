import { expect, test, type Locator, type Page } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";

type HeaderMetrics = {
  header: { x: number; y: number; width: number; height: number; right: number; bottom: number };
  title: { x: number; y: number; width: number; height: number; right: number; bottom: number };
  subtitle: { x: number; y: number; width: number; height: number; right: number; bottom: number } | null;
  action: { x: number; y: number; width: number; height: number; right: number; bottom: number } | null;
  overflow: boolean;
};

async function measureHeader(header: Locator): Promise<HeaderMetrics> {
  return header.evaluate((element) => {
    const rect = (node: Element | null) => {
      if (!node) throw new Error("Expected route header child");
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const title = rect(element.querySelector("h1"));
    const subtitleElement = element.querySelector(":scope > span");
    const actionElement = element.querySelector(":scope > button");
    const header = rect(element);
    return {
      header,
      title,
      subtitle: subtitleElement ? rect(subtitleElement) : null,
      action: actionElement ? rect(actionElement) : null,
      overflow: element.scrollWidth > element.clientWidth
    };
  });
}

function expectInside(inner: HeaderMetrics["title"], outer: HeaderMetrics["header"], tolerance = 1) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.right).toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + tolerance);
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test.describe("#106 shared compact route header", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 browser gate.");

  test("Home, Services, and System use the shared compact header contract", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const routes = [
      ["/home", "home-v2-toolbar", "Дом", "Устройства и подтверждённые действия"],
      ["/services", "services-v2-toolbar", "Сервисы", "Внимание, свежесть и безопасные сведения"],
      ["/system", "system-v2-toolbar", "Система", null]
    ] as const;

    for (const [route, testId, title, subtitle] of routes) {
      await page.goto(route);
      const header = page.getByTestId(testId);
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute("data-route-header-variant", "compact");
      await expect(header).toHaveClass(/density-route-toolbar/);
      await expect(header.locator("h1")).toHaveText(title);
      if (subtitle) await expect(header.locator(":scope > span")).toHaveText(subtitle);
      else await expect(header.locator(":scope > span")).toHaveCount(0);

      const metrics = await measureHeader(header);
      expect(metrics.overflow).toBe(false);
      expectInside(metrics.title, metrics.header);
      if (metrics.subtitle) expectInside(metrics.subtitle, metrics.header);
      if (metrics.action) {
        expect(metrics.action.width).toBeGreaterThanOrEqual(48);
        expect(metrics.action.height).toBeGreaterThanOrEqual(48);
        expect(metrics.action.x).toBeGreaterThanOrEqual(metrics.header.x - 1);
        expect(metrics.action.right).toBeLessThanOrEqual(metrics.header.right + 1);
      }
      await expectNoDocumentOverflow(page);
    }
  });

  test("keeps the System action and the default Settings header behavior", async ({ page }) => {
    await page.goto("/system");
    const systemHeader = page.getByTestId("system-v2-toolbar");
    const systemAction = systemHeader.getByRole("button", { name: "О системе" });
    await expect(systemAction).toBeVisible();
    await expect(systemAction).toBeEnabled();
    await systemAction.click();
    await expect(page.getByTestId("system-details-sheet")).toBeVisible();
    await page.getByTestId("system-details-sheet").getByRole("button", { name: "Закрыть" }).click();
    await expect(page.getByTestId("system-details-sheet")).toHaveCount(0);

    await page.goto("/settings");
    const settingsHeader = page.locator("[data-testid='route-settings'] > .v2-route-header");
    await expect(settingsHeader).toBeVisible();
    await expect(settingsHeader).toHaveAttribute("data-route-header-variant", "default");
    await expect(settingsHeader).not.toHaveClass(/density-route-toolbar/);
    await expect(settingsHeader.locator(".section-kicker")).toHaveText("Панель");
    await expect(settingsHeader.locator("h1")).toHaveText("Настройки");
  });

  test("preserves compact header density at the established narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 720 });
    for (const [route, testId] of [["/home", "home-v2-toolbar"], ["/services", "services-v2-toolbar"], ["/system", "system-v2-toolbar"]] as const) {
      await page.goto(route);
      const header = page.getByTestId(testId);
      await expect(header).toBeVisible();
      const metrics = await measureHeader(header);
      expect(metrics.overflow).toBe(false);
      expectInside(metrics.title, metrics.header);
      if (metrics.action) {
        expect(metrics.action.width).toBeGreaterThanOrEqual(48);
        expect(metrics.action.height).toBeGreaterThanOrEqual(48);
        expect(metrics.action.right).toBeLessThanOrEqual(metrics.header.right + 1);
      }
      await expectNoDocumentOverflow(page);
    }
  });
});
