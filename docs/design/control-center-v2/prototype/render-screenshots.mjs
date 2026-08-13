import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const prototypeDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(prototypeDir, "../screenshots");
const views = [
  "overview-night",
  "overview-day",
  "overview-edit",
  "weather-clear-day",
  "weather-rain-night",
  "services-degraded",
  "settings",
  "planning"
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  hasTouch: true,
  reducedMotion: "no-preference"
});
for (const view of views) {
  const page = await context.newPage();
  const url = new URL(`file://${path.join(prototypeDir, "index.html")}`);
  url.searchParams.set("view", view);
  await page.goto(url.href);
  await page.locator(".cc-app").waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));

  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".cc-app").getBoundingClientRect();
    const undersizedButtons = [...document.querySelectorAll("button")]
      .map((button) => ({ label: button.textContent.trim() || button.getAttribute("aria-label"), rect: button.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 48 || rect.height < 48)
      .map(({ label, rect }) => ({ label, width: rect.width, height: rect.height }));

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      app: { x: app.x, y: app.y, width: app.width, height: app.height },
      scroll: { x: window.scrollX, y: window.scrollY },
      undersizedButtons
    };
  });

  if (
    metrics.viewport.width !== 1280 ||
    metrics.viewport.height !== 720 ||
    metrics.app.x !== 0 ||
    metrics.app.y !== 0 ||
    metrics.app.width !== 1280 ||
    metrics.app.height !== 720 ||
    metrics.scroll.x !== 0 ||
    metrics.scroll.y !== 0 ||
    metrics.undersizedButtons.length
  ) {
    throw new Error(`${view} failed prototype geometry checks: ${JSON.stringify(metrics)}`);
  }

  await page.screenshot({ path: path.join(outputDir, `${view}.png`), scale: "css" });
  await page.close();
}

await browser.close();
