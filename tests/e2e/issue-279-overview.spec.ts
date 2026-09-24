import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true"
  && process.env.VITE_OVERVIEW_V2_ENABLED === "true";
test.skip(!enabled, "Run with the V2 shell and Overview enabled.");

async function overview(page: Page, scenario: string, theme: "day" | "night" = "night") {
  await page.goto(`/overview?scenario=${scenario}&theme=${theme}`);
  await expect(page.getByTestId("route-overview-v2")).toBeVisible();
  const coffee = page.getByTestId("widget-coffee-machine");
  await expect(coffee).toBeVisible();
  return coffee;
}

async function contained(container: Locator, selectors: string[]) {
  const outer = await container.boundingBox();
  expect(outer).not.toBeNull();
  for (const selector of selectors) {
    const control = container.locator(selector);
    const box = await control.boundingBox();
    expect(box, selector).not.toBeNull();
    expect(box!.width, selector).toBeGreaterThanOrEqual(48);
    expect(box!.height, selector).toBeGreaterThanOrEqual(48);
    expect(box!.x, selector).toBeGreaterThanOrEqual(outer!.x - 1);
    expect(box!.y, selector).toBeGreaterThanOrEqual(outer!.y - 1);
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
    expect(box!.y + box!.height, selector).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
  }
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test("maps the contour to confirmed live ON and keeps warning distinct", async ({ page }) => {
  test.setTimeout(120_000);
  const cases = [
    ["coffee-off", "off", "off", false],
    ["coffee-turning-on", "turning_on", "turning_on", false],
    ["coffee-warming", "warming", "on", true],
    ["coffee-ready", "ready", "on", true],
    ["coffee-running", "running", "on", true],
    ["coffee-running-too-long", "running_too_long", "on", true],
    ["coffee-stale", "stale", "stale", false],
    ["coffee-turning-off", "turning_off", "turning_off", false],
    ["ha-offline-policy-available", "unavailable", "unavailable", false]
  ] as const;
  let readyShadow = "";
  let warningShadow = "";

  for (const [scenario, stage, canonical, active] of cases) {
    const coffee = await overview(page, scenario);
    await expect(coffee).toHaveAttribute("data-stage", stage);
    await expect(coffee).toHaveAttribute("data-canonical-state", canonical);
    await expect(coffee).toHaveAttribute("data-coffee-active", String(active));
    const style = await coffee.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { shadow: computed.boxShadow, animation: computed.animationName, borderLeft: computed.borderLeftWidth };
    });
    expect(style.shadow === "none", scenario).toBe(!active);
    expect(style.animation, scenario).toBe("none");
    if (stage === "ready") readyShadow = style.shadow;
    if (stage === "running_too_long") {
      warningShadow = style.shadow;
      await expect(coffee).toHaveClass(/surface--warning/);
      expect(parseFloat(style.borderLeft)).toBeGreaterThanOrEqual(3);
    }
    await noHorizontalOverflow(page);
  }
  expect(warningShadow).not.toBe(readyShadow);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await overview(page, "coffee-ready");
  await expect(reduced).toHaveAttribute("data-coffee-active", "true");
  await expect(reduced).toHaveCSS("transition-duration", /0\.001s/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/overview?scenario=coffee-ready&theme=night&motion=reduced");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-coffee-active", "true");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveCSS("transition-duration", /0\.001s/);
});

