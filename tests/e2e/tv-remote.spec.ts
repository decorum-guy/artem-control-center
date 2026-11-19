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

async function layout(page: Page, items = [item, coffee],
  portraitItems = [item, { ...coffee, placement: { x: 0, y: 5, w: 7, h: 4 } }]) {
  await page.route(/\/api\/v1\/overview\/layout(?:\/portrait)?$/, async route => {
    const doc = { schemaVersion: "overview.layout.v2", profileId: "samsung-control", presetId: "overview.default",
      presetVersion: 6, revision: 7, viewportClass: "landscape-12", updatedAt: "2026-11-19T12:00:00Z",
      items, warnings: [], unplaced: [], writesEnabled: true };
    const portrait = route.request().url().includes("/layout/portrait");
    await route.fulfill({ json: portrait ? { schemaVersion: "overview.portrait.v1", profile: "portrait",
      layout: { ...doc, items: portraitItems } } : doc });
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
  await shot(page, "portrait-day-unconfirmed");
  expect(commands).toEqual(["volume-up"]);
});

test("mobile PWA link, accent, offline and reconnect", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let status = "connecting";
  await page.route("**/remote/api/status", route => route.fulfill({ json: status === "online" ? online :
    status === "old-offline" ? { availability: "offline" } :
    status === "connecting" ? { availability: "connecting" } : { availability: "offline", connection: "adb-unreachable" } }));
  const commands: unknown[] = [];
  await page.route("**/remote/api/command", async route => {
    commands.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome: "app-open", linkRequested: true, playbackConfirmed: false } });
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  await expect(remote.getByText("Подключение", { exact: true })).toBeVisible();
  await expect(remote.getByText("Ожидаем каталог приложений")).toBeVisible();
  await expect(remote.getByRole("combobox", { name: "Открыть в приложении" })).toBeDisabled();
  await shot(page, "mobile-connecting");
  status = "online";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByText("Экран включён")).toBeVisible();
  for (const control of [remote.getByRole("combobox", { name: "Открыть в приложении" }), page.getByRole("button", { name: /Акцент/ })]) {
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(48);
    expect(bounds?.width).toBeGreaterThanOrEqual(48);
  }
  const canvas = page.locator("html[data-tv-pwa]");
  const nightCanvas = await canvas.evaluate((node) => getComputedStyle(node).backgroundColor);
  await shot(page, "mobile-night");
  await page.getByRole("button", { name: "Дневная тема" }).click();
  await page.getByRole("button", { name: /Акцент ·/ }).click();
  await page.getByRole("option", { name: "Ирис" }).click();
  await expect(page.getByRole("button", { name: /Акцент · Ирис/ })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "iris");
  await expect(canvas).not.toHaveCSS("background-color", nightCanvas);
  await shot(page, "mobile-day");
  await page.getByLabel("Ссылка на телевизор").fill("https://example.org/?a=1&b=2");
  const destination = remote.getByRole("combobox", { name: "Открыть в приложении" });
  await destination.selectOption("browser");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await destination.scrollIntoViewIfNeeded();
  await shot(page, "mobile-native-destination");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByText(/воспроизведение не подтверждено/i)).toBeVisible();
  expect(commands).toEqual([{ action: "open-link", app: "browser", url: "https://example.org/?a=1&b=2" }]);
  status = "tv-offline";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByText("Samsung доступен, ТВ не отвечает")).toBeVisible();
  await expect(remote.getByRole("button", { name: "Вверх" })).toBeDisabled();
  await expect(remote.getByText(/Воспроизведение не подтверждено/)).toHaveCount(0);
  await expect(remote.getByRole("button", { name: "YouTube" })).toBeDisabled();
  await expect(destination).toHaveValue("browser");
  await expect(remote.getByLabel("Ссылка на телевизор")).toHaveValue("https://example.org/?a=1&b=2");
  await shot(page, "mobile-tv-offline");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(remote.getByText("Нет связи с Samsung")).toBeVisible();
  await shot(page, "mobile-samsung-offline");
  status = "old-offline";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByText("Статус ТВ неизвестен")).toBeVisible();
  await expect(remote.getByText("Happ и фильтр ADB · нет данных")).toBeVisible();
  await shot(page, "mobile-legacy-unknown");
  await page.reload();
  await expect(remote.getByText("Статус ТВ неизвестен")).toBeVisible();
  await expect(remote.getByLabel("Ссылка на телевизор")).toHaveValue("https://example.org/?a=1&b=2");
  await expect(destination).toHaveValue("browser");
  status = "online";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByRole("button", { name: "Вверх" })).toBeEnabled();
  await expect(destination).toHaveValue("browser");
  expect(commands).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


