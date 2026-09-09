import { expect, test, type Locator, type Page } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewEnabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const overviewEditorEnabled = process.env.VITE_OVERVIEW_EDITOR_ENABLED === "true";

async function expectMinimumControlSize(locator: Locator): Promise<void> {
  const heights = await locator.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(48);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
}

async function expectContained(card: Locator, selectors: string[]): Promise<void> {
  const result = await card.evaluate((element, childSelectors) => {
    const cardRect = element.getBoundingClientRect();
    const rectangles = childSelectors.map((selector) => {
      const child = element.querySelector<HTMLElement>(selector);
      if (!child) return { selector, missing: true, contained: false, overflowFree: false };
      const rect = child.getBoundingClientRect();
      return {
        selector,
        missing: false,
        contained: rect.left >= cardRect.left - 1 && rect.right <= cardRect.right + 1 &&
          rect.top >= cardRect.top - 1 && rect.bottom <= cardRect.bottom + 1,
        overflowFree: child.scrollWidth <= child.clientWidth + 1
      };
    });
    return {
      cardOverflowFree: (element as HTMLElement).scrollWidth <= (element as HTMLElement).clientWidth + 1,
      rectangles
    };
  }, selectors);
  expect(result.cardOverflowFree).toBe(true);
  expect(result.rectangles.every((entry) => !entry.missing && entry.contained && entry.overflowFree), JSON.stringify(result)).toBe(true);
}

