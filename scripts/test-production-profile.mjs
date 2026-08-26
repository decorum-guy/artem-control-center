import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { productionBuildEnvironment, productionBuildProfile } from "./production-build-profile.mjs";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

function npmArguments(...values) {
  return npmCli ? [npmCli, ...values] : values;
}

const profileEnvironment = productionBuildEnvironment();
Object.assign(profileEnvironment, {
  // These names are test-only aliases consumed by the existing B2/B3 specs.
  B2_PLANNING_OVERVIEW_ENABLED: productionBuildProfile.VITE_PLANNING_OVERVIEW_ENABLED,
  B3_PLANNING_TASKS_ROUTE_ENABLED: productionBuildProfile.VITE_PLANNING_TASKS_ROUTE_ENABLED,
  B3_PLANNING_CALENDAR_ROUTE_ENABLED: productionBuildProfile.VITE_PLANNING_CALENDAR_ROUTE_ENABLED,
  B3_PLANNING_REMINDERS_ROUTE_ENABLED: productionBuildProfile.VITE_PLANNING_REMINDERS_ROUTE_ENABLED,
  PANEL_AGENT_MODE: "fixtures",
  PANEL_WRITES_ENABLED: "true",
  PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED: "true",
  PANEL_PLANNING_ENABLED: "true",
  PANEL_PLANNING_BASE_URL: "http://fixture.test",
  PANEL_PLANNING_INTERNAL_SECRET: "synthetic-internal-secret",
  PANEL_PLANNING_SECRET: "synthetic-panel-agent-secret",
  PANEL_PLANNING_FIXTURE_SCENARIO: "b3-healthy",
  PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED: "true",
  PANEL_PLANNING_TASK_MUTATIONS_ENABLED: "true",
  PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED: "true",
  PANEL_COFFEE_TIMING_WRITES_ENABLED: "true",
  PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED: "true",
  PANEL_COFFEE_ACTIONS_ENABLED: "true"
});

const buildResult = spawnSync(command, npmArguments("run", "build:production"), {
  cwd: root,
  env: profileEnvironment,
  stdio: "inherit",
  shell: false,
  windowsHide: true
});
if (buildResult.error || buildResult.status !== 0) {
  if (buildResult.error) console.error(buildResult.error);
  process.exit(buildResult.status ?? 1);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-production-profile-"));
const runtimeRoot = join(temporaryRoot, "ArtemControlCenter");
const commandPath = join(runtimeRoot, "runtime-command.json");
const accessPolicyPath = join(runtimeRoot, "access-policy.json");
mkdirSync(runtimeRoot, { recursive: true });
writeFileSync(accessPolicyPath, `${JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  baseProfile: "standard",
  temporaryFullExpiresAt: null,
  pin: null,
  failedUnlocks: [],
  lockoutUntil: null
})}\n`, "utf8");
const runtimeEnvironment = {
  ...profileEnvironment,
  LOCALAPPDATA: temporaryRoot,
  PANEL_FIXTURE_WRITES_ENABLED: "true",
  PANEL_ACCESS_POLICY_PATH: accessPolicyPath,
  PANEL_ACCESS_AUDIT_DIR: join(runtimeRoot, "audit"),
  PANEL_OVERVIEW_LAYOUT_PATH: join(runtimeRoot, "overview-layout.json"),
  PANEL_CALENDAR_DISPLAY_COLOR_PATH: join(runtimeRoot, "calendar-display-colors.json"),
  PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED: "true",
  PANEL_PLANNING_CACHE_PATH: join(runtimeRoot, "planning-cache.json")
};
const runtime = spawn(process.execPath, ["scripts/production-runtime.mjs"], {
  cwd: root,
  env: runtimeEnvironment,
  stdio: "inherit",
  windowsHide: true
});

async function waitForReady() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8787/health/ready");
      if (response.ok) return;
    } catch {
      // The production supervisor is expected to take a moment to spawn Uvicorn.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Timed out waiting for the production-profile runtime");
}

try {
  await waitForReady();
  const e2eEnvironment = {
    ...profileEnvironment,
    PLAYWRIGHT_BASE_URL: "http://127.0.0.1:8787",
    PLAYWRIGHT_EXTERNAL_SERVER: "true",
    V2_ARTIFACT_DIR: "artifacts/production-profile/v2-shell",
    V2_WEATHER_ARTIFACT_DIR: "artifacts/production-profile/v2-weather",
    V2_ROUTE_DENSITY_ARTIFACT_DIR: "artifacts/production-profile/v2-route-density",
    V2_SETTINGS_ARTIFACT_DIR: "artifacts/production-profile/v2-settings",
    V2_OVERVIEW_ARTIFACT_DIR: "artifacts/production-profile/v2-overview-grid",
    V2_OVERVIEW_CURATED_ARTIFACT_DIR: "artifacts/production-profile/v2-overview-curated",
    V2_OVERVIEW_EDITOR_ARTIFACT_DIR: "artifacts/production-profile/v2-overview-editor",
    PR9_ARTIFACT_DIR: "artifacts/production-profile/v2-planning-foundation",
    B3_ARTIFACT_DIR: "artifacts/production-profile/b3-planning-routes",
    B4_ARTIFACT_DIR: "artifacts/production-profile/b4-reminders",
    B4_TASK_ARTIFACT_DIR: "artifacts/production-profile/b4-tasks",
    B4_CALENDAR_ARTIFACT_DIR: "artifacts/production-profile/b4-calendar",
    ICLOUD_CALENDAR_PHASE_B_ARTIFACT_DIR: "artifacts/production-profile/icloud-calendar-phase-b",
    TOUCH_LOCK_ARTIFACT_DIR: "artifacts/production-profile/touch-lock"
  };
  // The production bundle intentionally removes DEV-only visual fixture
  // query seams. The production-profile spec uses the real bundle and
  // synthetic server policy; the legacy review packs remain runnable by
  // passing their paths explicitly to this command.
  const acceptedProductionSuites = ["tests/e2e/production-profile.spec.ts"];
  const requestedSuites = process.argv.length > 2 ? process.argv.slice(2) : acceptedProductionSuites;
  const args = npmArguments("run", "test:e2e", "--", ...requestedSuites);
  const result = spawnSync(command, args, {
    cwd: root,
    env: e2eEnvironment,
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  if (runtime.exitCode === null) {
    writeFileSync(commandPath, `${JSON.stringify({
      schemaVersion: 1,
      action: "shutdown",
      manual: false,
      requestedAt: new Date().toISOString(),
      requestedBy: "production-profile-test"
    })}\n`, "utf8");
    await new Promise((resolvePromise) => runtime.once("exit", resolvePromise));
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
