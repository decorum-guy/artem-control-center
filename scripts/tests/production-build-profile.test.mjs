import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  resolveCapabilityOverridesPath,
  MAX_CAPABILITY_OVERRIDE_FILE_BYTES,
  PERSISTED_CAPABILITY_IDS
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

test("the persisted capability allow-list contains exactly the current mutable IDs", () => {
  const expectedIds = [
    "calendar_display_colors",
    "overview_layout_editor",
    "planning_overview",
    "planning_tasks_route",
    "planning_calendar_route",
    "planning_reminders_route",
    "home_climate_actions",
    "rog_g703_psu_actions"
  ];

  assert.deepEqual([...PERSISTED_CAPABILITY_IDS], expectedIds);
  assert.deepEqual(new Set(PERSISTED_CAPABILITY_IDS), new Set(expectedIds));
});

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
    overrides: { calendar_display_colors: false, planning_calendar_route: false }
  }));
  writeFileSync(explicit, JSON.stringify({
    schemaVersion: "capability-overrides.v1", revision: 3, updatedAt: "2026-08-26T00:00:00Z",
    overrides: { overview_layout_editor: false, planning_tasks_route: false }
  }));

  assert.equal(resolveCapabilityOverridesPath({ LOCALAPPDATA: localAppData }), canonical);
  assert.deepEqual(loadProductionCapabilityOverrides({ LOCALAPPDATA: localAppData }), { planning_calendar_route: false });
  assert.deepEqual(
    loadProductionCapabilityOverrides({ LOCALAPPDATA: localAppData, PANEL_CAPABILITY_OVERRIDES_PATH: explicit }),
    { planning_tasks_route: false }
  );
  assert.deepEqual(
    loadProductionCapabilityOverrides({ LOCALAPPDATA: join(root, "missing-local-app-data") }),
    {}
  );
  assert.deepEqual(productionBuildCapabilities({}).active, productionBuildCapabilities({}).baseline);
});

test("a mixed canonical store accepts immediate IDs but returns only delayed build overrides", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-mixed-production-store-"));
  const path = join(temporaryRoot, "capability-overrides.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "capability-overrides.v1",
    revision: 7,
    updatedAt: "2026-09-09T10:40:00Z",
    overrides: {
      home_climate_actions: true,
      rog_g703_psu_actions: true,
      overview_layout_editor: true,
      planning_calendar_route: false
    }
  }));

  assert.deepEqual(
    loadProductionCapabilityOverrides({ PANEL_CAPABILITY_OVERRIDES_PATH: path }),
    { planning_calendar_route: false }
  );
});

test("an immediate-only canonical store is accepted without producing build overrides", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-immediate-production-store-"));
  const path = join(temporaryRoot, "capability-overrides.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "capability-overrides.v1",
    revision: 8,
    updatedAt: "2026-09-09T10:40:00Z",
    overrides: {
      home_climate_actions: true,
      rog_g703_psu_actions: true
    }
  }));

  assert.deepEqual(
    loadProductionCapabilityOverrides({ PANEL_CAPABILITY_OVERRIDES_PATH: path }),
    {}
  );
});

test("mixed canonical store values only change the intended planning build capability", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-mixed-capability-build-"));
  const path = join(temporaryRoot, "capability-overrides.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "capability-overrides.v1",
    revision: 9,
    updatedAt: "2026-09-09T10:40:00Z",
    overrides: {
      home_climate_actions: true,
      rog_g703_psu_actions: true,
      planning_calendar_route: false
    }
  }));

  const overrides = loadProductionCapabilityOverrides({ PANEL_CAPABILITY_OVERRIDES_PATH: path });
  const capabilities = productionBuildCapabilities(overrides);
  const environment = productionBuildEnvironment({}, overrides);
  const planningCapabilityIds = [
    "planning_overview",
    "planning_tasks_route",
    "planning_calendar_route",
    "planning_reminders_route"
  ];

  assert.deepEqual(Object.keys(capabilities.baseline), planningCapabilityIds);
  assert.deepEqual(Object.keys(capabilities.active), planningCapabilityIds);
  assert.equal(capabilities.active.planning_calendar_route, false);
  assert.equal(capabilities.active.home_climate_actions, undefined);
  assert.equal(capabilities.active.rog_g703_psu_actions, undefined);
  assert.equal(environment.VITE_PLANNING_CALENDAR_ROUTE_ENABLED, "false");
  assert.equal(environment.VITE_HOME_CLIMATE_ACTIONS_ENABLED, undefined);
  assert.equal(environment.VITE_ROG_G703_PSU_ACTIONS_ENABLED, undefined);
});

