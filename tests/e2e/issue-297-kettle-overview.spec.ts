import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true" && process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const editorEnabled = process.env.VITE_OVERVIEW_EDITOR_ENABLED === "true";
const kettleItem = {
  instanceId: "owner.kettle", widgetType: "home.kettle", visibility: "visible",
  placement: { x: 0, y: 1, w: 5, h: 4 }, sizeVariant: "standard", config: {}
};
const coffeeItem = {
  instanceId: "owner.coffee", widgetType: "home.coffee-machine", visibility: "visible",
  placement: { x: 5, y: 1, w: 7, h: 4 }, sizeVariant: "standard", config: {}
};
type Item = typeof kettleItem;

function decision(actionId: string) {
  return { capability: actionId, minimumProfile: "standard", effectiveProfile: "standard", allowed: true,
    availability: "allowed", gateEnabled: true, integrationAvailable: true, busy: false, preconditionOk: true };
}

async function installLayout(page: Page, items: Item[]) {
  const state = { items, revision: 0, patches: [] as Item[][] };
  await page.route("**/api/v1/overview/layout*", async route => {
    if (route.request().method() === "PATCH") {
      state.items = (route.request().postDataJSON() as { items: Item[] }).items;
      state.patches.push(state.items);
      state.revision += 1;
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: {
      etag: `"${state.revision}"`, "x-overview-layout-writes-enabled": "true"
    }, body: JSON.stringify({ schemaVersion: "overview.layout.v2", profileId: "samsung-control",
      presetId: "overview.default", presetVersion: 6, revision: state.revision,
      viewportClass: "landscape-12", updatedAt: "2026-09-29T00:00:00Z",
      items: state.items, warnings: [], unplaced: [], writesEnabled: true }) });
  });
  return state;
}

async function installActions(page: Page) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ json: {
    schemaVersion: 1, actions: { "home.kettle.boil": decision("home.kettle.boil"),
      "home.kettle.set_tea_mode": decision("home.kettle.set_tea_mode") }
  } }));
  await page.route("**/api/v1/actions/home-assistant", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    await route.fulfill({ json: { schemaVersion: 1, requestId: body.requestId, actionId: body.actionId,
      status: "confirmed", observedAt: "2026-09-29T00:00:00Z", climate: null, psu: null,
      kettle: { operationMode: body.teaMode ?? "on", currentTemperature: 61, targetTemperature: 100 } } });
  });
  return posts;
}

