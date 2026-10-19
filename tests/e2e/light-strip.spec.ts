import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true" && process.env.VITE_OVERVIEW_V2_ENABLED === "true";

function decision(actionId: string) {
  return { capability: actionId, minimumProfile: "standard", effectiveProfile: "standard", allowed: true,
    availability: "allowed", gateEnabled: true, integrationAvailable: true, busy: false, preconditionOk: true };
}

async function installActions(page: Page) {
  const ids = ["power_on", "power_off", "set_brightness", "set_color", "set_temperature", "set_effect"]
    .map((name) => `home.light_strip.${name}`);
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/v1/actions/home-assistant/availability", (route) => route.fulfill({ json: {
    schemaVersion: 1, actions: Object.fromEntries(ids.map((id) => [id, decision(id)]))
  } }));
  await page.route("**/api/v1/actions/home-assistant", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    await route.fulfill({ json: { schemaVersion: 1, requestId: body.requestId, actionId: body.actionId,
      status: "confirmed", observedAt: "2026-10-19T00:00:00Z", climate: null, psu: null, kettle: null,
      light: { state: "on", brightness: 204, hsColor: [9, 67], colorTempKelvin: null, effect: body.effect ?? null } } });
  });
  return posts;
}

async function expectSelectorInsideWidget(page: Page, testId: string) {
  const bounds = await page.getByTestId(testId).evaluate((widget) => {
    const button = widget.querySelector<HTMLButtonElement>(".light-strip__more");
    if (!button) throw new Error("Missing color and mode selector");
    return { widgetBottom: widget.getBoundingClientRect().bottom, buttonBottom: button.getBoundingClientRect().bottom };
  });
  expect(bounds.buttonBottom).toBeLessThanOrEqual(bounds.widgetBottom - 14);
}

test.describe("living room RGB strip", () => {
  test.skip(!enabled, "Requires the V2 shell.");

  test("Home shows frequency-ranked swatches and the full HA palette", async ({ page }) => {
    const posts = await installActions(page);
    await page.goto("/home?scenario=home-light-strip");
    const light = page.getByTestId("light-strip-home");
    await expect(light).toBeVisible();
    await expectSelectorInsideWidget(page, "light-strip-home");
    await expect(light.getByRole("button", { name: "Красный, выбран 2 раз" })).toBeVisible();
    await expect(light.getByRole("button", { name: "Белый, выбран 1 раз" })).toBeVisible();
    await expect(light.getByRole("button", { name: "Чтение, выбран 1 раз" })).toContainText("Чтение");
    const scrollBeforePicker = await page.evaluate(() => window.scrollY);
    await light.getByRole("button", { name: "Открыть выбор цвета и режима" }).click();
    const dialog = page.getByRole("dialog", { name: "Цвета и режимы" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".light-strip__swatch--picker")).toHaveCount(22);
    await expect(dialog.locator(".light-strip__mode")).toHaveCount(17);
    await expect(dialog.getByRole("button", { name: "Чтение" })).toBeVisible();
    await dialog.getByRole("button", { name: "Синий", exact: true }).click();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforePicker);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ actionId: "home.light_strip.set_effect", effect: "Синий" });
    expect(posts[0]).not.toHaveProperty("entity_id");
  });

  test("Overview renders its trusted light slot", async ({ page }) => {
    await installActions(page);
    await page.route("**/api/v1/overview/layout*", (route) => route.fulfill({ json: {
      schemaVersion: "overview.layout.v2", profileId: "samsung-control", presetId: "overview.default",
      presetVersion: 6, revision: 0, viewportClass: "landscape-12", updatedAt: "2026-10-19T00:00:00Z",
      items: [{ instanceId: "owner.light", widgetType: "home.light-strip", visibility: "visible",
        placement: { x: 0, y: 0, w: 5, h: 4 }, sizeVariant: "standard", config: {} }],
      warnings: [], unplaced: [], writesEnabled: false
    } }));
    await page.goto("/overview?scenario=home-light-strip");
    await expect(page.getByTestId("overview-light-strip-widget")).toBeVisible();
    const light = page.getByTestId("light-strip-overview");
    await expect(light).toContainText("Лента в зале");
    await expectSelectorInsideWidget(page, "light-strip-overview");
    const topBeforePicker = await light.evaluate((widget) => widget.getBoundingClientRect().top);
    await light.getByRole("button", { name: "Открыть выбор цвета и режима" }).click();
    const dialog = page.getByRole("dialog", { name: "Цвета и режимы" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Закрыть выбор цвета и режима" }).click();
    await expect(dialog).toBeHidden();
    expect(await light.evaluate((widget) => widget.getBoundingClientRect().top)).toBe(topBeforePicker);
  });
});