test("captures Overview day/night review states with contained controls", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const artifactDir = process.env.ISSUE_279_OVERVIEW_ARTIFACT_DIR ?? testInfo.outputPath("issue-279-overview-review");
  await mkdir(artifactDir, { recursive: true });
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5);

  const states = [
    ["day", "coffee-off", "overview-day-coffee-off.png"],
    ["day", "coffee-warming", "overview-day-coffee-active.png"],
    ["night", "coffee-off", "overview-night-coffee-off.png"],
    ["night", "coffee-ready", "overview-night-coffee-active.png"],
    ["night", "coffee-running-too-long", "overview-night-coffee-warning.png"],
    ["night", "coffee-stale", "overview-night-coffee-stale.png"]
  ] as const;

  for (const [theme, scenario, filename] of states) {
    const coffee = await overview(page, scenario, theme);
    await expect(coffee.locator(".coffee-asset__image")).toBeVisible();
    await expect.poll(() => coffee.locator(".coffee-asset__image").evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    })).toBe(true);
    const asset = await coffee.locator(".coffee-asset").boundingBox();
    const image = await coffee.locator(".coffee-asset__image").boundingBox();
    const status = await coffee.locator(".coffee-panel__status").boundingBox();
    expect(asset).not.toBeNull();
    expect(image).not.toBeNull();
    expect(status).not.toBeNull();
    expect(image!.x).toBeGreaterThanOrEqual(asset!.x - 1);
    expect(image!.x + image!.width).toBeLessThanOrEqual(asset!.x + asset!.width + 1);
    expect(image!.y + image!.height).toBeLessThanOrEqual(asset!.y + asset!.height + 1);
    expect(image!.y).toBeGreaterThanOrEqual(status!.y + status!.height - 1);
    await contained(coffee, ["[data-coffee-action]"]);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: path.join(artifactDir, filename), animations: "disabled" });
  }

  const off = await overview(page, "coffee-off");
  const timer = off.getByTestId("coffee-delayed-start-action");
  await expect(timer).toHaveAttribute("aria-label", /Отложить|отложенный/i);
  await expect(timer.locator("svg")).toHaveCount(1);
  expect((await timer.textContent())?.trim()).toBe("");
  await contained(off, ["[data-coffee-action]", '[data-testid="coffee-delayed-start-action"]']);

  await overview(page, "coffee-off");
  const planning = page.getByTestId("planning-overview-card");
  await expect(planning).toHaveAttribute("data-visible-item-count", "3");
  await page.screenshot({ path: path.join(artifactDir, "overview-night-planning-three-items.png"), animations: "disabled" });

  await overview(page, "ha-degraded");
  const health = page.getByTestId("overview-health-widget");
  await expect(health.locator(".overview-health-widget__incident")).toBeVisible();
  await expect(health).toContainText("Backup");
  await expect(health.getByTestId("overview-health-recovery-unavailable")).toBeVisible();
  await expect(health.getByTestId("overview-health-recovery")).toHaveCount(0);
  await page.screenshot({ path: path.join(artifactDir, "overview-night-service-attention.png"), animations: "disabled" });

  await page.route("**/api/v1/actions/home-assistant/availability", async (route) => {
    const decision = {
      capability: "home_climate_actions", minimumProfile: "standard", effectiveProfile: "standard",
      allowed: true, availability: "allowed", gateEnabled: true, integrationAvailable: true,
      busy: false, preconditionOk: true
    };
    const actions = Object.fromEntries([
      "home.climate.power_on", "home.climate.power_off", "home.climate.set_temperature",
      "home.climate.set_mode", "home.climate.set_fan_mode"
    ].map((id) => [id, decision]));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, actions }) });
  });
  await overview(page, "home-climate-healthy");
  const climate = page.getByTestId("climate-control-overview");
  await expect(climate).toBeVisible();
  await expect(climate).toHaveCSS("border-top-width", "0px");
  await expect(climate.getByTestId("climate-temperature-decrease-overview")).toBeEnabled();
  await expect(climate.locator(".climate-control__mode-label select")).toBeEnabled();
  await contained(climate, [
    '[data-testid="climate-power-overview"]',
    '[data-testid="climate-temperature-decrease-overview"]',
    '[data-testid="climate-temperature-increase-overview"]',
    '[data-testid="climate-temperature-confirm-overview"]',
    ".climate-control__mode-label select",
    ".climate-control__fan-label select"
  ]);
  await climate.screenshot({ path: path.join(artifactDir, "overview-night-climate-available.png"), animations: "disabled" });
  await noHorizontalOverflow(page);
});

test("keeps three overdue tasks distinct in a dense Planning review state", async ({ page }, testInfo) => {
  const artifactDir = process.env.ISSUE_279_OVERVIEW_ARTIFACT_DIR ?? testInfo.outputPath("issue-279-overview-review");
  await mkdir(artifactDir, { recursive: true });
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as {
      planning?: {
        reminders: { upcoming: unknown[] };
        tasks: { overdue: Array<Record<string, unknown>> };
        calendar: { today: unknown[]; upcoming: unknown[] };
      } | null;
    };
    const task = snapshot.planning?.tasks.overdue[0];
    if (snapshot.planning && task) {
      snapshot.planning.reminders.upcoming = [];
      snapshot.planning.calendar.today = [];
      snapshot.planning.calendar.upcoming = [];
      snapshot.planning.tasks.overdue = [
        { ...task, id: "00000000-0000-4000-8000-000000000101", title: "Проверить резервную копию" },
        { ...task, id: "00000000-0000-4000-8000-000000000102", title: "Подготовить документы для встречи" },
        { ...task, id: "00000000-0000-4000-8000-000000000103", title: "Длинная русская задача, которая занимает две строки в карточке дел" }
      ];
    }
    await route.fulfill({ response, body: JSON.stringify(snapshot) });
  });

  await overview(page, "coffee-off");
  const planning = page.getByTestId("planning-overview-card");
  await expect(planning.locator(".planning-row--interactive")).toHaveCount(3);
  await expect(planning.locator(".planning-row--next")).toHaveCount(1);
  await expect(planning.locator(".planning-row__label").filter({ hasText: "Просрочено: 3" })).toHaveCount(1);
  await expect(planning).toContainText("Проверить резервную копию");
  await expect(planning).toContainText("Подготовить документы для встречи");
  await expect(planning).toContainText("Длинная русская задача");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(artifactDir, "overview-night-planning-dense-overdue.png"), animations: "disabled" });
});