test("PWA keyboard, explicit screen commands and authoritative audio", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const commands: string[] = [];
  let volume = 30;
  let muted = false;
  let screen = "on";
  let audioReads = 0;
  let confirmLegacyAudio = false;
  await page.route("**/remote/api/status", async (route) => {
    if (confirmLegacyAudio && ++audioReads === 2) volume = 31;
    await route.fulfill({ json: { ...online, volume, muted, screen } });
  });
  await page.route("**/remote/api/command", async (route) => {
    const action = route.request().postDataJSON().action;
    commands.push(action);
    if (action === "volume-up") confirmLegacyAudio = true;
    if (action === "mute") muted = !muted;
    if (action === "screen-off") screen = "off";
    const outcome = action === "mute" ? { outcome: "confirmed", audio: { volume, muted } } :
      action === "screen-off" ? { outcome: "confirmed", screen } :
      action === "open-link" ? { outcome: "invalid" } : { outcome: "sent" };
    await route.fulfill({ status: action === "open-link" ? 400 : 200, json: outcome });
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  await expect(remote.getByLabel("Подтверждённая громкость")).toHaveText("30");
  const up = remote.getByRole("button", { name: "Вверх" });
  await up.click();
  await expect(up).toBeFocused();
  await expect(up).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => commands).toEqual(["up", "right"]);
  await expect(up).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect.poll(() => commands).toEqual(["up", "right", "up"]);
  await expect(up).toBeEnabled();
  await expect(up).toHaveCSS("outline-width", "3px");
  const url = remote.getByLabel("Ссылка на телевизор");
  await url.fill("https://example.org/wrong-for-youtube");
  await url.press("ArrowLeft");
  expect(commands).toHaveLength(3);
  await remote.getByRole("button", { name: "Отправить" }).click();
  await expect(remote.locator("form").getByRole("status")).toHaveText("Проверьте ссылку и выбранное приложение.");
  await remote.getByRole("button", { name: "Громче" }).click();
  await expect(remote.getByRole("group", { name: "Громкость" })).toHaveAttribute("aria-busy", "true");
  await expect(remote.getByLabel("Подтверждённая громкость")).toHaveText("…");
  await expect(remote.getByLabel("Подтверждённая громкость")).toHaveText("31");
  await remote.getByRole("button", { name: "Выключить звук" }).click();
  await expect(remote.getByRole("button", { name: "Включить звук" })).toBeEnabled();
  expect((await remote.getByRole("button", { name: "Включить звук" }).locator("svg").boundingBox())?.width).toBeGreaterThanOrEqual(16);
  await remote.getByRole("button", { name: "Погасить экран" }).click();
  await expect(remote.getByRole("button", { name: "Включить экран" })).toBeEnabled();
  await expect(remote.getByRole("button", { name: "Погасить экран" })).toHaveCount(0);
  await shot(page, "mobile-reduced-muted-screen-off");
  expect(commands).toEqual(["up", "right", "up", "open-link", "volume-up", "mute", "screen-off"]);
});