test("a present capability store must be canonical before production build consumption", () => {
  const valid = () => ({
    schemaVersion: "capability-overrides.v1",
    revision: 0,
    updatedAt: "2026-08-26T00:00:00Z",
    overrides: {}
  });
  const invalidDocuments = [
    ["wrong schema", { ...valid(), schemaVersion: "wrong" }],
    ["missing schema", (() => { const value = valid(); delete value.schemaVersion; return value; })()],
    ["negative revision", { ...valid(), revision: -5 }],
    ["non-integer revision", { ...valid(), revision: 1.5 }],
    ["string revision", { ...valid(), revision: "1" }],
    ["missing updatedAt", (() => { const value = valid(); delete value.updatedAt; return value; })()],
    ["non-string updatedAt", { ...valid(), updatedAt: 0 }],
    ["missing overrides", (() => { const value = valid(); delete value.overrides; return value; })()],
    ["array overrides", { ...valid(), overrides: [] }],
    ["null overrides", { ...valid(), overrides: null }],
    ["unknown persisted ID", { ...valid(), overrides: { home_climate_actions: true, unknown: true } }],
    ["non-boolean known ID", { ...valid(), overrides: { planning_calendar_route: "false" } }],
    ["invalid JSON", "not json"]
  ];

  for (const [label, document] of invalidDocuments) {
    const root = mkdtempSync(join(tmpdir(), "artem-invalid-production-store-"));
    const path = join(root, "capability-overrides.json");
    writeFileSync(path, typeof document === "string" ? document : JSON.stringify(document));
    assert.throws(
      () => loadProductionCapabilityOverrides({ PANEL_CAPABILITY_OVERRIDES_PATH: path }),
      /Capability override store is invalid; refusing production build/,
      label
    );
  }
});

test("an oversized present capability store refuses production build consumption", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-oversized-production-store-"));
  const path = join(temporaryRoot, "capability-overrides.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "capability-overrides.v1",
    revision: 4,
    updatedAt: "2026-08-26T00:00:00Z",
    overrides: {},
    padding: "x".repeat(MAX_CAPABILITY_OVERRIDE_FILE_BYTES)
  }));

  assert.throws(
    () => loadProductionCapabilityOverrides({ PANEL_CAPABILITY_OVERRIDES_PATH: path }),
    /Capability override store is invalid; refusing production build/
  );
});

test("the production build entry point refuses a malformed present store", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-invalid-production-build-"));
  const path = join(temporaryRoot, "capability-overrides.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "capability-overrides.v1",
    revision: 4,
    updatedAt: "2026-08-26T00:00:00Z",
    overrides: { planning_calendar_route: false, unknown: true }
  }));
  const result = spawnSync(process.execPath, [resolve(root, "scripts/build-production.mjs")], {
    cwd: root,
    env: { ...process.env, PANEL_CAPABILITY_OVERRIDES_PATH: path },
    encoding: "utf8",
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Capability override store is invalid/);
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
  assert.match(
    readFileSync(resolve(root, "scripts/build-production.mjs"), "utf8"),
    /dashboard-build\.json/
  );
  assert.match(
    readFileSync(resolve(root, "scripts/production-build-assert.mjs"), "utf8"),
    /Production build identity does not match checkout/
  );
});
