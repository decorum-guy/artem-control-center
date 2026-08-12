import { defineConfig, devices } from "@playwright/test";

const planningOverviewFlag = process.env.B2_PLANNING_OVERVIEW_ENABLED === "true" ? "true" : "false";

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
    command: `PANEL_AGENT_RELOAD=false PANEL_WRITES_ENABLED=true PANEL_COFFEE_TIMING_WRITES_ENABLED=true PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=true PANEL_COFFEE_ACTIONS_ENABLED=true PANEL_PLANNING_ENABLED=true PANEL_PLANNING_BASE_URL=http://fixture.test PANEL_PLANNING_INTERNAL_SECRET=synthetic-internal-secret PANEL_PLANNING_SECRET=synthetic-panel-agent-secret PANEL_PLANNING_FIXTURE_SCENARIO=overview-healthy VITE_PLANNING_OVERVIEW_ENABLED=${planningOverviewFlag} npm run dev:fixtures`,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
