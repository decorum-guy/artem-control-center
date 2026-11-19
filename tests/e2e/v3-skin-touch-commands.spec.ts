import { expect, test, type Page, type Route } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_OVERVIEW_V2_ENABLED !== "true"
  || process.env.VITE_V3_VISUAL_SKIN !== "true", "Samsung V3 controls");

async function heldActions(page: Page, kind: "station" | "home-assistant", ids: string[]) {
  const path = `**/api/v1/actions/${kind}`;
  const actions = Object.fromEntries(ids.map(id => [id, { capability: id, allowed: true, availability: "allowed",
    minimumProfile: "standard", effectiveProfile: "standard", gateEnabled: true, integrationAvailable: true, preconditionOk: true }]));
  await page.route(path + "/availability", route => route.fulfill({ json: { schemaVersion: 1, actions } }));
  const requests: Route[] = [];
  await page.route(path, route => { requests.push(route); });
  return requests;
}

async function reply(route: Route, status: "dispatched" | "confirmed") {
  const request = route.request().postDataJSON();
  await route.fulfill({ json: { schemaVersion: 1, ...request, status, observedAt: new Date().toISOString(),
    ...(status === "confirmed" ? { light: { state: "on", brightness: request.brightness ?? 128 } } : {}) } });
}

for (const uncertain of [false, true]) {
  test(`four volume taps keep order and show one result, uncertain=${uncertain}`, async ({ page }) => {
    const up = "media.alice.volume_up", down = "media.alice.volume_down";
    const requests = await heldActions(page, "station", [up, down]);
    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    for (const dir of ["up", "up", "down", "up"]) await widget.getByRole("button", { name: "Volume " + dir }).click();
    await expect.poll(() => requests.length).toBe(1);
    const notices = page.getByTestId("global-notice").filter({ hasText: "Громкость Алисы" });
    await expect(notices).toHaveCount(0);
    const sequence = [up, up, down, up];
    for (const [i, action] of sequence.entries()) {
      await expect.poll(() => requests.length).toBe(i + 1);
      expect(requests[i].request().postDataJSON().actionId).toBe(action);
      if (uncertain && i === 1) {
        await requests[i].fulfill({ status: 503, json: { detail: "station_dispatch_uncertain" } });
        break;
      }
      await reply(requests[i], "dispatched");
    }
    await expect(notices).toHaveCount(1);
    await expect(notices).toContainText(uncertain ? "1 из 4" : "отправлены · 4");
    expect(requests).toHaveLength(uncertain ? 2 : 4);
    expect(new Set(requests.map(r => r.request().postDataJSON().requestId)).size).toBe(requests.length);
  });
}

for (const powerOn of [false, true]) {
  test(`brightness keeps the last selection while waiting for HA, starting off=${powerOn}`, async ({ page }) => {
    const brightness = "home.light_strip.set_brightness", on = "home.light_strip.power_on";
    const requests = await heldActions(page, "home-assistant", [brightness, on]);
    await page.route("**/api/v1/snapshot*", async route => {
      const response = await route.fetch();
      const snapshot = await response.json();
      const light = snapshot.services.find((s: { id: string }) => s.id === "living-room-light-strip");
      light.data = { ...light.data, state: powerOn ? "off" : "on", brightness: 128, observedAt: "2025-01-01T00:00:00Z" };
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto("/home?scenario=home-light-strip");
    const widget = page.getByTestId("light-strip-home");
    const slider = widget.getByRole("slider", { name: "Яркость" });
    if (powerOn) {
      await widget.getByRole("button", { name: "Включить ленту" }).click();
    } else {
      await expect(slider).toBeEnabled();
      await slider.press("End");
    }
    await expect.poll(() => requests.length).toBe(1);
    for (const key of ["Home", "End", "ArrowLeft"]) await slider.press(key);
    await expect(slider).toHaveAttribute("aria-valuenow", "254");
    expect(requests).toHaveLength(1);
    expect(requests[0].request().postDataJSON().actionId).toBe(powerOn ? on : brightness);
    await reply(requests[0], "confirmed");
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].request().postDataJSON()).toMatchObject({ actionId: brightness, brightness: 254 });
    await reply(requests[1], "confirmed");
    const notice = page.getByTestId("global-notice").filter({ hasText: "Лента в зале" });
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText("Home Assistant подтвердил яркость");
    await expect(slider).toHaveAttribute("aria-valuenow", "254");
  });
}

test("leaving Overview discards volume steps that have not been sent", async ({ page }) => {
  const requests = await heldActions(page, "station", ["media.alice.volume_up"]);
  await page.goto("/overview");
  const up = page.getByRole("button", { name: "Volume up" });
  await up.click();
  await up.click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByTestId("v2-navigation-rail").locator('a[href="/home"]').first().click();
  await expect(page.getByTestId("overview-station-mini-widget")).toHaveCount(0);
  await reply(requests[0], "dispatched");
  await page.waitForTimeout(450);
  expect(requests).toHaveLength(1);
});

test("a failed power-on cancels the pending brightness without turning the strip on again", async ({ page }) => {
  const requests = await heldActions(page, "home-assistant", ["home.light_strip.set_brightness", "home.light_strip.power_on"]);
  await page.route("**/api/v1/snapshot*", async route => {
    const response = await route.fetch(), snapshot = await response.json();
    const light = snapshot.services.find((s: { id: string }) => s.id === "living-room-light-strip");
    light.data.state = "off";
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto("/home?scenario=home-light-strip");
  const light = page.getByTestId("light-strip-home"), slider = light.getByRole("slider", { name: "Яркость" });
  await light.getByRole("button", { name: "Включить ленту" }).click();
  await slider.press("Home");
  await expect.poll(() => requests.length).toBe(1);
  await requests[0].fulfill({ status: 504, json: { detail: "ha_verification_timeout" } });
  await expect(page.getByTestId("global-notice").filter({ hasText: "Итоговое изменение не подтверждено" })).toHaveCount(1);
  await expect(slider).toHaveAttribute("aria-disabled", "true");
  expect(requests).toHaveLength(1);
});

for (const offline of ["health_unreachable_persistent", null]) {
  test(`Services and header agree about ASUS, lastError=${offline}`, async ({ page }) => {
    await page.route("**/api/v1/diagnostics*", route => route.fulfill({ status: 503, body: "" }));
    await page.route("**/api/v1/snapshot*", async route => {
      const response = await route.fetch(), snapshot = await response.json();
      snapshot.services = [{ id: "rog_g703gi", title: "ASUS ROG", enabled: true, dataContract: "system.rog-g703.v1",
        health: "offline", source: "live", summary: "Нет ответа", actions: [], data: { status: "offline", lastError: offline },
        presentation: { category: "system", group: "System", overview: "none", priority: 85 } }];
      snapshot.planning = null;
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto("/services");
    const summary = page.getByTestId("services-attention-summary");
    const header = page.locator(".v2-header-system");
    if (offline) {
      await expect(summary).toContainText("Требуют внимания · 1");
      await expect(header).toHaveAccessibleName(/1 требу/);
      await expect(page.getByTestId("services-attention-zone")).toContainText("ASUS ROG");
    } else {
      await expect(summary).toContainText("Нет активных проблем");
      await expect(header).toHaveAccessibleName("Системы в норме");
      await page.getByTestId("healthy-group-system").getByRole("button").first().click();
      await expect(page.getByTestId("health-row-rog_g703gi")).toContainText("Недоступен");
    }
  });
}
