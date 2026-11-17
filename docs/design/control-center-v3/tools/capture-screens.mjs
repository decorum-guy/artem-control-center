// Review screenshots for the V3 redesign (not a test, not a baseline).
// Start the fixture server first (tools/dev-fixtures-accepted-v2.sh [v3]).
// The page keeps an SSE connection open: never wait for networkidle.
//
// node docs/design/control-center-v3/tools/capture-screens.mjs <outDir>
//   [--routes overview,home] [--themes night,day] [--views landscape,portrait]
//   [--scenarios coffee-warming,coffee-ready,coffee-running-too-long,ha-offline]
//   [--scenario-routes overview,home] [--base http://127.0.0.1:5173] [--settle 1200]
// Writes <name>.png plus report.json (console errors, horizontal overflow, data-skin).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const require = createRequire(resolve(repoRoot, "package.json"));
const { chromium } = require("@playwright/test");

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--")) {
  console.error("Usage: node capture-screens.mjs <outDir> [options]");
  process.exit(2);
}
const outDir = resolve(args[0]);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const allRoutes = ["overview", "weather", "home", "services", "coffee-diary", "calendar", "tasks", "reminders", "backups", "apps", "system", "settings"];
const routes = option("routes", allRoutes.join(",")).split(",").filter(Boolean);
const themes = option("themes", "night,day").split(",").filter(Boolean);
const views = option("views", "landscape,portrait").split(",").filter(Boolean);
const scenarios = option("scenarios", "").split(",").filter(Boolean);
const scenarioRoutes = option("scenario-routes", "overview").split(",").filter(Boolean);
const baseUrl = option("base", "http://127.0.0.1:5173");
const settleMs = Number(option("settle", "1200"));
mkdirSync(outDir, { recursive: true });

const viewports = { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } };
const label = (view) => (view === "landscape" ? "1280x720" : "720x1280");

const captures = [];
for (const route of routes) for (const theme of themes) for (const view of views) {
  captures.push({ name: `${route}-${theme}-${label(view)}`, path: `/${route}?theme=${theme}`, view, theme });
}
for (const scenario of scenarios) for (const route of scenarioRoutes) for (const theme of themes) for (const view of views) {
  captures.push({ name: `${route}-${scenario}-${theme}-${label(view)}`, path: `/${route}?theme=${theme}&scenario=${scenario}`, view, theme });
}

const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const capture of captures) {
    const context = await browser.newContext({
      viewport: viewports[capture.view],
      deviceScaleFactor: 1.5,
      hasTouch: true,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      colorScheme: capture.theme === "day" ? "light" : "dark"
    });
    const page = await context.newPage();
    // Pin the visible clock for comparisons; timers and fixture subscriptions still run.
    await page.clock.setFixedTime(new Date("2026-11-17T18:42:00Z"));
    // The fixture app omits the production access router. Mirror the standard
    // read-only response from tests/e2e/access.spec.ts for every capture.
    await page.route(/\/api\/v1\/access(?:\?.*)?$/, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({ json: {
        schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard",
        temporaryFull: false, temporaryFullExpiresAt: null, pinConfigured: true,
        lockoutUntil: null, capabilities: {}
      } });
    });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 300)); });
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
    try {
      await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid^="route-"]').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(settleMs);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.screenshot({ path: resolve(outDir, `${capture.name}.png`), fullPage: false });
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        skin: document.documentElement.dataset.skin ?? null
      }));
      report.push({ name: capture.name, path: capture.path, errors, ...metrics });
    } catch (error) {
      report.push({ name: capture.name, path: capture.path, errors: [...errors, `CAPTURE FAILED: ${String(error).slice(0, 300)}`] });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
let noted = 0;
for (const entry of report) {
  const overflow = entry.scrollWidth > entry.clientWidth ? ` OVERFLOW ${entry.scrollWidth}>${entry.clientWidth}` : "";
  const failed = entry.errors.some((error) => error.startsWith("CAPTURE FAILED"));
  if (failed || overflow) {
    noted += 1;
    console.log(`${entry.name}:${overflow}${failed ? " capture failed" : ""}`);
  }
}
console.log(`Reviewed ${report.length} captures in ${outDir} (${noted} failed/overflowing; console/HTTP errors are in report.json)`);
if (noted) process.exitCode = 1;
