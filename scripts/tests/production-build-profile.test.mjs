import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  productionBuildEnvironment,
  productionBuildProfile,
  productionBuildProfileName,
  productionBuildCapabilities,
  safeDelayedCapabilityOverrides,
  loadProductionCapabilityOverrides,
  resolveCapabilityOverridesPath
} from "../production-build-profile.mjs";

const root = resolve(import.meta.dirname, "../..");

const expectedProfile = {
  VITE_V2_VISUAL_SHELL: "true",
  VITE_OVERVIEW_V2_ENABLED: "true",
  VITE_OVERVIEW_EDITOR_ENABLED: "true",
  VITE_PLANNING_OVERVIEW_ENABLED: "true",
  VITE_PLANNING_TASKS_ROUTE_ENABLED: "true",
  VITE_PLANNING_CALENDAR_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDERS_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDER_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_TASK_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_START_LOCKED: "true"
};

test("the accepted-v2 profile is complete and cannot be overridden by inherited VITE values", () => {
  assert.equal(productionBuildProfileName, "accepted-v2");
  assert.deepEqual(productionBuildProfile, expectedProfile);
  const environment = productionBuildEnvironment({
    VITE_V2_VISUAL_SHELL: "false",
    VITE_PLANNING_TASKS_ROUTE_ENABLED: "false",
    PANEL_WRITES_ENABLED: "false"
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedProfile).map((key) => [key, environment[key]])),
    expectedProfile
  );
  assert.equal(environment.PANEL_WRITES_ENABLED, "false");
});

test("only the four explicitly allowlisted capability IDs overlay the accepted baseline", () => {
  const overrides = safeDelayedCapabilityOverrides({ overrides: {
    planning_calendar_route: false,
    VITE_TOUCH_INPUT_LOCK_ENABLED: false,
    arbitrary: false
  } });
  assert.deepEqual(overrides, { planning_calendar_route: false });
  const capabilities = productionBuildCapabilities(overrides);
  assert.equal(capabilities.baseline.planning_calendar_route, true);
  assert.equal(capabilities.active.planning_calendar_route, false);
  assert.equal(Object.keys(capabilities.active).length, 4);
});

test("normal production build resolves the Panel-owned LOCALAPPDATA store and an explicit path wins", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-production-store-"));
  const localAppData = join(root, "local-app-data");
  const canonical = join(localAppData, "ArtemControlCenter", "capability-overrides.json");
  const explicit = join(root, "explicit-overrides.json");
  mkdirSync(join(localAppData, "ArtemControlCenter"), { recursive: true });
  writeFileSync(canonical, JSON.stringify({
    schemaVersion: "capability-overrides.v1", revision: 2, updatedAt: "2026-08-26T00:00:00Z",
    overrides: { planning_calendar_route: false }
  }));
  writeFileSync(explicit, JSON.stringify({
    schemaVersion: "capability-overrides.v1", revision: 3, updatedAt: "2026-08-26T00:00:00Z",
    overrides: { planning_tasks_route: false }
  }));

  assert.equal(resolveCapabilityOverridesPath({ LOCALAPPDATA: localAppData }), canonical);
  assert.deepEqual(loadProductionCapabilityOverrides({ LOCALAPPDATA: localAppData }), { planning_calendar_route: false });
  assert.deepEqual(
    loadProductionCapabilityOverrides({ LOCALAPPDATA: localAppData, PANEL_CAPABILITY_OVERRIDES_PATH: explicit }),
    { planning_tasks_route: false }
  );
  assert.deepEqual(loadProductionCapabilityOverrides({}), {});
});

test("the package exposes the production build command and Windows workflow invokes it", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["build:production"], "node scripts/build-production.mjs");
  assert.match(
    readFileSync(resolve(root, "scripts/windows/install-production.ps1"), "utf8"),
    /build:production/
  );
  assert.match(
    readFileSync(resolve(root, "scripts/windows/update-production.ps1"), "utf8"),
    /build:production/
  );
});