test.describe("Issue 207 · Home Assistant climate controls", () => {
  test.skip(!visualShellEnabled, "Requires the V2 visual shell.");

  test("renders the fixed Home climate contract in Home", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home?scenario=home-climate-healthy");
    const climate = page.getByTestId("climate-control-home");
    await expect(climate).toBeVisible();
    await expect(climate).not.toContainText("В комнате");
    await expect(climate).not.toContainText("Температура в комнате недоступна");
    await expect(climate).not.toContainText("Цель");
    await expect(climate).not.toContainText("Дом · Home Assistant");
    await expect(climate.getByTestId("climate-power-home")).toHaveAccessibleName("Включить кондиционер");
    await expect(climate.getByTestId("climate-power-home").locator("svg")).toHaveCount(1);
    await expect(climate.getByTestId("climate-power-home")).toHaveText("");
    await expect(climate.getByTestId("climate-power-home")).toHaveAttribute("data-power-state", "off");
    await expect(climate.getByTestId("climate-temperature-value-home")).toHaveText("32°");
    await expect(climate.getByTestId("climate-temperature-confirm-home")).toBeDisabled();
    await expect(page.getByText("Включить кондиционер", { exact: true })).toHaveCount(0);
    await expect(climate.locator("select").nth(0).locator("option")).toHaveCount(6);
    await expect(climate.locator("select").nth(1).locator("option")).toHaveCount(5);
    await expectMinimumControlSize(climate.locator("button"));
    await expectContained(climate, [
      '[data-testid="climate-power-home"]',
      ".climate-control__temperature-control",
      ".climate-control__mode-label",
      ".climate-control__fan-label"
    ]);
    await expectNoHorizontalOverflow(page);
  });

  test("drafts temperature locally and sends one confirmed request", async ({ page }) => {
    let actionRequests = 0;
    await page.route("**/api/v1/actions/home-assistant/availability", async (route) => {
      const decision = { capability: "home_climate_actions", minimumProfile: "standard", effectiveProfile: "standard", allowed: true, availability: "allowed", gateEnabled: true, integrationAvailable: true, busy: false, preconditionOk: true };
      const actions = Object.fromEntries(["home.climate.power_on", "home.climate.power_off", "home.climate.set_temperature", "home.climate.set_mode", "home.climate.set_fan_mode"].map((id) => [id, decision]));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, actions }) });
    });
    await page.route("**/api/v1/actions/home-assistant", async (route) => {
      actionRequests += 1;
      expect(route.request().postDataJSON()).toMatchObject({ actionId: "home.climate.set_temperature", temperature: 27 });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, requestId: "fixture", actionId: "home.climate.set_temperature", status: "confirmed", observedAt: "2026-09-09T00:00:00Z", climate: { state: "off", targetTemperature: 27, fanMode: "one" }, psu: null }) });
    });
    await page.goto("/home?scenario=home-climate-healthy");
    const climate = page.getByTestId("climate-control-home");
    for (let index = 0; index < 5; index += 1) {
      await climate.getByTestId("climate-temperature-decrease-home").click();
    }
    await expect(climate.getByTestId("climate-temperature-value-home")).toHaveText("27°");
    expect(actionRequests).toBe(0);
    await expect(climate.getByTestId("climate-temperature-confirm-home")).toBeEnabled();
    await climate.getByTestId("climate-temperature-confirm-home").click();
    await expect.poll(() => actionRequests).toBe(1);
    await expect(climate.getByTestId("climate-temperature-confirm-home")).toBeDisabled();
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

  test("uses a dedicated climate widget with contained controls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=home-climate-healthy");
    const item = page.locator('.overview-v2-grid-item[data-widget-type="home.climate"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-grid-h", "4");
    const climate = item.getByTestId("climate-control-overview");
    await expect(climate).toBeVisible();
    await expect(climate).not.toContainText("В комнате");
    await expect(climate).not.toContainText("Цель");
    await expect(climate).not.toContainText("Дом · Home Assistant");
    await expect(item.getByTestId("overview-home-widget")).toHaveCount(0);
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="home.quick-actions"]')).toHaveCount(0);
    await expectContained(climate, [
      '[data-testid="climate-power-overview"]',
      ".climate-control__temperature-control",
      ".climate-control__mode-label",
      ".climate-control__fan-label"
    ]);
    const temperature = climate.locator(".climate-control__temperature-control");
    const temperatureGeometry = await temperature.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const value = element.querySelector<HTMLElement>('[data-testid="climate-temperature-value-overview"]')?.getBoundingClientRect();
      const minus = element.querySelector<HTMLElement>('[data-testid="climate-temperature-decrease-overview"]')?.getBoundingClientRect();
      const plus = element.querySelector<HTMLElement>('[data-testid="climate-temperature-increase-overview"]')?.getBoundingClientRect();
      const confirm = element.querySelector<HTMLElement>('[data-testid="climate-temperature-confirm-overview"]')?.getBoundingClientRect();
      if (!value || !minus || !plus || !confirm) return null;
      return {
        control,
        value,
        minus,
        plus,
        confirm,
        climate: element.closest<HTMLElement>(".climate-control")?.getBoundingClientRect()
      };
    });
    expect(temperatureGeometry).not.toBeNull();
    if (!temperatureGeometry) return;
    expect(temperatureGeometry.control.width).toBeLessThan((temperatureGeometry.climate?.width ?? temperatureGeometry.control.width) * 0.8);
    expect(temperatureGeometry.plus.left - temperatureGeometry.minus.right).toBeGreaterThanOrEqual(4);
    expect(temperatureGeometry.plus.left - temperatureGeometry.minus.right).toBeLessThanOrEqual(8);
    expect(temperatureGeometry.confirm.left - temperatureGeometry.plus.right).toBeGreaterThanOrEqual(4);
    expect(temperatureGeometry.confirm.left - temperatureGeometry.plus.right).toBeLessThanOrEqual(8);
    expect(temperatureGeometry.value.height).toBeGreaterThanOrEqual(48);
    for (const button of [temperatureGeometry.minus, temperatureGeometry.plus, temperatureGeometry.confirm]) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
    }
    await expectNoHorizontalOverflow(page);
  });

  test("removes and re-adds the climate singleton through the picker", async ({ page }) => {
    test.skip(!overviewEditorEnabled, "Requires the Overview editor build gate.");
    const layout = {
      schemaVersion: "overview.layout.v2",
      profileId: "samsung-control",
      presetId: "overview.default",
      presetVersion: 3,
      revision: 0,
      viewportClass: "landscape-12",
      updatedAt: "2026-09-09T00:00:00Z",
      writesEnabled: true,
      warnings: [],
      unplaced: [],
      items: [
        { instanceId: "fixture.rog", widgetType: "system.rog-g703-operational", visibility: "visible", placement: { x: 0, y: 0, w: 12, h: 1 }, sizeVariant: "standard", config: {} },
        { instanceId: "fixture.coffee", widgetType: "home.coffee-machine", visibility: "visible", placement: { x: 0, y: 1, w: 7, h: 4 }, sizeVariant: "standard", config: {} },
        { instanceId: "fixture.planning", widgetType: "planning.summary", visibility: "visible", placement: { x: 7, y: 1, w: 5, h: 4 }, sizeVariant: "standard", config: {} },
        { instanceId: "fixture.climate", widgetType: "home.climate", visibility: "visible", placement: { x: 0, y: 5, w: 7, h: 4 }, sizeVariant: "standard", config: {} },
        { instanceId: "fixture.health", widgetType: "system.health-summary", visibility: "visible", placement: { x: 7, y: 5, w: 5, h: 2 }, sizeVariant: "compact", config: {} }
      ]
    };
    let revision = 0;
    await page.route("**/api/v1/overview/layout*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", etag: `"${revision}"`, "x-overview-layout-writes-enabled": "true" }, body: JSON.stringify({ ...layout, revision }) });
        return;
      }
      const body = route.request().postDataJSON() as { items: typeof layout.items };
      layout.items = body.items;
      revision += 1;
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", etag: `"${revision}"` }, body: JSON.stringify({ ...layout, revision }) });
    });
    await page.goto("/overview?scenario=home-climate-healthy");
    await unlockTouchLockIfNeeded(page);
    await page.getByTestId("overview-configure").click();
    await page.locator('.overview-edit-frame[data-instance-id="fixture.climate"]').press("Enter");
    await page.getByRole("button", { name: "Убрать Кондиционер" }).click();
    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("overview-edit-toolbar")).toHaveCount(0);

    await page.getByTestId("overview-configure").click();
    await page.getByTestId("overview-add-widget").click();
    const climateRow = page.locator('[data-widget-type="home.climate"]');
    await expect(climateRow).toContainText("Кондиционер");
    await expect(climateRow.getByRole("button")).toHaveText("Добавить");
    await climateRow.getByRole("button", { name: "Добавить" }).click();
    await expect(climateRow.getByRole("button")).toHaveText("Уже добавлен");
    await page.getByTestId("overview-widget-picker").getByRole("button", { name: "Закрыть" }).click();
    await page.getByTestId("overview-save").click();
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="home.climate"]')).toHaveCount(1);
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

