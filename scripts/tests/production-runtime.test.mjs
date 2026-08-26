import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvText,
  RestartBudget,
  shouldCreateManualStop,
  buildAgentEnvironment,
  activateStagedDashboard,
  capabilityStoreRevision,
  isSafeCapabilityApplyCommand
} from "../production-runtime.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("parseEnvText accepts comments, export and quoted values", () => {
  assert.deepEqual(
    parseEnvText(`
      # local configuration
      PANEL_AGENT_MODE=fixtures
      export PANEL_AVALAR_MAIN_URL="https://example.test"
      PANEL_EMPTY=''
    `),
    {
      PANEL_AGENT_MODE: "fixtures",
      PANEL_AVALAR_MAIN_URL: "https://example.test",
      PANEL_EMPTY: ""
    }
  );
});

test("parseEnvText rejects invalid keys and malformed lines", () => {
  assert.throws(() => parseEnvText("lowercase=value"), /Invalid runtime\.env key/);
  assert.throws(() => parseEnvText("PANEL_AGENT_MODE"), /Invalid runtime\.env line/);
});

test("RestartBudget enforces a bounded rolling window", () => {
  const budget = new RestartBudget({ maximum: 2, windowMs: 1_000 });
  assert.equal(budget.record(0), true);
  assert.equal(budget.record(500), true);
  assert.equal(budget.record(900), false);
  assert.equal(budget.count(900), 2);
  assert.equal(budget.record(1_501), true);
  assert.equal(budget.count(1_501), 1);
});

test("only a manual shutdown creates a persistent stop marker", () => {
  assert.equal(shouldCreateManualStop({ action: "shutdown" }), true);
  assert.equal(shouldCreateManualStop({ action: "shutdown", manual: true }), true);
  assert.equal(shouldCreateManualStop({ action: "shutdown", manual: false }), false);
  assert.equal(shouldCreateManualStop({ action: "hide" }), false);
});

test("production runtime injects only its safe configured revision into Panel Agent", () => {
  const environment = buildAgentEnvironment({
    baseEnv: { NODE_ENV: "production", ARBITRARY_SECRET: "must-not-be-reported" },
    fileEnv: { PANEL_AGENT_MODE: "fixtures", PANEL_AGENT_BUILD_REVISION: "stale-file-value" },
    mode: "production",
    buildRevision: "59d376c02d26",
    commandPath: "runtime-command.json",
    dashboardDist: "dist",
    stateCachePath: "panel-state-cache.json",
    calendarDisplayColorPath: "calendar-display-colors.json"
  });

  assert.equal(environment.PANEL_AGENT_MODE, "production");
  assert.equal(environment.PANEL_AGENT_BUILD_REVISION, "59d376c02d26");
  assert.equal(environment.PANEL_STATE_CACHE_PATH, "panel-state-cache.json");
  assert.equal(environment.PANEL_CALENDAR_DISPLAY_COLOR_PATH, "calendar-display-colors.json");
});

test("production runtime uses an honest unknown revision when Git cannot provide one", () => {
  const environment = buildAgentEnvironment({
    baseEnv: {},
    fileEnv: {},
    mode: "production",
    commandPath: "runtime-command.json",
    dashboardDist: "dist",
    stateCachePath: "panel-state-cache.json",
    calendarDisplayColorPath: "calendar-display-colors.json"
  });

  assert.equal(environment.PANEL_AGENT_BUILD_REVISION, "unknown");
});

test("capability apply accepts only its fixed schema and revision metadata", () => {
  assert.equal(isSafeCapabilityApplyCommand({ schemaVersion: 1, action: "apply_capabilities", expectedRevision: 4, requestId: "0123456789abcdef01234567" }), true);
  assert.equal(isSafeCapabilityApplyCommand({ schemaVersion: 1, action: "apply_capabilities", expectedRevision: 4, requestId: "bad" }), false);
  assert.equal(isSafeCapabilityApplyCommand({ schemaVersion: 1, action: "update", expectedRevision: 4, requestId: "0123456789abcdef01234567", shell: "git pull" }), false);
});

test("capability apply activates only a validated staged dashboard and retains rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-runtime-"));
  const active = join(root, "dist");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  mkdirSync(active); mkdirSync(staging);
  writeFileSync(join(active, "index.html"), "old");
  writeFileSync(join(staging, "index.html"), "new");
  activateStagedDashboard({ active, staging, backup });
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "new");
  assert.equal(readFileSync(join(backup, "index.html"), "utf8"), "old");
  assert.equal(existsSync(staging), false);
});

test("capability revision reader fails closed on malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-revision-"));
  const path = join(root, "capabilities.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: "capability-overrides.v1", revision: 7 }));
  assert.equal(capabilityStoreRevision(path), 7);
  writeFileSync(path, "not json");
  assert.equal(capabilityStoreRevision(path), null);
});
