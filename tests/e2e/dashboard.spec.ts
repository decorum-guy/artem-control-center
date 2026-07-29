import { expect, test } from "@playwright/test";

test("user overview has product hierarchy without development controls", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByTestId("route-overview")).toBeVisible();
  await expect(page.getByTestId("widget-coffee-machine")).toBeVisible();
  await expect(page.getByTestId("product-header")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Development controls" })).toHaveCount(0);
  await expect(page.getByText("Fixture", { exact: true })).toHaveCount(0);
  await expect(page.getByText("AliceTG Bot", { exact: true })).toHaveCount(0);
  await expect(page.getByText("AVALAR Stage", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("coffee-asset-fallback")).toBeVisible();
});

test("development gallery keeps fixtures and registry mutation tools", async ({ page }) => {
  await page.goto("/dev/widget-gallery");
  await expect(page.getByRole("heading", { name: "Widget gallery" })).toBeVisible();
  await expect(page.getByTestId("mode-badge")).toHaveText("fixtures");
  await page.getByTestId("add-service").click();
  await expect(page.getByText("Discovered Service")).toBeVisible();
  await expect(page.getByText("generic fallback").last()).toBeVisible();

  await page.getByRole("button", { name: "Открыть продукт" }).click();
  await page.getByRole("link", { name: "Сервисы" }).click();
  await expect(page.getByText("Discovered Service")).toBeVisible();
});

test("navigation opens Home and Services without exposing internal gallery", async ({ page }) => {
  await page.goto("/overview");
  const homeLink = page.getByRole("link", { name: "Дом" });
  const box = await homeLink.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
  await homeLink.click();
  await expect(page.getByTestId("route-home")).toBeVisible();
  await expect(page.getByText("AliceTG Bot", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Home Assistant", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Сервисы" }).click();
  await expect(page.getByTestId("route-services")).toBeVisible();
  await expect(page.getByText("AVALAR Stage", { exact: true })).toBeVisible();
  await expect(page.getByText("AliceTG Bot", { exact: true })).toBeVisible();
  await expect(page.getByText("Кофемашина", { exact: true })).toHaveCount(0);
});

test("coffee remains a healthy HA device when Alice timing policy is unavailable", async ({ page }) => {
  await page.goto("/home?scenario=alice-down-ha-healthy");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "ready");
  await expect(page.getByTestId("widget-coffee-machine"))
    .toContainText("свежая cached timing policy");
  await expect(page.getByTestId("widget-coffee-machine")).not.toContainText("Недоступна");
});

test("coffee stages use real timing and never fake progress", async ({ page }) => {
  await page.goto("/overview?scenario=coffee-warming");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "warming");
  await expect(page.getByLabel(/Разогрев/)).toContainText("45%");

  await page.goto("/overview?scenario=coffee-policy-changed");
  await expect(page.getByLabel(/Разогрев/)).toContainText("29%");

  await page.goto("/overview?scenario=coffee-ready");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "ready");
  await expect(page.getByLabel(/Разогрев/)).toHaveCount(0);

  await page.goto("/overview?scenario=coffee-running-too-long");
  await expect(page.getByTestId("widget-coffee-machine"))
    .toHaveAttribute("data-stage", "running_too_long");
  await expect(page.getByTestId("widget-coffee-machine")).toContainText("Работает слишком долго");
  await expect(page.getByTestId("widget-coffee-machine")).not.toContainText("Перегрев");

  await page.goto("/overview?scenario=coffee-no-timing-policy");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "running");
  await expect(page.getByTestId("widget-coffee-machine")).not.toContainText("%");
});

test("HA unavailable and stale timing policy are distinguished", async ({ page }) => {
  await page.goto("/home?scenario=alice-down-policy-stale");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "running");
  await expect(page.getByTestId("widget-coffee-machine")).toContainText("устарели");

  await page.goto("/home?scenario=ha-offline-policy-available");
  await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "unavailable");
  await expect(page.getByTestId("widget-coffee-machine"))
    .toContainText("Home Assistant недоступен");
  await expect(page.getByTestId("widget-coffee-machine")).not.toContainText("%");
});

test("day, night and reduced motion share the same product shell", async ({ page }) => {
  await page.goto("/overview?theme=day&scenario=coffee-warming");
  await expect(page.locator(".app")).toHaveClass(/theme-day/);
  await expect(page.getByTestId("product-header")).toBeVisible();
  await page.getByLabel("Открыть настройки").click();
  await page.getByRole("button", { name: "Ночь" }).click();
  await expect(page.locator(".app")).toHaveClass(/theme-night/);
  await page.getByRole("combobox").selectOption("reduced");
  await expect(page.locator(".app")).toHaveClass(/motion-reduced/);

  await page.goto("/overview?scenario=coffee-warming&motion=reduced");
  await expect(page.locator(".coffee-activity i").first()).toHaveCSS("animation-duration", "0.001s");
});

test("all product routes render intentional non-development states", async ({ page }) => {
  for (const route of [
    "calendar",
    "tasks",
    "backups",
    "apps",
    "settings",
    "system"
  ]) {
    await page.goto(`/${route}`);
    await expect(page.getByTestId(`route-${route}`)).toBeVisible();
    await expect(page.getByText("Fixture", { exact: true })).toHaveCount(0);
  }
});