test.describe("Issue 297 · trusted Overview Kettle", () => {
  test.skip(!enabled, "Requires the V2 Overview shell.");

  test("renders live Kettle and uses only the existing typed action path", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installLayout(page, [kettleItem, coffeeItem]);
    const posts = await installActions(page);
    await page.goto("/overview?scenario=home-climate-healthy");
    const kettle = page.getByTestId("overview-kettle-widget");
    await expect(kettle).toBeVisible();
    await expect(kettle).toContainText("Текущая температура:");
    await expect(kettle.getByTestId("kettle-current-temperature")).toHaveText("61°");
    await expect(kettle.getByRole("status")).toHaveText("Выключен");
    expect(await kettle.getByTestId("kettle-control").evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const sizes = await kettle.locator(".kettle-control__actions button").evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    expect(sizes).toHaveLength(2);
    expect(sizes.every(size => size.width >= 48 && size.height >= 48)).toBe(true);
    await kettle.getByRole("button", { name: "Выбрать чай" }).click();
    const dialog = page.getByRole("dialog", { name: "Выбрать чай" });
    await expect(dialog.locator(".kettle-picker__option")).toHaveCount(8);
    await expect(dialog.locator("select")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Зелёный чай" }).click();
    expect(posts).toHaveLength(0);
    await dialog.getByRole("button", { name: "Запустить" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(Object.keys(posts[0]).sort()).toEqual(["actionId", "requestId", "teaMode"]);
    expect(posts[0]).toMatchObject({ actionId: "home.kettle.set_tea_mode", teaMode: "green_tea" });
    await kettle.getByRole("button", { name: "Включить" }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(Object.keys(posts[1]).sort()).toEqual(["actionId", "requestId"]);
    expect(posts[1].actionId).toBe("home.kettle.boil");
    expect(typeof posts[1].requestId).toBe("string");
    const geometry = await page.evaluate(() => ({ document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth }));
    expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
  });

  test("editor picker adds and removes the singleton; edit mode blocks both physical actions", async ({ page }) => {
    test.skip(!editorEnabled, "Requires the Overview editor.");
    const state = await installLayout(page, [coffeeItem]);
    const posts = await installActions(page);
    await page.goto("/overview?scenario=home-climate-healthy&overviewEdit=1");
    await expect(page.getByTestId("overview-edit-toolbar")).toBeVisible();
    await page.getByTestId("overview-add-widget").click();
    const picker = page.getByTestId("overview-widget-picker");
    const homeGroup = picker.getByRole("heading", { name: "Дом" }).locator("..");
    const kettleRow = homeGroup.locator('[data-widget-type="home.kettle"]');
    await expect(kettleRow).toContainText("Чайник");
    await expect(picker.getByText("Быстрые действия дома")).toHaveCount(0);
    await kettleRow.getByRole("button", { name: "Добавить" }).click();
    await expect(kettleRow.getByRole("button")).toHaveText("Уже добавлен");
    await picker.getByRole("button", { name: "Закрыть" }).click();
    const frame = page.locator('.overview-edit-frame[data-widget-type="home.kettle"]');
    await expect(frame).toBeVisible();
    await expect(frame.getByRole("button", { name: "Включить" })).toBeDisabled();
    await expect(frame.getByRole("button", { name: "Выбрать чай" })).toBeDisabled();
    await frame.getByRole("button", { name: "Включить" }).evaluate(button => (button as HTMLButtonElement).click());
    await frame.getByRole("button", { name: "Выбрать чай" }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.getByRole("dialog", { name: "Выбрать чай" })).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "normal");
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].find(item => item.widgetType === "home.kettle")?.placement).toMatchObject({ w: 5, h: 4 });
    await page.reload();
    await expect(page.getByTestId("overview-kettle-widget")).toBeVisible();
    await page.goto("/overview?scenario=home-climate-healthy&overviewEdit=1");
    const addedFrame = page.locator('.overview-edit-frame[data-widget-type="home.kettle"]');
    await addedFrame.click();
    await addedFrame.getByRole("button", { name: "Убрать Чайник" }).click();
    await page.getByTestId("overview-save").click();
    expect(state.patches).toHaveLength(2);
    expect(state.patches[1].find(item => item.widgetType === "home.kettle")?.visibility).toBe("hidden");
    expect(state.patches[1].find(item => item.widgetType === "home.coffee-machine"))
      .toEqual(state.patches[0].find(item => item.widgetType === "home.coffee-machine"));
    expect(posts).toHaveLength(0);
  });

  test("missing live contract stays unavailable and never displays a fake temperature", async ({ page }) => {
    await installLayout(page, [kettleItem, coffeeItem]);
    await page.route("**/api/v1/snapshot**", async route => {
      const response = await route.fetch();
      const snapshot = await response.json() as { services: Array<{ dataContract: string }> };
      snapshot.services = snapshot.services.filter(service => service.dataContract !== "home.kettle.v1");
      await route.fulfill({ response, body: JSON.stringify(snapshot) });
    });
    await page.goto("/overview?scenario=home-climate-healthy");
    await expect(page.getByTestId("overview-kettle-unavailable")).toBeVisible();
    await expect(page.getByTestId("overview-kettle-widget")).toHaveCount(0);
    await expect(page.getByTestId("overview-kettle-unavailable")).not.toContainText("61°");
  });

  test("stale and offline snapshots keep the saved temperature truthful and disable controls", async ({ page }) => {
    await installLayout(page, [kettleItem, coffeeItem]);
    let mode: "stale" | "offline" = "stale";
    await page.route("**/api/v1/snapshot**", async route => {
      const response = await route.fetch();
      const snapshot = await response.json() as { services: Array<{ dataContract: string; health: string; data: Record<string, unknown> }> };
      const kettle = snapshot.services.find(service => service.dataContract === "home.kettle.v1")!;
      kettle.health = mode;
      kettle.data = { ...kettle.data, stale: mode === "stale", available: mode === "stale", currentTemperature: null };
      await route.fulfill({ response, body: JSON.stringify(snapshot) });
    });
    await page.goto("/overview?scenario=home-climate-healthy");
    const kettle = page.getByTestId("overview-kettle-widget");
    await expect(kettle.getByRole("status")).toHaveText("Данные устарели");
    await expect(kettle.getByTestId("kettle-current-temperature")).toHaveText("—°");
    await expect(kettle.getByRole("button", { name: "Включить" })).toBeDisabled();
    await expect(kettle.getByRole("button", { name: "Выбрать чай" })).toBeDisabled();
    mode = "offline";
    await page.reload();
    await expect(kettle.getByRole("status")).toHaveText("Недоступен");
    await expect(kettle.getByRole("button", { name: "Включить" })).toBeDisabled();
    await expect(kettle.getByRole("button", { name: "Выбрать чай" })).toBeDisabled();
  });

  test("an older cached layout retires Quick Actions without fallback or auto-added Kettle", async ({ page }) => {
    const quick = { instanceId: "owner.quick", widgetType: "home.quick-actions", visibility: "visible",
      placement: { x: 0, y: 7, w: 4, h: 2 }, sizeVariant: "compact", config: {} };
    await page.route("**/api/v1/overview/layout*", route => route.fulfill({ json: {
      schemaVersion: "overview.layout.v2", profileId: "samsung-control", presetId: "overview.default",
      presetVersion: 5, revision: 9, viewportClass: "landscape-12", updatedAt: "2026-09-29T00:00:00Z",
      items: [coffeeItem, quick], warnings: [], unplaced: [], writesEnabled: true
    }, headers: { etag: '"9"', "x-overview-layout-writes-enabled": "true" } }));
    await page.goto("/overview?scenario=home-climate-healthy");
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="home.coffee-machine"]')).toHaveCount(1);
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="home.quick-actions"]')).toHaveCount(0);
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="home.kettle"]')).toHaveCount(0);
    await expect(page.getByTestId("overview-widget-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("overview-layout-warning")).toHaveCount(0);
    await page.goto("/overview?scenario=home-climate-healthy&overviewEdit=1");
    await expect(page.getByTestId("overview-unplaced")).toHaveCount(0);
  });
});
