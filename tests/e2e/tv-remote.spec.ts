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
      // Chromium can report a 48px target as 47.99997px after transforms.
      expect(physical?.height).toBeGreaterThanOrEqual(47.99);
      expect(physical?.width).toBeGreaterThanOrEqual(47.99);
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
  await expect(remote.getByText("VPN включён", { exact: true })).toBeVisible();
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
  await expect(remote.getByText("Статус VPN неизвестен", { exact: true })).toBeVisible();
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
  await expect(remote.getByText("Статус VPN неизвестен", { exact: true })).toBeVisible();
  await expect(remote.getByText("Фильтр ADB · нет данных", { exact: true })).toBeVisible();
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

test("PWA keeps Happ visible on a cold start while the TV is unreachable", async ({ page }) => {
  const { controls, apps } = updated;
  let status: object = { availability: "connecting", controls, apps };
  const commands: unknown[] = [];
  await page.route("**/remote/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/remote/api/command", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { outcome: "vpn-already-connected" } });
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  const happ = remote.getByRole("button", { name: "Подключить VPN через Happ" });
  await expect(remote.getByRole("button", { name: "YouTube" })).toBeDisabled();
  await expect(happ).toBeVisible();
  await expect(happ).toBeDisabled();
  await expect(remote.getByText("Статус VPN неизвестен", { exact: true })).toBeVisible();

  status = { availability: "offline", connection: "adb-unreachable" };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByText("Samsung доступен, ТВ не отвечает")).toBeVisible();
  await expect(happ).toBeVisible();
  await expect(happ).toBeDisabled();
  expect(commands).toEqual([]);

  status = { ...updated, vpn: true };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(happ).toBeEnabled();
  await expect(remote.getByText("VPN включён", { exact: true })).toBeVisible();
  expect(commands).toEqual([]);

  status = { ...updated, controls: { navigationBatch: true, connectHapp: false } };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(remote.getByText("VPN выключен", { exact: true })).toBeVisible();
  await expect(happ).toHaveCount(0);
});