test.describe("Overview ASUS operational strip", () => {
  test.skip(!visualShellEnabled || !overviewEnabled, "Requires the V2 visual shell and Overview V2.");

  test("keeps four icon-only host and PSU actions contained", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=home-asus-both");
    const rog = page.getByTestId("overview-rog-g703");
    await expect(rog).toBeVisible();
    for (const [testId, label] of [
      ["overview-rog-g703-sleep", "Перевести ASUS ROG в спящий режим"],
      ["overview-rog-g703-hibernate", "Перевести ASUS ROG в гибернацию"],
      ["overview-rog-psu-normal", "Обычный режим питания ASUS ROG"],
      ["overview-rog-psu-full", "Полная мощность ASUS ROG"]
    ] as const) {
      const control = rog.getByTestId(testId);
      await expect(control).toHaveAccessibleName(label);
      await expect(control.locator("svg")).toHaveCount(1);
      await expect(control).toHaveText("");
    }
    await expectMinimumControlSize(rog.locator("button"));
    await expectContained(rog, [".overview-rog-widget__action"]);
    const actionGeometry = await rog.locator(".overview-rog-widget__action").evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll<HTMLElement>("button"), (button) => button.getBoundingClientRect());
      return {
        action: element.getBoundingClientRect(),
        buttons,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });
    expect(actionGeometry.buttons).toHaveLength(4);
    for (const button of actionGeometry.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
      expect(button.left).toBeGreaterThanOrEqual(actionGeometry.action.left - 1);
      expect(button.right).toBeLessThanOrEqual(actionGeometry.action.right + 1);
    }
    const gaps = actionGeometry.buttons.slice(1).map((button, index) => button.left - actionGeometry.buttons[index].right);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(9);
    expect(actionGeometry.documentWidth).toBeLessThanOrEqual(actionGeometry.viewportWidth + 1);
    await expectNoHorizontalOverflow(page);
  });

  test("keeps host and PSU actions independently materialized", async ({ page }) => {
    await page.goto("/overview?scenario=home-asus-psu-only");
    await expect(page.getByTestId("overview-rog-psu-normal")).toBeVisible();
    await expect(page.getByTestId("overview-rog-g703-sleep")).toHaveCount(0);
    await page.goto("/overview?scenario=home-asus-host-only");
    await expect(page.getByTestId("overview-rog-g703-sleep")).toBeVisible();
    await expect(page.getByTestId("overview-rog-psu-normal")).toHaveCount(0);
  });
});