const updated = { ...online, minVolume: 0, maxVolume: 100, vpn: false,
  controls: { navigationBatch: true, connectHapp: true } };

test("TV volume commits once, Happ confirms and recent navigation taps keep order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  const commands: unknown[] = [];
  const held: import("@playwright/test").Route[] = [];
  let tv = updated;
  await page.route("**/remote/api/status", route => route.fulfill({ json: tv }));
  await page.route("**/remote/api/command", async route => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.action === "navigate") {
      held.push(route);
      return;
    }
    if (command.action === "volume-set") {
      tv = { ...tv, volume: command.volume };
      await route.fulfill({ json: { outcome: "confirmed", audio: { volume: tv.volume, muted: false } } });
    } else {
      tv = { ...tv, vpn: true };
      await route.fulfill({ json: { outcome: "vpn-connected" } });
    }
  });
  await page.goto("/remote/");
  await page.addStyleTag({ content: "html[data-tv-pwa] #root { --tv-safe-top: 42px; }" });
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  const slider = remote.getByRole("slider", { name: "Громкость" });
  await expect(slider).toBeEnabled();
  const rect = await slider.boundingBox();
  expect(rect?.height).toBeGreaterThanOrEqual(48);
  await expect(slider).toHaveAttribute("aria-valuemax", "100");
  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "31");
  await expect(remote.getByText("Звук подтверждён.")).toBeVisible();
  expect(commands).toEqual([{ action: "volume-set", volume: 31 }]);

  await remote.getByRole("button", { name: "Подключить VPN через Happ" }).click();
  await expect(remote.getByText("VPN Happ подключён.")).toBeVisible();

  const down = remote.getByRole("button", { name: "Вниз" });
  await down.click();
  await expect.poll(() => held.length).toBe(1);
  await expect(down).toBeEnabled();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await held[0].fulfill({ json: { outcome: "sent" } });
  await expect.poll(() => held.length).toBe(2);
  expect(commands).toEqual([
    { action: "volume-set", volume: 31 }, { action: "vpn-connect" },
    { action: "navigate", keys: ["down"] }, { action: "navigate", keys: ["down", "right"] }
  ]);
  await page.keyboard.press("ArrowDown");
  await held[1].fulfill({ status: 503, json: { outcome: "unconfirmed" } });
  await expect(remote.getByText("Результат команды не подтверждён.")).toBeVisible();
  await page.waitForTimeout(100);
  expect(held).toHaveLength(2);

  const canvas = page.locator("html[data-tv-pwa]");
  expect(await canvas.evaluate((html) => getComputedStyle(html, "::before").backgroundImage)).toContain("radial-gradient");
  const app = page.locator(".tv-pwa");
  await app.evaluate((main) => { main.scrollTop = 140; });
  expect(await app.evaluate((main) => main.scrollTop)).toBeGreaterThan(0);
  expect(await app.evaluate((main) => document.elementFromPoint(30, 20)?.closest(".tv-pwa") === null)).toBe(true);
  await app.evaluate((main) => { main.scrollTop = 0; });
  await shot(page, "mobile-rapid-controls");
  await page.getByRole("button", { name: "Дневная тема" }).click();
  await shot(page, "mobile-rapid-controls-day");

  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(remote.getByText("Нет связи с Samsung")).toBeVisible();
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveAttribute("aria-valuetext", "—");
  await expect(remote.getByRole("button", { name: "Подключить VPN через Happ" })).toBeDisabled();
});

test("Samsung live capabilities fit V3 without changing the widget layout", async ({ page }) => {
  await layout(page);
  await page.route("**/api/tv/status", route => route.fulfill({ json: updated }));
  for (const [width, height, orientation] of [[1280, 720, "landscape"], [720, 1280, "portrait"]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["night", "day"]) {
      await page.goto("/overview?theme=" + theme);
      const widget = page.getByTestId("television-widget");
      await expect(widget.getByRole("slider", { name: "Громкость" })).toBeVisible();
      await shot(page, orientation + "-" + theme + "-rapid-card");
      await widget.getByRole("button", { name: "Полный пульт" }).click();
      await expect(page.getByRole("region", { name: "Управление телевизором" }).getByRole("button",
        { name: /Открыть в приложении/ })).toBeEnabled();
      await shot(page, orientation + "-" + theme + "-rapid-sheet");
    }
  }
});

