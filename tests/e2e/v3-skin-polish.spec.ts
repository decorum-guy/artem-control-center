import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_V3_VISUAL_SKIN !== "true",
  "Jarvis artwork and image variants belong to the Cabin profile.");

test("Jarvis renders all states, stays quiet at rest and loads size-appropriate artwork", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("artem-control-center.jarvis-visible", "true"));
  await page.goto("/home?motion=reduced");
  const launcher = page.getByTestId("jarvis-launcher");
  await expect(launcher.locator(".cc-jarvis-orb")).toHaveAttribute("data-orb-state", "idle");
  await expect(page.locator(".coffee-asset__image").first()).toHaveAttribute("src", /coffee-machine-(panel|overview).*\.webp/);
  expect(await launcher.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.goto("/home?scenario=coffee-warming&motion=full");
  await expect(page.locator(".coffee-panel").first()).toHaveAttribute("data-stage", "warming");
  const repeating = await page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity
  ).length);
  expect(repeating).toBeLessThanOrEqual(2);
  await page.goto("/dev/widget-gallery?motion=reduced");
  const faces = page.locator(".cc-orb-gallery [data-orb-state]");
  await expect(faces).toHaveCount(8);
  expect(await faces.evaluateAll(nodes => nodes.map(n => n.getAttribute("data-orb-state")))).toEqual([
    "idle","listening","transcribing","submitting","processing","speaking","ready","error"
  ]);
});