test("PWA fits a normal phone viewport and requires confirmation to sign out", async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 879 });
  let signedIn = true;
  let logouts = 0;
  await page.route("**/remote/api/status", (route) => signedIn ? route.fulfill({ json: updated }) : route.fulfill({ status: 401 }));
  await page.route("**/remote/api/logout", async (route) => {
    logouts++;
    signedIn = false;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/remote/");
  await page.addStyleTag({ content: "html[data-tv-pwa] #root { --tv-safe-top: 42px; --tv-safe-bottom: 34px; }" });
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  await expect(remote.getByText("VPN выключен", { exact: true })).toBeVisible();
  const shell = page.locator(".tv-pwa");
  const accent = page.getByRole("button", { name: /Акцент ·/ });
  const theme = page.getByRole("button", { name: "Дневная тема" });
  const exit = page.getByRole("button", { name: "Выйти", exact: true });
  const overflow = () => shell.evaluate((main) => main.scrollHeight - main.clientHeight);

  for (const viewport of [{ width: 428, height: 879 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(overflow).toBeLessThanOrEqual(1);
    const accentBox = (await accent.boundingBox())!;
    const themeBox = (await theme.boundingBox())!;
    expect(accentBox.x + accentBox.width).toBeLessThan(themeBox.x);
    expect(accentBox.y).toBe(themeBox.y);
    for (const control of [accent, theme, exit, remote.getByRole("button", { name: "Вставить ссылку" })]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
      await expect.poll(async () => {
        const settled = await control.boundingBox();
        return settled ? settled.y + settled.height : Infinity;
      }).toBeLessThanOrEqual(viewport.height - 34);
    }
  }
  await shot(page, "mobile-compact-remote-night");
  await theme.click();
  await shot(page, "mobile-compact-remote-day");
  await remote.getByLabel("Ссылка на телевизор").fill("https://example.org/pwa");
  const send = remote.getByRole("button", { name: "Отправить" });
  await page.setViewportSize({ width: 390, height: 480 });
  await expect.poll(overflow).toBeGreaterThan(0);
  await send.scrollIntoViewIfNeeded();
  expect((await send.boundingBox())!.y).toBeLessThan(480 - 48);
  await page.setViewportSize({ width: 390, height: 844 });

  await exit.click();
  const confirmation = page.getByRole("dialog", { name: "Выйти из пульта?" });
  await expect(confirmation).toBeVisible();
  expect(logouts).toBe(0);
  await confirmation.getByRole("button", { name: "Отмена" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(exit).toBeFocused();
  await expect(remote.getByLabel("Ссылка на телевизор")).toHaveValue("https://example.org/pwa");
  expect(logouts).toBe(0);
  await exit.click();
  await confirmation.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByLabel("Код подключения")).toBeVisible();
  expect(logouts).toBe(1);
});

test("PWA clipboard icon pastes a link only on demand and never sends it", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => {
        const data = document.documentElement.dataset;
        data.clipboardReads = String(Number(data.clipboardReads ?? 0) + 1);
        if (data.clipboardDenied) throw new DOMException("Denied", "NotAllowedError");
        return data.clipboardText ?? "";
      } },
    });
  });
  const commands: unknown[] = [];
  await page.route("**/remote/api/status", (route) => route.fulfill({ json: updated }));
  await page.route("**/remote/api/command", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { outcome: "app-open" } });
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  const input = remote.getByLabel("Ссылка на телевизор");
  const paste = remote.getByRole("button", { name: "Вставить ссылку" });
  const formStatus = remote.locator("form").getByRole("status");
  const target = remote.getByRole("combobox", { name: "Открыть в приложении" });
  const canvas = page.locator("html");
  await expect(paste.locator("svg")).toHaveCount(1);
  await expect(paste).toHaveText("");
  expect((await paste.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  expect((await paste.boundingBox())!.width).toBeGreaterThanOrEqual(48);
  expect(await canvas.getAttribute("data-clipboard-reads")).toBeNull();
  await target.selectOption("browser");

  const link = "https://example.org/clipboard?x=1&y=2";
  await canvas.evaluate((html, copied) => { html.dataset.clipboardText = "  " + copied + "  "; }, link);
  await paste.click();
  await expect(input).toHaveValue(link);
  await expect(target).toHaveValue("browser");
  await expect(canvas).toHaveAttribute("data-clipboard-reads", "1");
  expect(commands).toEqual([]);
  await shot(page, "mobile-paste-icon-night");
  await page.getByRole("button", { name: "Дневная тема" }).click();
  await paste.scrollIntoViewIfNeeded();
  await shot(page, "mobile-paste-icon-day");

  await canvas.evaluate((html) => { html.dataset.clipboardText = "not a link"; });
  await paste.click();
  await expect(formStatus).toContainText("Скопируйте ссылку HTTP или HTTPS");
  await expect(input).toHaveValue(link);
  await canvas.evaluate((html) => { html.dataset.clipboardDenied = "true"; });
  await paste.click();
  await expect(formStatus).toHaveText("Удерживайте поле ссылки и выберите «Вставить».");
  await expect(input).toHaveValue(link);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await paste.click();
  await expect(formStatus).toHaveText("Удерживайте поле ссылки и выберите «Вставить».");
  expect(commands).toEqual([]);

  await remote.getByRole("button", { name: "Отправить" }).click();
  await expect.poll(() => commands).toEqual([{ action: "open-link", app: "browser", url: link }]);
});

async function navigationFixture(page: Page) {
  const commands: { keys: string[] }[] = [];
  const held: import("@playwright/test").Route[] = [];
  let connected = true;
  await page.route("**/remote/api/status", route => connected ? route.fulfill({ json: updated }) : route.abort());
  await page.route("**/remote/api/command", route => {
    commands.push(route.request().postDataJSON());
    held.push(route);
  });
  await page.goto("/remote/");
  const remote = page.getByRole("region", { name: "Управление телевизором" });
  const right = remote.getByRole("button", { name: "Вправо" });
  await expect(right).toBeEnabled();
  await page.clock.install({ time: new Date("2026-11-20T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-20T00:00:02Z"));
  await right.evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); });
  await page.clock.runFor(140);
  await expect.poll(() => held.length).toBe(1);
  return { remote, commands, held, setConnected: (value: boolean) => { connected = value; } };
}

test("slow successful navigation preserves a repeated key and a different key", async ({ page }) => {
  const { commands, held } = await navigationFixture(page);
  await page.clock.runFor(210);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.clock.runFor(1850);
  await held[0].fulfill({ json: { outcome: "sent" } });
  await page.clock.runFor(50);
  await expect.poll(() => commands.map(command => command.keys)).toEqual([["right"], ["right", "down"]]);
  await held[1].fulfill({ json: { outcome: "sent" } });
});

test("navigation overflow is explicit and waiting taps expire without replay", async ({ page }) => {
  const { commands, held, remote } = await navigationFixture(page);
  for (let index = 0; index < 9; index++) await page.keyboard.press("ArrowRight");
  await expect(remote.getByText("Очередь заполнена. Нажатие не принято.")).toBeVisible();
  await page.clock.runFor(5100);
  await expect(remote.getByText("Время ожидания истекло. Нажатия сброшены.")).toBeVisible();
  await held[0].fulfill({ json: { outcome: "sent" } });
  await page.clock.runFor(300);
  await expect(remote.getByText("Время ожидания истекло. Нажатия сброшены.")).toBeVisible();
  expect(commands.map(command => command.keys)).toEqual([["right"]]);
});