test.describe("Home ASUS household composition", () => {
  test.skip(!visualShellEnabled, "Requires the V2 visual shell.");

  test("shows host and PSU independently in one Home ASUS area", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home?scenario=home-asus-both");
    const zone = page.getByTestId("home-asus-zone");
    await expect(zone).toBeVisible();
    await expect(zone.getByTestId("home-rog-g703")).toBeVisible();
    await expect(zone.getByTestId("rog-psu-controls")).toBeVisible();
    await expect(zone).not.toContainText("Система · питание");
    await expect(zone).not.toContainText("Телеметрия мощности не подключена");
    await expectMinimumControlSize(zone.locator("button"));
    await expectNoHorizontalOverflow(page);
  });

  test("keeps PSU visible without host", async ({ page }) => {
    await page.goto("/home?scenario=home-asus-psu-only");
    await expect(page.getByTestId("home-asus-zone")).toBeVisible();
    await expect(page.getByTestId("rog-psu-controls")).toBeVisible();
    await expect(page.getByTestId("home-rog-g703")).toHaveCount(0);
  });

  test("keeps host visible without PSU", async ({ page }) => {
    await page.goto("/home?scenario=home-asus-host-only");
    await expect(page.getByTestId("home-asus-zone")).toBeVisible();
    await expect(page.getByTestId("home-rog-g703")).toBeVisible();
    await expect(page.getByTestId("rog-psu-controls")).toHaveCount(0);
  });
});

test.describe("Home Assistant capability gate copy", () => {
  test.skip(!visualShellEnabled, "Requires the V2 visual shell.");

  test("shows Settings-oriented copy for a disabled gate and enables controls when effective gate is true", async ({ page }) => {
    const decision = (enabled: boolean) => ({
      capability: "home_climate_actions",
      minimumProfile: "standard",
      effectiveProfile: "standard",
      allowed: enabled,
      availability: enabled ? "allowed" : "gate_disabled",
      gateEnabled: enabled,
      integrationAvailable: true,
      busy: false,
      preconditionOk: true
    });
    let enabled = false;
    await page.route("**/api/v1/actions/home-assistant/availability", async (route) => {
      const actions = Object.fromEntries([
        "home.climate.power_on",
        "home.climate.power_off",
        "home.climate.set_temperature",
        "home.climate.set_mode",
        "home.climate.set_fan_mode"
      ].map((actionId) => [actionId, decision(enabled)]));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, actions }) });
    });
    await page.goto("/home?scenario=home-climate-healthy");
    const climate = page.getByTestId("climate-control-home");
    await expect(climate.getByTestId("climate-power-home")).toHaveAttribute("title", "Управление выключено в настройках возможностей.");
    enabled = true;
    await page.reload();
    await expect(climate.getByTestId("climate-power-home")).toBeEnabled();
  });
});
