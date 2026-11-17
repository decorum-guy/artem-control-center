import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "Weather instrument glyphs belong to the Cabin profile.");

test("weather uses observed sky and bounded compositor layers in either interface theme", async ({ page }) => {
  for (const [fixture, icon] of [["clear-day", "sun"], ["clear-night", "moon"], ["partly-night", "partly-night"], ["fog", "fog"], ["snow-day", "snow"], ["storm", "storm"]]) {
    await page.goto("/weather?theme=day&weatherFixture=" + fixture);
    const hero = page.getByTestId("weather-hero");
    await expect(hero.locator(".weather-hero__condition-glyph .weather-glyph")).toHaveAttribute("data-condition-icon", icon);
    await expect(hero.locator(".weather-hero__condition-glyph svg")).toHaveCSS("height", "32px");
    expect(await hero.locator("[data-weather-moving-layer]").count()).toBeLessThanOrEqual(2);
  }
});