test("compact TV lines up with the kettle and exposes the quick actions", async ({ page }) => {
  const compactTV = { ...item, sizeVariant: "detail", placement: { x: 0, y: 3, w: 7, h: 3 } };
  const kettle = { ...item, instanceId: "owner.kettle", widgetType: "home.kettle", sizeVariant: "detail",
    placement: { x: 0, y: 0, w: 7, h: 3 } };
  await layout(page, [kettle, compactTV], [kettle, compactTV]);
  let status = { ...updated, maintenance: { happ: "not-needed" } };
  const commands: unknown[] = [];
  await page.route("**/api/tv/status", route => route.fulfill({ json: status }));
  await page.route("**/api/tv/command", async route => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.action === "vpn-connect") {
      status = { ...status, vpn: true, maintenance: { happ: "verified" } };
      await route.fulfill({ json: { outcome: "vpn-connected" } });
    } else {
      await route.fulfill({ json: { outcome: "app-open" } });
    }
  });
  for (const [width, height, orientation] of [[1280, 720, "landscape"], [720, 1280, "portrait"]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["night", "day"]) {
      await page.goto("/overview?theme=" + theme);
      const widget = page.getByTestId("television-widget");
      const kettleCard = page.locator('[data-instance-id="owner.kettle"]');
      const slider = widget.getByRole("slider", { name: "Громкость" });
      await expect(slider).toBeEnabled();
      const unit = (await widget.boundingBox())!;
      const other = (await kettleCard.boundingBox())!;
      const [icon, screen, audio, remote] = await Promise.all([
        widget.locator(".tv-widget-title svg").boundingBox(),
        widget.getByText("Экран включён", { exact: true }).boundingBox(),
        widget.locator(".cc-slider-copy > span").boundingBox(),
        widget.getByRole("button", { name: "Полный пульт" }).boundingBox()
      ]);
      expect(Math.abs(unit.x - other.x)).toBeLessThan(1);
      expect(Math.abs(unit.width - other.width)).toBeLessThan(1);
      expect(Math.abs(unit.y - (other.y + other.height) - 12)).toBeLessThan(1);
      expect(Math.abs(screen!.x - icon!.x)).toBeLessThan(1);
      expect(Math.abs(audio!.x - icon!.x)).toBeLessThan(1);
      expect(remote!.y + remote!.height).toBeLessThanOrEqual(unit.y + unit.height);
      if (!commands.length) {
        await expect(widget.getByText("Туннель отключён", { exact: true })).toBeVisible();
        await widget.getByRole("button", { name: "Яндекс Браузер" }).click();
        await expect(widget.getByText("Приложение открыто.")).toBeVisible();
        await widget.getByRole("button", { name: "Подключить VPN через Happ" }).click();
      }
      await expect(widget.getByText("Happ подключён", { exact: true })).toBeVisible();
      await widget.scrollIntoViewIfNeeded();
      await shot(page, orientation + "-" + theme + "-compact-kettle-and-tv");
      await widget.getByRole("button", { name: "Полный пульт" }).click();
      const remotePanel = page.getByRole("region", { name: "Управление телевизором" });
      await expect(remotePanel.getByRole("slider", { name: "Громкость" })).toBeEnabled();
      await expect(remotePanel.getByRole("button", { name: "Подключить VPN через Happ" })).toBeEnabled();
    }
  }
  expect(commands).toEqual([{ action: "open-app", app: "browser" }, { action: "vpn-connect" }]);
});
