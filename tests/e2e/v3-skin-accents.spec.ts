import { expect, test, type Locator } from "@playwright/test";
import { observeCoffeeCycle } from "./cabinCoffee";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true", "Cabin profile");

for (const [width, custom] of [[1280, false], [1280, true], [720, false], [720, true]] as const) {
  test(`coffee glass, placement and phase animation at ${width} with ${custom ? "custom" : "centered"} artwork`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: width === 720 ? 1280 : 720 });
    const phases = await observeCoffeeCycle(page, baseURL!, custom);
    for (const phase of phases) {
      expect(phase.rimClearance, phase.phase).toBeGreaterThan(8);
      expect(phase.footOverlap, phase.phase).toBeGreaterThan(0);
      for (const x of [phase.minX, phase.maxX]) expect(Math.abs(x - (custom ? 12 : 0)), phase.phase).toBeLessThan(2);
      for (const y of [phase.minY, phase.maxY]) expect(Math.abs(y - (custom ? -4 : 0)), phase.phase).toBeLessThan(2);
    }
    for (const phase of phases) expect(phase.scales, phase.phase).toBeGreaterThan(1);
    expect(phases.at(-1)!.lastScale).toBeCloseTo(.94, 2);
    await page.reload();
    await expect(page.locator(".coffee-panel--overview").first()).toHaveAttribute("data-image-scale", custom ? "120" : "100");
  });
}

test("palette selection reaches the shell and dialogs and survives a reload", async ({ page }) => {
  await page.goto("/settings?motion=reduced");
  for (const theme of ["night","day"]) {
    await page.getByTestId("settings-theme-" + theme).click();
    const colors = new Set<string>();
    for (const name of ["ice","iris","lagoon","rose"]) {
      const button = page.locator('[data-accent-swatch="' + name + '"]');
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed","true");
      const values = await page.evaluate(() => [document.documentElement, document.querySelector(".app")!].map(el =>
        getComputedStyle(el).getPropertyValue("--cc-accent").trim()));
      expect(values[0]).toEqual(values[1]);
      colors.add(values[0]);
    }
    expect(colors.size).toBe(4);
  }
  await page.goto("/home?motion=reduced");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent","rose");
  await expect(page.locator("html")).toHaveAttribute("data-theme","day");
  const gauges = page.locator(".cc-gauge:has(.cc-gauge-center)");
  await expect(gauges.first()).toBeVisible();
  await verifyDialClearance(gauges);
});

async function verifyDialClearance(gauges: Locator) {
  const gaps = await gauges.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    const face = node.querySelector("circle")!;
    const radius = (Number(face.getAttribute("r")) - Number(face.getAttribute("stroke-width")) / 2)
      * rect.width / face.ownerSVGElement!.viewBox.baseVal.width;
    const range = document.createRange(); range.selectNodeContents(node.querySelector(".cc-gauge-center")!);
    const text = range.getBoundingClientRect();
    return radius - Math.max(...[text.left,text.right].flatMap(x => [text.top,text.bottom].map(y =>
      Math.hypot(x-rect.left-rect.width/2,y-rect.top-rect.height/2))));
  }));
  expect(Math.min(...gaps)).toBeGreaterThan(2);
}


test("long, fractional and missing kettle readings stay inside the ring", async ({ page, request }) => {
  const sample = await (await request.get("/api/v1/snapshot?scenario=ha-healthy")).json();
  const kettle = sample.services.find((service: { data: Record<string, unknown> }) => "availableTeaModes" in service.data);
  expect(kettle).toBeDefined();
  await page.route("**/api/v1/snapshot?*", route => route.fulfill({ json: sample }));
  for (const [value, text] of [[100,"100°"],[99.588,"99,6°"],[null,"—°"]] as const) {
    kettle.data.currentTemperature = value;
    await page.goto("/home?motion=reduced");
    const gauge = page.getByTestId("kettle-current-temperature").locator(".cc-gauge");
    await expect(gauge).toHaveText(text);
    await verifyDialClearance(gauge);
  }
});

test("a fresh kiosk picks up the last palette from Panel Agent", async ({ browser, request, baseURL }) => {
  const sample = await (await request.get("/api/v1/snapshot?scenario=ha-healthy")).json();
  sample.mode = "production";
  let saved = { accent: "iris", colorMode: "night" };
  for (const cold of [false, true]) {
    const context = await browser.newContext({ baseURL });
    await context.route("**/api/v1/snapshot?*", route => route.fulfill({ json: sample }));
    await context.route("**/api/v1/settings/appearance", async route => {
      if (route.request().method() === "PATCH") saved = { ...saved, ...route.request().postDataJSON() };
      await route.fulfill({ json: saved });
    });
    const page = await context.newPage();
    await page.goto("/settings?motion=reduced");
    await expect(page.locator("html")).toHaveAttribute("data-accent", cold ? "rose" : "iris");
    if (!cold) {
      await page.locator('[data-accent-swatch="rose"]').click();
      await expect.poll(() => saved.accent).toBe("rose");
    }
    await context.close();
  }
});
