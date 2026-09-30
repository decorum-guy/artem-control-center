import { expect, test } from "@playwright/test";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const teaLabels = ["Белый чай", "Зелёный чай", "Красный чай", "Травяной чай", "Цветочный чай", "Пуэр", "Улун", "Чёрный чай"];

function decision(actionId: string) {
  return { capability: actionId, minimumProfile: "standard", effectiveProfile: "standard", allowed: true, availability: "allowed", gateEnabled: true, integrationAvailable: true, busy: false, preconditionOk: true };
}

test.describe("Issue 293 · dedicated kettle control", () => {
  test.skip(!enabled, "Requires the V2 visual shell.");

  test("keeps three primary devices, shows current water temperature, and starts tea only explicitly", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ json: {
      schemaVersion: 1,
      actions: { "home.kettle.boil": decision("home.kettle.boil"), "home.kettle.set_tea_mode": decision("home.kettle.set_tea_mode") }
    } }));
    await page.route("**/api/v1/actions/home-assistant", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { schemaVersion: 1, requestId: posts.at(-1)?.requestId, actionId: posts.at(-1)?.actionId, status: "confirmed", observedAt: "2026-09-30T18:15:56Z", climate: null, psu: null, kettle: { operationMode: "on", currentTemperature: 25, targetTemperature: 80 } } });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home?scenario=home-climate-healthy");
    await expect(page.getByTestId("climate-control-home")).toBeVisible();
    await expect(page.getByTestId("kettle-control")).toBeVisible();
    await expect(page.getByTestId("kettle-current-temperature")).toHaveText("61°");
    await expect(page.getByTestId("kettle-control")).toContainText("Текущая температура:");
    const homeGeometry = await page.getByTestId("kettle-control").evaluate(element => {
      const card = element.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll(".kettle-control__actions button"))
        .map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
      return { width: card.width, height: card.height, column: getComputedStyle(element).gridColumnStart,
        row: getComputedStyle(element).gridRowStart, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, buttons };
    });
    expect(homeGeometry.column).toBe("span 5");
    expect(homeGeometry.row).toBe("span 3");
    expect(homeGeometry.width).toBeLessThan(540);
    expect(homeGeometry.height).toBeLessThan(260);
    expect(homeGeometry.scrollHeight).toBeLessThanOrEqual(homeGeometry.clientHeight + 1);
    expect(homeGeometry.buttons.every(button => button.width >= 48 && button.height >= 48)).toBe(true);
    await expect(page.getByTestId("home-secondary-devices").getByText("Чайник")).toHaveCount(0);
    const kettle = page.getByTestId("kettle-control");
    await expect(kettle.getByRole("button", { name: "Включить" })).toBeEnabled();
    await kettle.getByRole("button", { name: "Выбрать чай" }).click();
    const dialog = page.getByRole("dialog", { name: "Выбрать чай" });
    await expect(dialog).toBeVisible();
    for (const label of teaLabels) await expect(dialog.getByRole("button", { name: label })).toBeVisible();
    await expect(dialog.locator("select")).toHaveCount(0);
    await expect(dialog.locator(".kettle-picker__option")).toHaveCount(8);
    const minimumRow = await dialog.locator(".kettle-picker__option").evaluateAll(rows => Math.min(...rows.map(row => row.getBoundingClientRect().height)));
    expect(minimumRow).toBeGreaterThanOrEqual(48);
    await dialog.getByRole("button", { name: "Зелёный чай" }).click();
    expect(posts).toHaveLength(0);
    await dialog.getByRole("button", { name: "Запустить" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(Object.keys(posts[0]).sort()).toEqual(["actionId", "requestId", "teaMode"]);
    expect(posts[0].actionId).toBe("home.kettle.set_tea_mode");
    expect(posts[0].teaMode).toBe("green_tea");
    await expect(kettle).toContainText("Выключен");
    const geometry = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
  });

  test("boil sends only the fixed action ID and blocks duplicate taps while pending", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    let release: (() => void) | undefined;
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ json: {
      schemaVersion: 1, actions: { "home.kettle.boil": decision("home.kettle.boil"), "home.kettle.set_tea_mode": decision("home.kettle.set_tea_mode") }
    } }));
    await page.route("**/api/v1/actions/home-assistant", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { schemaVersion: 1, requestId: posts[0].requestId, actionId: posts[0].actionId, status: "confirmed", observedAt: "2026-09-29T00:00:00Z", climate: null, psu: null, kettle: { operationMode: "on", currentTemperature: 61, targetTemperature: 100 } } });
    });
    await page.goto("/home?scenario=home-climate-healthy");
    const kettle = page.getByTestId("kettle-control");
    const boil = kettle.getByRole("button", { name: "Включить" });
    await expect(boil).toBeEnabled();
    await boil.click();
    await expect(boil).toBeDisabled();
    await boil.evaluate(element => (element as HTMLButtonElement).click());
    await expect.poll(() => posts.length).toBe(1);
    expect(Object.keys(posts[0]).sort()).toEqual(["actionId", "requestId"]);
    expect(posts[0].actionId).toBe("home.kettle.boil");
    await expect(kettle).toContainText("Выключен");
    release?.();
    await expect(boil).toBeEnabled();
    await expect(kettle).toContainText("Выключен");
  });
});
