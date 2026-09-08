import { expect, test, type Locator, type Page } from "@playwright/test";

const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewEnabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

async function expectMinimumControlSize(locator: Locator): Promise<void> {
  const heights = await locator.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(48);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
}

test.describe("Issue 207 · Home Assistant climate controls", () => {
  test.skip(!visualShellEnabled, "Requires the V2 visual shell.");

  test("renders the fixed Home climate contract in Home", async ({ page }) => {
    await page.goto("/home?scenario=home-climate-healthy");
    const climate = page.getByTestId("climate-control-home");
    await expect(climate).toBeVisible();
    await expect(climate).toContainText("В комнате");
    await expect(climate).toContainText("Температура в комнате недоступна");
    await expect(climate.locator("select").nth(0).locator("option")).toHaveCount(6);
    await expect(climate.locator("select").nth(1).locator("option")).toHaveCount(5);
    await expectMinimumControlSize(climate.locator("button"));
    await expectNoHorizontalOverflow(page);
  });

  test("disables climate writes for stale and unavailable snapshots", async ({ page }) => {
    for (const scenario of ["home-climate-stale", "home-climate-unavailable"]) {
      await page.goto(`/home?scenario=${scenario}`);
      const climate = page.getByTestId("climate-control-home");
      await expect(climate).toBeVisible();
      const disabled = await climate.locator("button, select").evaluateAll((controls) => controls.every((control) => (control as HTMLButtonElement | HTMLSelectElement).disabled));
      expect(disabled).toBe(true);
    }
  });
});

test.describe("Issue 207 · Overview climate projection", () => {
  test.skip(!visualShellEnabled || !overviewEnabled, "Requires the V2 visual shell and Overview V2.");

  test("uses climate controls instead of adjacent quick-device cells", async ({ page }) => {
    await page.goto("/overview?scenario=home-climate-healthy");
    await expect(page.getByTestId("climate-control-overview")).toBeVisible();
    await expect(page.getByTestId("overview-home-cells")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("Issue 179 · ROG G703 PSU controls", () => {
  test.skip(!visualShellEnabled, "Requires the V2 visual shell.");

  test("renders PSU controls without requiring the ROG host service", async ({ page }) => {
    await page.goto("/system?scenario=home-psu-normal");
    await expect(page.getByTestId("rog-psu-controls")).toBeVisible();
    await expect(page.getByTestId("system-rog-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("rog-psu-controls")).toContainText("Обычная мощность · БП 1");
    await expectMinimumControlSize(page.getByTestId("rog-psu-controls").locator("button"));
    await expectNoHorizontalOverflow(page);
  });

  test("shows bounded PSU mode states and disables unavailable actions", async ({ page }) => {
    await page.goto("/system?scenario=home-psu-secondary-only");
    await expect(page.getByTestId("rog-psu-controls")).toContainText("Один БП · БП 2");
    await page.goto("/system?scenario=home-psu-unavailable");
    const unavailable = page.getByTestId("rog-psu-controls");
    await expect(unavailable).toContainText("Состояние питания неизвестно");
    const disabled = await unavailable.locator("button").evaluateAll((controls) => controls.every((control) => (control as HTMLButtonElement).disabled));
    expect(disabled).toBe(true);
  });
});
