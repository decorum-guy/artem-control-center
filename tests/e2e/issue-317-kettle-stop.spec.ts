import { expect, test, type Page } from "@playwright/test";
import type { DashboardSnapshot } from "../../packages/contracts/src/index";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true" && process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const actionIds = ["home.kettle.boil", "home.kettle.set_tea_mode", "home.kettle.stop"];

async function installKettle(page: Page, stage: "on" | "off") {
  const live = { stage, health: "healthy", allowed: true };
  await page.route("**/api/v1/events", route => route.abort());
  await page.route("**/api/v1/snapshot**", async route => {
    const response = await route.fetch();
    const snapshot = await response.json() as DashboardSnapshot;
    const kettle = snapshot.services.find(service => service.dataContract === "home.kettle.v1")!;
    kettle.health = live.health as typeof kettle.health;
    kettle.data = { ...kettle.data, stage: live.stage, operationMode: live.stage,
      available: live.health === "healthy", stale: live.health === "stale", targetTemperature: 80 };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/v1/overview/layout*", route => route.fulfill({ json: {
    schemaVersion: "overview.layout.v2", profileId: "samsung-control",
    presetId: "overview.default", presetVersion: 6, revision: 0,
    viewportClass: "landscape-12", updatedAt: "2026-10-01T00:00:00Z",
    warnings: [], unplaced: [], writesEnabled: true,
    items: [
      { instanceId: "owner.kettle", widgetType: "home.kettle", visibility: "visible",
        placement: { x: 0, y: 1, w: 5, h: 4 }, sizeVariant: "standard", config: {} },
      { instanceId: "owner.coffee", widgetType: "home.coffee-machine", visibility: "visible",
        placement: { x: 5, y: 1, w: 7, h: 4 }, sizeVariant: "standard", config: {} },
    ]
  } }));
  await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ json: {
    schemaVersion: 1, actions: Object.fromEntries(actionIds.map(capability => [capability, {
      capability, minimumProfile: "standard", effectiveProfile: "standard", allowed: live.allowed,
      availability: live.allowed ? "allowed" : "gate_disabled", gateEnabled: live.allowed,
      integrationAvailable: true, busy: false, preconditionOk: true,
    }]))
  } }));
  return live;
}

async function refreshSnapshot(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.describe("Issue 317 · verified kettle stop", () => {
  test.skip(!enabled, "Requires the V2 Home and Overview shells.");

  for (const surface of ["home", "overview"] as const) {
    test(`${surface} off keeps boil, two controls and canonical geometry`, async ({ page }) => {
      await installKettle(page, "off");
      await page.goto(`/${surface}?scenario=home-climate-healthy`);
      const kettle = page.locator(`.kettle-control--${surface}`);
      await expect(kettle.getByRole("button", { name: "Включить" })).toBeEnabled();
      await expect(kettle.getByRole("button", { name: "Остановить" })).toHaveCount(0);
      await expect(kettle.locator(".kettle-control__actions button")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 1281)).toBe(true);
      expect(await kettle.evaluate(element => element.scrollWidth <= element.clientWidth + 1 &&
        element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    });

    test(`${surface} active stop is touch sized, locks conflicting actions and awaits real refreshed state`, async ({ page }) => {
      const live = await installKettle(page, "on");
      const posts: Record<string, unknown>[] = [];
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/api/v1/actions/home-assistant", async route => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        await pending;
        await route.fulfill({ json: { schemaVersion: 1, requestId: body.requestId,
          actionId: body.actionId, status: "confirmed", observedAt: "2026-10-01T00:00:00Z",
          climate: null, psu: null, kettle: { state: "off", operationMode: "off",
            currentTemperature: 61, targetTemperature: null, lastUpdated: "2026-10-01T00:00:00Z" } } });
      });
      await page.goto(`/${surface}?scenario=home-climate-healthy`);
      const kettle = page.locator(`.kettle-control--${surface}`);
      const stop = kettle.getByRole("button", { name: "Остановить" });
      await expect(stop).toBeEnabled();
      await expect(kettle.getByRole("button", { name: "Включить" })).toHaveCount(0);
      await expect(kettle.getByRole("status")).toHaveText("Нагрев");
      const bounds = await stop.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(48);
      expect(bounds!.width).toBeGreaterThanOrEqual(48);
      expect(await kettle.evaluate(element => element.scrollWidth <= element.clientWidth + 1 &&
        element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/kettle-stop-317/${surface}-active.png` });
      await stop.click();
      await expect.poll(() => posts.length).toBe(1);
      await expect(stop).toBeDisabled();
      await expect(kettle.getByRole("button", { name: "Выбрать чай" })).toBeDisabled();
      await stop.evaluate(button => (button as HTMLButtonElement).click());
      expect(posts).toHaveLength(1);
      expect(Object.keys(posts[0]).sort()).toEqual(["actionId", "requestId"]);
      expect(posts[0].actionId).toBe("home.kettle.stop");
      expect(posts[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
      release();
      await expect(stop).toBeEnabled();
      // A confirmed command response alone must not invent an off snapshot.
      await expect(kettle.getByRole("status")).toHaveText("Нагрев");
      live.stage = "off";
      await refreshSnapshot(page);
      await expect(kettle.getByRole("status")).toHaveText("Выключен");
      await expect(kettle.getByRole("button", { name: "Включить" })).toBeEnabled();
      await expect(kettle.getByRole("button", { name: "Остановить" })).toHaveCount(0);
    });

    test(`${surface} stop failure leaves actual heating state and uses existing notice`, async ({ page }) => {
      await installKettle(page, "on");
      let mutations = 0;
      await page.route("**/api/v1/actions/home-assistant", route => {
        mutations += 1;
        return route.fulfill({ status: 504, json: { detail: "ha_verification_timeout" } });
      });
      await page.goto(`/${surface}?scenario=home-climate-healthy`);
      const kettle = page.locator(`.kettle-control--${surface}`);
      await kettle.getByRole("button", { name: "Остановить" }).click();
      await expect(page.getByText("Home Assistant не подтвердил состояние вовремя.")).toBeVisible();
      await expect(kettle.getByRole("status")).toHaveText("Нагрев");
      await expect(kettle.getByRole("button", { name: "Остановить" })).toBeEnabled();
      expect(mutations).toBe(1);
    });

    test(`${surface} stale state and disabled gate keep stop disabled`, async ({ page }) => {
      const live = await installKettle(page, "on");
      live.health = "stale";
      await page.goto(`/${surface}?scenario=home-climate-healthy`);
      const kettle = page.locator(`.kettle-control--${surface}`);
      await expect(kettle.getByRole("button", { name: "Остановить" })).toBeDisabled();
      live.health = "healthy";
      live.allowed = false;
      await page.reload();
      await expect(kettle.getByRole("status")).toHaveText("Нагрев");
      await expect(kettle.getByRole("button", { name: "Остановить" })).toBeDisabled();
    });
  }
});
