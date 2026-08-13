import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";

async function waitForShell(page: Page) {
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("product-header")).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
}

async function expectMinimumTouchTargets(page: Page) {
  const violations = await page.locator(".v2-nav-link, .v2-product-header button").evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 48 && rect.height >= 48
      ? []
      : [{ text: element.textContent?.trim(), width: rect.width, height: rect.height }];
  }));
  expect(violations, JSON.stringify(violations)).toEqual([]);
}

async function readTokens(page: Page, theme: "day" | "night") {
  await page.goto(`/overview?theme=${theme}`);
  await waitForShell(page);
  return page.locator(".app").evaluate((element) => {
    const computed = getComputedStyle(element);
    const names = [
      "--cc-canvas", "--cc-rail", "--cc-surface-1", "--cc-surface-2",
      "--cc-interactive", "--cc-hover", "--cc-pressed", "--cc-border", "--cc-divider",
      "--cc-selected-bg", "--cc-selected-border", "--cc-text", "--cc-text-secondary",
      "--cc-text-muted", "--cc-text-disabled", "--cc-accent", "--cc-accent-strong",
      "--cc-on-accent", "--cc-focus", "--cc-success", "--cc-success-bg", "--cc-success-border",
      "--cc-warning", "--cc-warning-bg", "--cc-warning-border", "--cc-danger", "--cc-danger-bg",
      "--cc-danger-border", "--cc-stale", "--cc-stale-bg", "--cc-stale-border", "--cc-offline",
      "--cc-offline-bg", "--cc-offline-border", "--cc-unavailable", "--cc-unavailable-bg",
      "--cc-unavailable-border", "--cc-uncertain", "--cc-uncertain-bg", "--cc-uncertain-border",
      "--cc-space-1", "--cc-space-5", "--cc-space-9", "--cc-radius-control", "--cc-radius-zone",
      "--cc-motion-press", "--cc-motion-hover", "--cc-motion-reconcile"
    ];
    return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name).trim().toLowerCase()]));
  });
}

