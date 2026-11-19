import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "The instrument faces belong to the Cabin profile.");

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`coffee dial keeps a visible glass rim on both pages at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const route of ["overview", "home"]) {
      await page.goto(`/${route}?scenario=coffee-ready&motion=reduced`);
      const svg = page.locator(".cc-coffee-dial svg").first();
      await expect(svg).toBeVisible();
      const { sizeRatio, clearance, centerOffset } = await svg.evaluate(element => {
        const frame = element.closest<HTMLElement>(".coffee-asset")!;
        const glass = frame.getBoundingClientRect();
        const face = element.closest("svg")!;
        const circle = face.querySelector<SVGCircleElement>(".cc-gauge-track")!;
        const box = face.getBoundingClientRect();
        const originalSize = Math.min(.87 * frame.clientWidth, .79 * frame.clientHeight, 222);
        const paintedDiameter = (2 * circle.r.baseVal.value + Number(circle.getAttribute("stroke-width")))
          * box.width / face.viewBox.baseVal.width;
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        return {
          sizeRatio: box.width / originalSize,
          clearance: Math.min(cx - glass.left, glass.right - cx, cy - glass.top, glass.bottom - cy) - paintedDiameter / 2,
          centerOffset: Math.max(Math.abs(cx - glass.left - glass.width / 2), Math.abs(cy - glass.top - glass.height / 2))
        };
      });
      expect(sizeRatio).toBeCloseTo(1.1, 2);
      expect(clearance).toBeGreaterThanOrEqual(4);
      expect(centerOffset).toBeLessThan(1);
    }
  });
}

for (const [scenario, kind] of [
  ["coffee-off", "idle"], ["coffee-warming", "progress"], ["coffee-ready", "full"],
  ["coffee-running-too-long", "warning"], ["coffee-stale", "dashed"], ["ha-offline", "dashed"]
]) {
  test(`coffee instrument presents the confirmed state in ${scenario}`, async ({ page }) => {
    await page.goto("/home?scenario=" + scenario + "&motion=reduced");
    const coffee = page.locator(".coffee-panel").first();
    const dial = coffee.locator(".cc-coffee-dial");
    await expect(dial).toBeVisible();
    const artwork = coffee.locator(".cc-coffee-position");
    const dialLayer = await dial.evaluate(el => Number(getComputedStyle(el).zIndex));
    const artworkLayer = await artwork.evaluate(el => Number(getComputedStyle(el).zIndex));
    expect(dialLayer).toBeLessThan(artworkLayer);
    const value = dial.locator(".cc-gauge-value");
    if (kind === "warning") {
      await expect(dial.getByRole("img", { name: "Работает слишком долго", exact: true })).toBeVisible();
      await expect(dial.locator('g[data-tone="warning"] > circle')).toHaveCount(1);
      await expect(value).toHaveCSS("stroke-dasharray", "none");
      await expect(value).toHaveCSS("stroke", await coffee.evaluate(el => getComputedStyle(el).borderTopColor));
    } else if (kind === "full") await expect(value).toHaveAttribute("stroke-dasharray", "100 100");
    else if (kind === "progress") {
      await expect(value).toHaveCount(1);
      const percent = Number((await value.getAttribute("stroke-dasharray"))?.split(" ")[0]);
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThan(100);
    } else {
      await expect(value).toHaveCount(0);
      await expect(dial.locator(".cc-gauge-track--dashed")).toHaveCount(kind === "dashed" ? 1 : 0);
      if (kind === "dashed") await expect(dial.locator('g[data-tone="offline"] > circle')).toHaveAttribute("stroke-dasharray", "2 6");
    }
    if (kind === "full" || kind === "progress" || kind === "warning") {
      const { painted, requested } = await value.evaluate(element => {
        const ring = element as SVGCircleElement;
        const samples = 360;
        let hits = 0;
        for (let step = 0; step < samples; step++) {
          const angle = 2 * Math.PI * step / samples;
          const x = ring.cx.baseVal.value + ring.r.baseVal.value * Math.cos(angle);
          const y = ring.cy.baseVal.value + ring.r.baseVal.value * Math.sin(angle);
          if (ring.isPointInStroke(new DOMPoint(x, y))) hits++;
        }
        const arc = ring.getAttribute("stroke-dasharray");
        return { painted: hits / samples, requested: arc ? parseFloat(arc) / 100 : 1 };
      });
      // Round caps extend a partial arc slightly beyond its nominal endpoints.
      if (kind !== "progress") expect(painted).toBe(1);
      else expect(Math.abs(painted - requested)).toBeLessThan(.035);
    }
  });
}
