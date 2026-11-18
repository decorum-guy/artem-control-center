import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "Run with the V3 skin on the V2 shell.");

async function openGallery(page: Page, query = "") {
  await page.goto("/dev/widget-gallery" + query);
  await expect(page.getByTestId("v3-primitive-gallery")).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`shell and accessible controls fit ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/overview");
    await expect(page.locator("html")).toHaveAttribute("data-skin", "v3");
    await expect(page.locator(".app")).toHaveClass(/skin-v3/);
    await expect(page.locator(".v2-shell")).toBeVisible();
    if (viewport.width > viewport.height) {
      const rail = await page.getByTestId("v2-navigation-rail").boundingBox();
      const header = await page.getByTestId("product-header").boundingBox();
      expect(rail?.width).toBe(176);
      expect(header?.height).toBe(64);
      expect(header?.width).toBe(1104);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await openGallery(page);
    const gallery = page.getByTestId("v3-primitive-gallery");
    expect(await gallery.locator("button, [role=slider]").evaluateAll((elements) =>
      elements.filter((el) => el.getBoundingClientRect().width < 48 || el.getBoundingClientRect().height < 48)
        .map((el) => el.getAttribute("aria-label") ?? el.textContent))).toEqual([]);
    const trigger = gallery.getByRole("button", { name: /Режим.*Автоматически/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("listbox", { name: "Режим" });
    await expect(list.getByRole("option", { selected: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(trigger.or(gallery.getByRole("button", { name: /Режим.*Тихий/ }))).toBeFocused();
    const selected = gallery.getByRole("button", { name: /Режим.*Тихий/ });
    await expect(selected).toHaveCSS("outline-style", "solid");
    await expect(selected).toHaveCSS("outline-width", "3px");
    await selected.press("Space");
    await page.keyboard.press("Escape");
    await expect(selected).toBeFocused();
    const slider = gallery.getByRole("slider", { name: "Громкость" });
    await slider.focus();
    await slider.press("ArrowRight");
    await slider.press("PageUp");
    await expect(slider).toHaveAttribute("aria-valuenow", "43");
    await slider.press("Home");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await gallery.getByRole("radio", { name: "Ночь" }).press("ArrowRight");
    await expect(gallery.getByRole("radio", { name: "День" })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}

for (const theme of ["night", "day"]) {
  for (const accent of ["ice","iris","lagoon","rose"]) {
    test(`actual ${theme} ${accent} text and tinted status tokens meet 4.5:1`, async ({ page }) => {
      await page.addInitScript(value => localStorage.setItem("artem-control-center.accent", value), accent);
      await openGallery(page, "?theme=" + theme);
      const failed = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".skin-v3")!);
        const rgb = (token: string) => style.getPropertyValue("--cc-" + token).trim().slice(1).match(/../g)!.map((x) => parseInt(x, 16));
        const luminance = (color: number[]) => color.reduce((sum, c, i) => {
          const n = c / 255;
          return sum + [0.2126, 0.7152, 0.0722][i] * (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        }, 0);
        const ratio = (a: number[], b: number[]) => {
          const light = luminance(a), dark = luminance(b);
          return (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
        };
        const bad: string[] = [];
        for (const name of ["text", "text-secondary", "text-muted", "accent", "heat", "success", "warning", "danger", "stale", "offline", "unavailable", "uncertain"]) {
          const fg = rgb(name);
          for (const surface of ["canvas", "rail", "surface-1", "surface-2", "interactive", "hover", "pressed"]) {
            if (ratio(fg, rgb(surface)) < 4.5) bad.push(name + " on " + surface);
          }
          if (!name.startsWith("text") && ratio(fg, rgb("surface-1").map((v, i) => Math.round(v * .88 + fg[i] * .12))) < 4.5) bad.push(name + " tint");
        }
        if (ratio(rgb("on-accent"), rgb("accent")) < 4.5) bad.push("primary button");
        return bad;
      });
      expect(failed).toEqual([]);
      expect(await page.evaluate(() => document.fonts.check('16px "Manrope Variable"', "Я")
        && document.fonts.check('16px "JetBrains Mono Variable"', "Я"))).toBe(true);
    });
  }
}

test("continuous motion stops in reduced, energy-saving and background modes", async ({ page }) => {
  const infinite = () => page.evaluate(() => document.getAnimations().filter((a) =>
    a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length);
  for (const mode of ["reduced", "low-performance", "battery-saving"]) {
    await openGallery(page, "?motion=" + mode);
    expect(await infinite()).toBe(0);
  }
  await openGallery(page, "?motion=full");
  expect(await infinite()).toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-page-hidden", "");
  expect(await infinite()).toBe(0);
});
