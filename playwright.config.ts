import { defineConfig, devices } from "@playwright/test";

const planningOverviewFlag = process.env.B2_PLANNING_OVERVIEW_ENABLED === "true" ? "true" : "false";
const planningTasksFlag = process.env.B3_PLANNING_TASKS_ROUTE_ENABLED === "true" ? "true" : "false";
const planningCalendarFlag = process.env.B3_PLANNING_CALENDAR_ROUTE_ENABLED === "true" ? "true" : "false";
const planningRemindersFlag = process.env.B3_PLANNING_REMINDERS_ROUTE_ENABLED === "true" ? "true" : "false";
const planningReminderMutationsFlag = process.env.VITE_PLANNING_REMINDER_MUTATIONS_ENABLED === "true" ? "true" : "false";
const planningTaskMutationsFlag = process.env.VITE_PLANNING_TASK_MUTATIONS_ENABLED === "true" ? "true" : "false";
const planningCalendarMutationsFlag = process.env.VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED === "true" ? "true" : "false";
const visualShellFlag = process.env.VITE_V2_VISUAL_SHELL === "true" ? "true" : "false";
const overviewV2Flag = process.env.VITE_OVERVIEW_V2_ENABLED === "true" ? "true" : "false";
const overviewEditorFlag = process.env.VITE_OVERVIEW_EDITOR_ENABLED === "true" ? "true" : "false";
const overviewLayoutWritesFlag = process.env.PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED === "true" ? "true" : "false";
const overviewLayoutPath = process.env.PANEL_OVERVIEW_LAYOUT_PATH ?? ".cache/overview-layout.json";
const touchInputLockFlag = process.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true" ? "true" : "false";
const touchInputLockStartLockedFlag = process.env.VITE_TOUCH_INPUT_LOCK_START_LOCKED === "true" ? "true" : "false";
const coffeeDiaryPath = process.env.PANEL_COFFEE_DIARY_PATH ?? ".cache/coffee-diary-e2e.json";
const planningFixtureScenario = planningTasksFlag === "true" || planningCalendarFlag === "true" || planningRemindersFlag === "true"
  ? "b3-healthy"
  : "overview-healthy";
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:5173",
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
  webServer: useExternalServer ? undefined : {
    command: `PANEL_AGENT_RELOAD=false PANEL_WRITES_ENABLED=true PANEL_COFFEE_DIARY_PATH=${coffeeDiaryPath} PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED=${overviewLayoutWritesFlag} PANEL_OVERVIEW_LAYOUT_PATH=${overviewLayoutPath} PANEL_COFFEE_TIMING_WRITES_ENABLED=true PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=true PANEL_COFFEE_ACTIONS_ENABLED=true PANEL_PLANNING_ENABLED=true PANEL_PLANNING_BASE_URL=http://fixture.test PANEL_PLANNING_INTERNAL_SECRET=synthetic-internal-secret PANEL_PLANNING_SECRET=synthetic-panel-agent-secret PANEL_PLANNING_FIXTURE_SCENARIO=${planningFixtureScenario} PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED=${planningReminderMutationsFlag} PANEL_PLANNING_TASK_MUTATIONS_ENABLED=${planningTaskMutationsFlag} PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED=${planningCalendarMutationsFlag} VITE_V2_VISUAL_SHELL=${visualShellFlag} VITE_OVERVIEW_V2_ENABLED=${overviewV2Flag} VITE_OVERVIEW_EDITOR_ENABLED=${overviewEditorFlag} VITE_PLANNING_OVERVIEW_ENABLED=${planningOverviewFlag} VITE_PLANNING_TASKS_ROUTE_ENABLED=${planningTasksFlag} VITE_PLANNING_CALENDAR_ROUTE_ENABLED=${planningCalendarFlag} VITE_PLANNING_REMINDERS_ROUTE_ENABLED=${planningRemindersFlag} VITE_PLANNING_REMINDER_MUTATIONS_ENABLED=${planningReminderMutationsFlag} VITE_PLANNING_TASK_MUTATIONS_ENABLED=${planningTaskMutationsFlag} VITE_TOUCH_INPUT_LOCK_ENABLED=${touchInputLockFlag} VITE_TOUCH_INPUT_LOCK_START_LOCKED=${touchInputLockStartLockedFlag} npm run dev:fixtures`,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
