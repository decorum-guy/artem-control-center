import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const foundationEnabled = process.env.VITE_V2_VISUAL_SHELL === "true"
  && process.env.VITE_OVERVIEW_V2_ENABLED === "true"
  && process.env.B3_PLANNING_CALENDAR_ROUTE_ENABLED === "true";

test.skip(!foundationEnabled, "Run with the V2 shell, Overview and Calendar routes enabled.");

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => parseInt(value, 16) / 255) ?? [];
    const linear = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

async function waitForRoute(page: Page, route: "overview" | "calendar" | "settings") {
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId(route === "overview" ? "route-overview-v2" : `route-${route}`)).toBeVisible();
}

test("keeps the 64px header, stronger time/date and complete touch controls", async ({ page }) => {
  await page.goto("/overview?theme=day");
  await waitForRoute(page, "overview");

  const header = page.getByTestId("product-header");
  const headerBox = await header.boundingBox();
  expect(headerBox?.height).toBe(64);
  await expect(page.locator(".v2-header-time time")).toHaveCSS("font-size", "36px");
  await expect(page.locator(".v2-header-time time")).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(page.locator(".v2-header-time > span")).toHaveCSS("font-size", "14px");
  await expect(page.locator(".v2-header-time > span")).toHaveCSS("color", "rgb(77, 94, 90)");

  for (const selector of [
    ".v2-product-header .weather-summary",
    ".v2-header-system",
    ".v2-header-access",
    ".v2-settings-shortcut"
  ]) {
    const control = page.locator(selector);
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.width, selector).toBeGreaterThanOrEqual(48);
    expect(box?.height, selector).toBeGreaterThanOrEqual(48);
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  const colors = await page.locator(".app").evaluate((element) => {
    const style = getComputedStyle(element);
    return ["--cc-text-muted", "--cc-canvas", "--cc-surface-1"].map((name) => style.getPropertyValue(name).trim());
  });
  expect(contrastRatio(colors[0], colors[1])).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors[0], colors[2])).toBeGreaterThanOrEqual(4.5);
});

test("OS reduced motion overrides Full and preserves Sheet focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings?theme=night&motion=full");
  await waitForRoute(page, "settings");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await expect(page.locator(".v2-route-content")).toHaveCSS("animation-duration", "0.001s");

  const opener = page.getByTestId("settings-summary-access");
  await opener.click();
  const sheet = page.getByTestId("settings-access-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS("animation-name", "none");
  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/settings?theme=night&motion=reduced");
  await waitForRoute(page, "settings");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.getByTestId("settings-summary-access").click();
  await expect(page.getByTestId("settings-access-sheet")).toHaveCSS("animation-name", "none");
});

test("captures the Slice 1 review matrix at 1280x720 and DPR 1.5 without console errors", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const artifactDir = process.env.ISSUE_279_ARTIFACT_DIR ?? testInfo.outputPath("issue-279-foundation-review");
  await mkdir(artifactDir, { recursive: true });
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5);

  const errors: string[] = [];
  // The fixture backend intentionally omits these optional availability endpoints.
  const expectedFixture404 = new Set([
    "/api/v1/actions/system/connectivity/availability",
    "/api/v1/actions/avalar/availability",
    "/api/v1/actions/home-assistant/availability",
    "/api/v1/access"
  ]);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (location
      && expectedFixture404.has(new URL(location).pathname)
      && message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)") return;
    errors.push(`${message.text()} @ ${location}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400
      && !(response.status() === 404 && expectedFixture404.has(new URL(response.url()).pathname))) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });

  for (const route of ["overview", "calendar", "settings"] as const) {
    for (const theme of ["day", "night"] as const) {
      await page.goto(`/${route}?theme=${theme}&motion=full`);
      await waitForRoute(page, route);
      await page.screenshot({ path: path.join(artifactDir, `${route}-${theme}.png`), animations: "disabled" });
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/overview?theme=night&motion=full");
  await waitForRoute(page, "overview");
  await page.screenshot({ path: path.join(artifactDir, "overview-night-os-reduced-motion.png"), animations: "disabled" });

  expect([...new Set(errors)]).toEqual([]);
});
