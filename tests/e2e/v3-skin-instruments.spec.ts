import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "The instrument faces belong to the Cabin profile.");

for (const [scenario, kind] of [["coffee-off", "idle"], ["coffee-warming", "progress"], ["coffee-ready", "full"], ["coffee-running-too-long", "dashed"], ["ha-offline", "dashed"]]) {
  test(`coffee instrument presents the confirmed state in ${scenario}`, async ({ page }) => {
    await page.goto("/home?scenario=" + scenario + "&motion=reduced");
    const coffee = page.locator(".coffee-panel").first();
    const dial = coffee.locator(".cc-coffee-dial");
    await expect(dial).toBeVisible();
    const value = dial.locator(".cc-gauge-value");
    if (kind === "full") await expect(value).toHaveAttribute("stroke-dasharray", "100 100");
    else if (kind === "progress") {
      await expect(value).toHaveCount(1);
      const percent = Number((await value.getAttribute("stroke-dasharray"))?.split(" ")[0]);
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThan(100);
    } else {
      await expect(value).toHaveCount(0);
      await expect(dial.locator(".cc-gauge-track--dashed")).toHaveCount(kind === "dashed" ? 1 : 0);
    }
  });
}
