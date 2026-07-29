import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const projectRoot = process.cwd();
const outputDir = resolve(projectRoot, "..", "artifacts", "ui-review");
const baseUrl = process.env.ARTEM_REVIEW_URL ?? "http://127.0.0.1:5173";

const captures = [
  {
    name: "overview-day-1920x1080.png",
    path: "/overview?theme=day&scenario=ha-healthy",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "overview-night-1920x1080.png",
    path: "/overview?theme=night&scenario=ha-healthy",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "coffee-warming-1920x1080.png",
    path: "/overview?theme=night&scenario=coffee-warming",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "coffee-ready-1920x1080.png",
    path: "/overview?theme=night&scenario=coffee-ready",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "coffee-running-too-long-1920x1080.png",
    path: "/overview?theme=night&scenario=coffee-running-too-long",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "home-night-1920x1080.png",
    path: "/home?theme=night&scenario=alice-down-policy-stale",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "services-night-1920x1080.png",
    path: "/services?theme=night&scenario=alice-down-policy-stale",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "overview-reduced-motion-1920x1080.png",
    path: "/overview?theme=night&scenario=coffee-warming&motion=reduced",
    viewport: { width: 1920, height: 1080 }
  },
  {
    name: "overview-night-1366x768.png",
    path: "/overview?theme=night&scenario=coffee-warming",
    viewport: { width: 1366, height: 768 }
  },
  {
    name: "services-day-1366x768.png",
    path: "/services?theme=day&scenario=ha-healthy",
    viewport: { width: 1366, height: 768 }
  },
  {
    name: "overview-handheld-800x900.png",
    path: "/overview?theme=day&scenario=coffee-ready",
    viewport: { width: 800, height: 900 }
  }
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  for (const capture of captures) {
    const page = await browser.newPage({
      viewport: capture.viewport,
      deviceScaleFactor: 1,
      colorScheme: capture.path.includes("theme=day") ? "light" : "dark",
      reducedMotion: capture.path.includes("motion=reduced") ? "reduce" : "no-preference"
    });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "networkidle" });
    await page.getByTestId(
      capture.path.startsWith("/home")
        ? "route-home"
        : capture.path.startsWith("/services")
          ? "route-services"
          : "route-overview"
    ).waitFor();
    await page.screenshot({ path: resolve(outputDir, capture.name), fullPage: false });
    if (consoleErrors.length) {
      throw new Error(`${capture.name}: browser console errors: ${consoleErrors.join(" | ")}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`Captured ${captures.length} visual review screenshots in ${outputDir}`);