test("feature flag false keeps the legacy shell available", async ({ page }) => {
  test.skip(v2Enabled, "The V2 browser run is intentionally opt-in.");
  await page.goto("/overview");
  await expect(page.locator(".product-shell")).toBeVisible();
  await expect(page.getByTestId("v2-shell")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Обзор" })).toBeVisible();
});

test.describe("Control Center V2 shell", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 browser gate.");

  test("uses the canonical 1280x720 shell geometry and 20px route inset", async ({ page }) => {
    await page.goto("/overview");
    await waitForShell(page);
    const rail = await page.getByTestId("v2-navigation-rail").boundingBox();
    const header = await page.getByTestId("product-header").boundingBox();
    const workspace = await page.locator(".v2-workspace").boundingBox();
    const route = await page.locator(".v2-route-content").boundingBox();
    const pageHeading = await page.locator(".v2-route-content .page-heading").boundingBox();

    expect(rail).toMatchObject({ x: 0, y: 0, width: 176, height: 720 });
    expect(header).toMatchObject({ x: 176, y: 0, width: 1104, height: 64 });
    expect(workspace).toMatchObject({ x: 176, y: 0, width: 1104, height: 720 });
    expect(route).toMatchObject({ x: 176, y: 64, width: 1104, height: 656 });
    expect(pageHeading?.x).toBe(196);
    await expectNoDocumentOverflow(page);
  });

  test("renders the grouped icon navigation without unfinished routes or letter avatars", async ({ page }) => {
    await page.goto("/overview");
    await waitForShell(page);
    const navRoutes = await page.locator(".v2-nav-link").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-nav-route")));
    expect(navRoutes).toEqual([
      "/overview", "/weather", "/home", "/services",
      "/calendar", "/tasks", "/reminders", "/system", "/settings"
    ]);
    expect(await page.locator(".v2-nav-link > svg").count()).toBe(navRoutes.length);
    await expect(page.locator(".v2-navigation-primary .v2-nav-group-label")).toHaveText("ПЛАНИРОВАНИЕ");
    await expect(page.locator("nav[aria-label='Планирование'] .v2-nav-link")).toHaveCount(3);
    const reminders = page.locator(".v2-nav-link[data-nav-route='/reminders']");
    await expect(reminders).toContainText("Напоминания");
    expect(await reminders.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
        overflowing: element.scrollWidth > element.clientWidth
      };
    })).toEqual({ overflowWrap: "anywhere", whiteSpace: "normal", overflowing: false });
    await expect(page.locator(".v2-nav-link[data-nav-route='/apps'], .v2-nav-link[data-nav-route='/backups']")).toHaveCount(0);
    await expect(page.locator(".v2-navigation-primary .v2-nav-link--child")).toHaveCount(3);
    await expect(page.locator(".navigation-link__short, .v2-navigation-link__short")).toHaveCount(0);
    await expectMinimumTouchTargets(page);
  });

  test("keeps header data actions and route selection working", async ({ page }) => {
    await page.goto("/overview");
    await waitForShell(page);
    await page.locator(".v2-nav-link[data-nav-route='/tasks']").click();
    await expect(page.getByTestId("route-tasks")).toBeVisible();
    await expect(page.locator(".v2-nav-link[data-nav-route='/tasks']")).toHaveAttribute("aria-current", "page");

    await page.locator(".v2-header-system").click();
    await expect(page.getByTestId("route-system")).toBeVisible();
    await page.locator(".v2-product-header .weather-summary").click();
    await expect(page.getByTestId("route-weather")).toBeVisible();
    await page.locator(".v2-settings-shortcut").click();
    await expect(page.getByTestId("route-settings")).toBeVisible();
    await page.locator(".v2-header-access").click();
    await expect(page.getByTestId("route-settings")).toBeVisible();
  });

  test("preserves direct route contracts for hidden primary routes", async ({ page }) => {
    for (const route of ["/apps", "/backups", "/calendar", "/tasks", "/reminders"]) {
      await page.goto(route);
      await waitForShell(page);
      await expect(page.getByTestId(`route-${route.slice(1)}`)).toBeVisible();
    }
    await expect(page.locator(".v2-nav-link[data-nav-route='/apps'], .v2-nav-link[data-nav-route='/backups']")).toHaveCount(0);
  });

  test("exposes normative day/night tokens, semantic states, and typography", async ({ page }) => {
    const night = await readTokens(page, "night");
    expect(night["--cc-canvas"]).toBe("#0d1213");
    expect(night["--cc-rail"]).toBe("#111819");
    expect(night["--cc-surface-1"]).toBe("#171e1f");
    expect(night["--cc-surface-2"]).toBe("#1e2728");
    expect(night["--cc-accent"]).toBe("#d6a45f");
    expect(night["--cc-text"]).toBe("#f0f4f1");
    const day = await readTokens(page, "day");
    expect(day["--cc-canvas"]).toBe("#e8e9e4");
    expect(day["--cc-rail"]).toBe("#dfe2dc");
    expect(day["--cc-surface-1"]).toBe("#f7f6f1");
    expect(day["--cc-surface-2"]).toBe("#eff0eb");
    expect(day["--cc-accent"]).toBe("#8b5b24");
    expect(day["--cc-text"]).toBe("#1b2927");
    for (const name of [
      "--cc-success", "--cc-warning", "--cc-danger", "--cc-stale", "--cc-offline",
      "--cc-unavailable", "--cc-uncertain", "--cc-focus", "--cc-motion-press"
    ]) {
      expect(night[name], name).not.toBe("");
      expect(day[name], name).not.toBe("");
    }

    await page.goto("/overview");
    await waitForShell(page);
    const typography = await page.locator(".v2-header-time time").evaluate((element) => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight, numerals: style.fontVariantNumeric };
    });
    expect(typography).toEqual({ size: "28px", line: "32px", weight: "700", numerals: "tabular-nums" });
    await expect(page.locator(".v2-route-header h1")).toHaveCSS("font-size", "26px");
    await expect(page.locator(".app")).toHaveCSS("font-family", /Segoe UI Variable Text/);
  });

  test("keeps keyboard focus visible and labels usable at compact effective zoom", async ({ page }) => {
    await page.goto("/tasks");
    await waitForShell(page);
    await page.locator(".v2-nav-link[data-nav-route='/settings']").focus();
    await page.keyboard.press("Tab");
    const focusStyle = await page.locator(":focus").evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset };
    });
    expect(focusStyle).toEqual({ outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "2px" });

    await page.setViewportSize({ width: 640, height: 360 });
    await page.reload();
    await waitForShell(page);
    const header = await page.getByTestId("product-header").boundingBox();
    const rail = await page.getByTestId("v2-navigation-rail").boundingBox();
    const route = await page.locator(".v2-route-content").boundingBox();
    expect(header).toMatchObject({ x: 0, y: 0, width: 640, height: 64 });
    expect(rail).toMatchObject({ x: 0, y: 64, width: 640, height: 48 });
    expect(route?.y).toBe(112);
    await expectNoDocumentOverflow(page);
    const navigation = await page.locator(".v2-navigation-route-bar").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(navigation.scrollWidth).toBeGreaterThan(navigation.clientWidth);
    await expectMinimumTouchTargets(page);
    const routeLabels = await page.locator(".v2-nav-link").evaluateAll((elements) => elements.map((element) => ({
      label: element.textContent?.trim(),
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height
    })));
    expect(routeLabels.every(({ label, width, height }) => Boolean(label) && width >= 48 && height >= 48)).toBeTruthy();
  });

  test("captures canonical V2 screenshot review artifacts", async ({ page }, testInfo) => {
    const artifactDir = process.env.V2_ARTIFACT_DIR ?? testInfo.outputPath("v2-shell-artifacts");
    await mkdir(artifactDir, { recursive: true });
    const capture = async (name: string, route: string) => {
      await page.goto(route);
      await waitForShell(page);
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled" });
    };

    await capture("overview-night.png", "/overview?theme=night");
    await capture("overview-day.png", "/overview?theme=day");
    await capture("weather-night.png", "/weather?theme=night");
    await capture("planning-tasks.png", "/tasks?theme=night");
    await capture("settings.png", "/settings?theme=night");
    await page.setViewportSize({ width: 640, height: 360 });
    await capture("compact-shell.png", "/overview?theme=night");
  });
});