test("a 3.3 second acknowledgement releases exactly the eight accepted taps", async ({ page }) => {
  const { commands, held, remote } = await navigationFixture(page);
  for (let index = 0; index < 9; index++) await page.keyboard.press("ArrowDown");
  await expect(remote.getByText("Очередь заполнена. Нажатие не принято.")).toBeVisible();
  await page.clock.runFor(3300);
  await held[0].fulfill({ json: { outcome: "sent" } });
  await expect.poll(() => commands.map(command => command.keys)).toEqual([["right"], Array(8).fill("down")]);
  await held[1].fulfill({ json: { outcome: "sent" } });
});

test("an uncertain navigation result drops waiting taps with feedback", async ({ page }) => {
  const { remote, commands, held } = await navigationFixture(page);
  await page.keyboard.press("ArrowDown");
  await held[0].fulfill({ status: 503, json: { outcome: "unconfirmed" } });
  await expect(remote.getByText("Результат команды не подтверждён.")).toBeVisible();
  await expect(remote.getByText("Ожидавшие нажатия сброшены.")).toBeVisible();
  await page.clock.runFor(300);
  expect(commands.map(command => command.keys)).toEqual([["right"]]);
});

for (const interrupt of ["offline", "hidden", "session"] as const) {
  test(`navigation discards waiting taps across ${interrupt}`, async ({ page }) => {
    const { remote, commands, held, setConnected } = await navigationFixture(page);
    const right = remote.getByRole("button", { name: "Вправо" });
    await page.keyboard.press("ArrowDown");
    if (interrupt === "offline") {
      setConnected(false);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(remote.getByText("Нет связи с Samsung")).toBeVisible();
      setConnected(true);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(right).toBeEnabled();
      await expect(remote.getByText("Ожидавшие нажатия сброшены.")).toBeVisible();
      await right.evaluate((button: HTMLButtonElement) => button.click());
      await expect(remote.getByText("ТВ занят. Нажатие не принято.")).toBeVisible();
      await held[0].fulfill({ json: { outcome: "sent" } });
    } else if (interrupt === "hidden") {
      const changeVisibility = (visibility: string) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      await page.evaluate(changeVisibility, "hidden");
      await expect(right).toBeDisabled();
      await held[0].fulfill({ json: { outcome: "sent" } });
      await page.evaluate(changeVisibility, "visible");
    } else {
      await held[0].fulfill({ status: 401, json: { outcome: "invalid" } });
      await expect(page.getByText("Код подключения")).toBeVisible();
      await page.route("**/remote/api/login", route => route.fulfill({ json: { ok: true } }));
      await page.getByLabel("Код подключения").fill("fixture-code");
      await page.getByRole("button", { name: "Подключить пульт" })
        .evaluate((button: HTMLButtonElement) => button.click());
    }
    await expect(right).toBeEnabled();
    if (interrupt !== "offline") await expect(remote.getByText("Ожидавшие нажатия сброшены.")).toBeVisible();
    await page.clock.runFor(700);
    expect(commands.map(command => command.keys)).toEqual([["right"]]);
    await right.evaluate((button: HTMLButtonElement) => button.click());
    await page.clock.runFor(140);
    await expect.poll(() => commands.map(command => command.keys)).toEqual([["right"], ["right"]]);
    await held[1].fulfill({ json: { outcome: "sent" } });
  });
}

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
  await page.addStyleTag({ content: "html[data-tv-pwa] #root { --tv-safe-top: 42px; --tv-safe-bottom: 34px; }" });
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

  await expect(remote.getByText("VPN выключен", { exact: true })).toBeVisible();
  await remote.getByRole("button", { name: "Подключить VPN через Happ" }).click();
  await expect(remote.getByText("VPN включён.", { exact: true })).toBeVisible();
  await expect(remote.getByText("VPN включён", { exact: true })).toBeVisible();

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
  const header = page.locator(".tv-pwa-header");
  await app.evaluate((main) => { main.scrollTop = 0; });
  expect((await header.boundingBox())?.y).toBeGreaterThanOrEqual(42);
  await app.evaluate((main) => {
    main.scrollTop = main.querySelector(".tv-pwa-header")!.getBoundingClientRect().top - 8;
  });
  expect(await app.evaluate(() => Boolean(document.elementFromPoint(75, 20)?.closest(".tv-pwa-header")))).toBe(true);
  await app.evaluate((main) => { main.scrollTop = main.scrollHeight; });
  const footer = await page.locator(".tv-pwa-footer").boundingBox();
  const viewport = await app.boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height - 34);
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

