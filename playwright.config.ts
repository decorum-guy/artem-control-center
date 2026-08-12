import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5,
    hasTouch: true
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, hasTouch: true }
    }
  ],
  webServer: {
    command: "PANEL_AGENT_RELOAD=false PANEL_WRITES_ENABLED=true PANEL_COFFEE_TIMING_WRITES_ENABLED=true PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=true PANEL_COFFEE_ACTIONS_ENABLED=true npm run dev:fixtures",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
