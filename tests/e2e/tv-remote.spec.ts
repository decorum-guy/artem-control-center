import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.TV_REVIEW_DIR || "artifacts/tv-control-review";
const online = { availability: "online", screen: "on", vpn: true, volume: 30, muted: false,
  apps: [{ id: "youtube", label: "YouTube", links: true }, { id: "browser", label: "Яндекс Браузер", links: true }] };
const item = { instanceId: "owner.television", widgetType: "home.television", visibility: "visible",
  placement: { x: 0, y: 1, w: 5, h: 4 }, sizeVariant: "standard", config: {} };
const coffee = { instanceId: "owner.coffee", widgetType: "home.coffee-machine", visibility: "visible",
  placement: { x: 5, y: 1, w: 7, h: 4 }, sizeVariant: "standard", config: {} };

async function layout(page: Page) {
  await page.route(/\/api\/v1\/overview\/layout(?:\/portrait)?$/, async route => {
    const doc = { schemaVersion: "overview.layout.v2", profileId: "samsung-control", presetId: "overview.default",
      presetVersion: 6, revision: 7, viewportClass: "landscape-12", updatedAt: "2026-11-19T12:00:00Z",
      items: [item, coffee], warnings: [], unplaced: [], writesEnabled: true };
    const portrait = route.request().url().includes("/layout/portrait");
    await route.fulfill({ json: portrait ? { schemaVersion: "overview.portrait.v1", profile: "portrait",
      layout: { ...doc, items: [item, { ...coffee, placement: { x: 0, y: 5, w: 7, h: 4 } }] } } : doc });
  });
}
async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name + ".png"), fullPage: true, animations: "disabled" });
}

test("Samsung TV registry, day/night layouts and full remote", async ({ page }) => {
  await layout(page);
  await page.route("**/api/tv/status", route => route.fulfill({ json: online }));
  const commands: string[] = [];
  await page.route("**/api/tv/command", async route => {
    commands.push(route.request().postDataJSON().action);
    await route.fulfill({ status: 503, json: { outcome: "unconfirmed" } });
  });
  // Keep coverage independent of the production updater or other fixture profiles.
  for (const [width, height, name] of [[1280, 720, "landscape"], [720, 1280, "portrait"]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["night", "day"]) {
      await page.goto("/overview?theme=" + theme);
      const widget = page.getByTestId("television-widget");
      await expect(widget.getByText("Экран включён")).toBeVisible();
      await expect(widget).toHaveCSS("display", "grid");
      const heading = await widget.getByRole("heading", { name: "Телевизор" }).boundingBox();
      expect(heading?.height).toBeLessThan(35);
      await expect(widget.getByRole("button", { name: "Погасить экран" })).toBeEnabled();
      const physical = await widget.getByRole("button", { name: "Тише" }).boundingBox();
      expect(physical?.height).toBeGreaterThanOrEqual(48);
      expect(physical?.width).toBeGreaterThanOrEqual(48);
      await shot(page, name + "-" + theme);
      await widget.getByRole("button", { name: "Полный пульт" }).click();
      await expect(page.getByRole("region", { name: "Управление телевизором" })).toBeVisible();
      await shot(page, name + "-" + theme + "-remote");
    }
  }
  await page.getByRole("region", { name: "Управление телевизором" }).getByRole("button", { name: "Громче" }).click();
  await expect(page.getByText("Результат команды не подтверждён.")).toBeVisible();
  expect(commands).toEqual(["volume-up"]);
});

test("mobile PWA link, accent, offline and reconnect", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let connected = true;
  await page.route("**/remote/api/status", route => route.fulfill({ json: connected ? online : { availability: "offline" } }));
  const commands: unknown[] = [];
  await page.route("**/remote/api/command", async route => {
    commands.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome: "app-open", linkRequested: true, playbackConfirmed: false } });
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  await expect(remote.getByText("Экран включён")).toBeVisible();
  const canvas = page.locator("main.tv-pwa");
  const nightCanvas = await canvas.evaluate((node) => getComputedStyle(node).backgroundColor);
  await shot(page, "mobile-night");
  await page.getByRole("button", { name: "Дневная тема" }).click();
  await page.getByLabel("Акцент").selectOption("iris");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "iris");
  await expect(canvas).not.toHaveCSS("background-color", nightCanvas);
  await shot(page, "mobile-day");
  await page.getByLabel("Ссылка на телевизор").fill("https://example.org/?a=1&b=2");
  await page.getByLabel("Открыть в приложении").selectOption("browser");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByText(/воспроизведение не подтверждено/)).toBeVisible();
  expect(commands).toEqual([{ action: "open-link", app: "browser", url: "https://example.org/?a=1&b=2" }]);
  connected = false;
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(remote.getByText("Нет связи с ТВ")).toBeVisible();
  await expect(remote.getByRole("button", { name: "Вверх" })).toBeDisabled();
  await shot(page, "mobile-offline");
  connected = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByRole("button", { name: "Вверх" })).toBeEnabled();
  expect(commands).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
