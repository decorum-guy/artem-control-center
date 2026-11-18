import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_V3_VISUAL_SKIN !== "true",
  "Jarvis artwork and image variants belong to the Cabin profile.");

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`climate labels and availability fit the Overview tile at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ status: 503, json: {} }));
    await page.goto("/overview?scenario=coffee-ready&motion=reduced");
    const climate = page.locator(".climate-control").first();
    const note = climate.locator(".climate-control__api-note");
    await expect(note).toBeVisible();
    const selectors = climate.locator(".cc-select");
    await expect(selectors).toHaveCount(2);
    await expect(selectors.first()).toHaveAccessibleName(/Режим кондиционера/);
    await expect.poll(() => climate.evaluate(tile => {
      const fields = Array.from(tile.querySelectorAll(".cc-select"));
      const noteTop = tile.querySelector(".climate-control__api-note")!.getBoundingClientRect().top;
      return noteTop - Math.max(...fields.map(field => field.getBoundingClientRect().bottom));
    })).toBeGreaterThanOrEqual(4);
  });
}

test("disabled assistant stays absent and the panel loads size-appropriate artwork", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("artem-control-center.jarvis-visible", "true"));
  await page.goto("/home?motion=reduced");
  const launcher = page.getByTestId("jarvis-launcher");
  await expect(launcher).toHaveCount(0);
  await expect(page.locator(".coffee-asset__image").first()).toHaveAttribute("src", /coffee-machine-(panel|overview).*\.webp/);
  await page.goto("/home?scenario=coffee-warming&motion=full");
  await expect(page.locator(".coffee-panel").first()).toHaveAttribute("data-stage", "warming");
  const repeating = await page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity
  ).length);
  expect(repeating).toBeLessThanOrEqual(2);
  await page.goto("/dev/widget-gallery?motion=reduced");
  const faces = page.locator(".cc-orb-gallery [data-orb-state]");
  await expect(faces).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`service icons have their own space at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/services?motion=reduced");
    const group = page.getByTestId("healthy-group-avalar");
    await group.getByRole("button").first().click();
    const rows = group.locator(".health-row");
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      const gap = await row.evaluate(el => el.querySelector("h3")!.getBoundingClientRect().left
        - el.querySelector(".health-row__icon")!.getBoundingClientRect().right);
      expect(gap).toBeGreaterThanOrEqual(12);
    }
  });
}


for (const width of [1280, 720]) {
  test(`home kettle fits its contents when off or heating at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1280 });
    const snapshot = await (await request.get("/api/v1/snapshot?scenario=ha-healthy")).json();
    const kettle = snapshot.services.find((s: { data: Record<string, unknown> }) => "availableTeaModes" in s.data);
    await page.route("**/api/v1/snapshot?*", route => route.fulfill({ json: snapshot }));
    for (const stage of ["off", "on"]) {
      kettle.data.stage = stage;
      await page.goto("/home?motion=reduced");
      const card = page.getByTestId("kettle-control");
      await expect(card).toHaveAttribute("data-instrument-active", String(stage === "on"));
      const bounds = await card.evaluate(el => {
        const actions = el.querySelector(".kettle-control__actions")!;
        const rect = el.getBoundingClientRect();
        return { unused: rect.bottom - actions.getBoundingClientRect().bottom,
          height: rect.height, gauge: el.querySelector(".cc-gauge")!.getBoundingClientRect().height };
      });
      expect(bounds.unused).toBeLessThanOrEqual(20);
      expect(bounds.height).toBeLessThan(245);
      expect(bounds.gauge).toBeGreaterThan(40);
    }
  });
}