test("the five V3 Overview instruments use the light-strip heading typography", async ({ page }) => {
  const instruments = [
    { ...item, instanceId: "owner.climate", widgetType: "home.climate",
      placement: { x: 0, y: 0, w: 7, h: 3 } },
    { ...item, instanceId: "owner.station", widgetType: "home.station-mini-2",
      placement: { x: 7, y: 0, w: 5, h: 4 } },
    { ...item, instanceId: "owner.kettle", widgetType: "home.kettle", sizeVariant: "detail",
      placement: { x: 0, y: 3, w: 7, h: 3 } },
    { ...item, instanceId: "owner.light", widgetType: "home.light-strip",
      placement: { x: 7, y: 4, w: 5, h: 4 } },
    { ...item, sizeVariant: "detail", placement: { x: 0, y: 6, w: 7, h: 3 } }
  ];
  await layout(page, instruments, instruments);
  await page.route("**/api/tv/status", route => route.fulfill({ json: updated }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const grid = page.locator(".overview-v2-grid");
  const names = ["Кондиционер", "Станция Mini 2", "Чайник", "Лента в зале", "Телевизор"];
  for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ["night", "day"]) {
      await page.goto("/overview?scenario=home-light-strip&theme=" + theme);
      await expect(grid.locator(".light-strip__identity strong")).toHaveText("Лента в зале");
      for (const name of names) await expect(grid.getByText(name, { exact: true })).toBeVisible();
      const typography = await grid.evaluate((root, labels) => {
        const titleNodes = Array.from(root.querySelectorAll("h2, .light-strip__identity strong"));
        return labels.map((name) => {
          const title = titleNodes.find((element) => element.textContent?.trim() === name)!;
          const { fontSize, fontWeight, lineHeight, fontFamily } = getComputedStyle(title);
          return { fontSize, fontWeight, lineHeight, fontFamily };
        });
      }, names);
      const lightStrip = typography[3];
      expect(lightStrip.fontSize).toBe("18.4px");
      expect(typography).toEqual(Array(5).fill(lightStrip));
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
      const slider = widget.getByRole("slider", { name: "Громкость" });
      await expect(slider).toBeEnabled();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Portrait scroll can still settle after the viewport change. Read both
      // cards and their controls in one layout frame.
      await expect(async () => {
        const geometry = await widget.evaluate((card) => {
          const box = (selector: string) => card.querySelector(selector)!.getBoundingClientRect();
          const unit = card.getBoundingClientRect();
          const other = document.querySelector('[data-instance-id="owner.kettle"]')!.getBoundingClientRect();
          const icon = box(".tv-widget-title svg");
          const screen = box(".tv-widget-statuses > .v2-status-text:first-child > span:last-child");
          const audio = box(".cc-slider-copy > span");
          const remote = box(".tv-open");
          return { xDelta: unit.x - other.x, widthDelta: unit.width - other.width,
            gap: unit.top - other.bottom, screenDelta: screen.x - icon.x, audioDelta: audio.x - icon.x,
            controlsOverflow: remote.bottom - unit.bottom };
        });
        expect(Math.abs(geometry.xDelta)).toBeLessThan(1);
        expect(Math.abs(geometry.widthDelta)).toBeLessThan(1);
        expect(Math.abs(geometry.gap - 12)).toBeLessThan(1);
        expect(Math.abs(geometry.screenDelta)).toBeLessThan(1);
        expect(Math.abs(geometry.audioDelta)).toBeLessThan(1);
        expect(geometry.controlsOverflow).toBeLessThanOrEqual(0);
      }).toPass({ timeout: 5000 });
      if (!commands.length) {
        await expect(widget.getByText("VPN выключен", { exact: true })).toBeVisible();
        await widget.getByRole("button", { name: "Яндекс Браузер" }).click();
        await expect(widget.getByText("Приложение открыто.")).toBeVisible();
        await widget.getByRole("button", { name: "Подключить VPN через Happ" }).click();
      }
      await expect(widget.getByText("VPN включён", { exact: true })).toBeVisible();
      await widget.scrollIntoViewIfNeeded();
      await shot(page, orientation + "-" + theme + "-compact-kettle-and-tv");
      await widget.getByRole("button", { name: "Полный пульт" }).click();
      const remotePanel = page.getByRole("region", { name: "Управление телевизором" });
      await expect(remotePanel.getByRole("slider", { name: "Громкость" })).toBeEnabled();
      await expect(remotePanel.getByRole("button", { name: "Подключить VPN через Happ" })).toBeEnabled();
      await expect(remotePanel.getByText("VPN включён", { exact: true })).toBeVisible();
    }
  }
  expect(commands).toEqual([{ action: "open-app", app: "browser" }, { action: "vpn-connect" }]);
});
