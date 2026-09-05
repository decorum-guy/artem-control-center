import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvText,
  RestartBudget,
  shouldCreateManualStop,
  buildAgentEnvironment,
  coffeeUploadIngressLaunchConfig,
  activateStagedDashboard,
  restoreDashboardBackup,
  capabilityStoreRevision,
  isSafeCapabilityApplyCommand,
  planRestart,
  createCapabilityApplyLifecycle,
  CAPABILITY_APPLY_MAX_RECOVERY_FAILURES,
  readProductionBuildIdentity
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

test("supervisor liveness checks do not restart an Agent that is live but still becoming ready", () => {
  const source = readFileSync(new URL("../production-runtime.mjs", import.meta.url), "utf8");
  const healthLoop = source.slice(source.indexOf("healthTimer = setInterval"));
  assert.match(healthLoop, /probeHealth\("http:\/\/127\.0\.0\.1:8787\/health\/live"\)/);
  assert.doesNotMatch(healthLoop, /health\/ready/);
});

test("Windows launcher retains readiness, rather than liveness, as its deployment gate", () => {
  const common = readFileSync(new URL("../windows/runtime-common.ps1", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../windows/start-production.ps1", import.meta.url), "utf8");
  assert.match(common, /ReadyUrl = "http:\/\/127\.0\.0\.1:8787\/health\/ready"/);
  assert.match(launcher, /Wait-ArtemPanelReady\s+-Paths\s+\$paths\s+-TimeoutSeconds\s+60/);
  assert.doesNotMatch(launcher, /health\/live/);
});

test("Coffee upload ingress starts only from an explicit dedicated non-Agent port", () => {
  assert.equal(coffeeUploadIngressLaunchConfig({ PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "http://coffee-upload.test:8788" }), null, "an external maintained proxy needs no local bridge");
  assert.deepEqual(
    coffeeUploadIngressLaunchConfig({
      PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "http://192.0.2.10:8788",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST: "0.0.0.0",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT: "8788"
    }),
    { bindHost: "0.0.0.0", port: 8788 }
  );
  assert.equal(
    coffeeUploadIngressLaunchConfig({
      PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "http://127.0.0.1:8788",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST: "0.0.0.0",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT: "8788"
    }).error,
    "invalid_configuration"
  );
  assert.equal(
    coffeeUploadIngressLaunchConfig({
      PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "http://127.0.0.2:8788",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST: "0.0.0.0",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT: "8788"
    }).error,
    "invalid_configuration"
  );
  assert.equal(
    coffeeUploadIngressLaunchConfig({
      PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "http://192.0.2.10:8787",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST: "0.0.0.0",
      PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT: "8787"
    }).error,
    "invalid_configuration"
  );
  const runtime = readFileSync(new URL("../production-runtime.mjs", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../../apps/panel-agent/src/panel_agent/coffee_upload_ingress.py", import.meta.url), "utf8");
  assert.match(runtime, /panel_agent\.coffee_upload_ingress:configured_app/);
  assert.match(runtime, /--no-access-log/);
  assert.match(ingress, /COFFEE_UPLOAD_UPSTREAM_URL/);
  assert.match(ingress, /\/coffee-upload/);
  assert.match(ingress, /photo-upload/);
  assert.doesNotMatch(ingress, /reverse_proxy|shell=True|subprocess/);
});

test("accepted capability apply closes before a later ordinary Agent exit", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-lifecycle-"));
  const active = join(root, "dist");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  mkdirSync(active); mkdirSync(staging);
  writeFileSync(join(active, "index.html"), "known-good");
  writeFileSync(join(staging, "index.html"), "candidate");
  activateStagedDashboard({ active, staging, backup });

  const order = [];
  const restarts = [];
  const rollbacks = [];
  let lifecycle;
  lifecycle = createCapabilityApplyLifecycle({
    onSuccess: (revision) => order.push(["success", revision]),
    onRestart: (reason, options) => {
      order.push(["restart", reason, options]);
      restarts.push({ reason, options });
    },
    onRollback: (...args) => rollbacks.push(args)
  });

  lifecycle.activate({ revision: 7, backup });
  assert.equal(lifecycle.activeApply.revision, 7);
  assert.equal(lifecycle.appliedRevision, 7);
  assert.equal(restarts[0].options.allowBeyondBudget, true);

  assert.equal(lifecycle.acceptHealth(), true);
  assert.deepEqual(order.map(([kind, value]) => [kind, value]), [
    ["restart", "capabilities applied"],
    ["success", 7]
  ]);
  assert.equal(lifecycle.activeApply, null);
  assert.equal(lifecycle.appliedRevision, null);
  assert.equal(existsSync(backup), true, "accepted Apply keeps a passive last-known-good backup");

  assert.equal(lifecycle.handleAgentExit(), "normal_restart");
  assert.equal(rollbacks.length, 0);
  assert.equal(restarts[1].reason, "agent process exited unexpectedly");
  assert.equal(restarts[1].options, undefined);
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "candidate");
});

test("capability Apply bypasses an exhausted ordinary budget only for bounded candidate recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-budget-"));
  const active = join(root, "dist");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  mkdirSync(active); mkdirSync(staging);
  writeFileSync(join(active, "index.html"), "known-good");
  writeFileSync(join(staging, "index.html"), "candidate");
  activateStagedDashboard({ active, staging, backup });

  const budget = new RestartBudget({ maximum: 1, windowMs: 1_000 });
  assert.equal(budget.record(0), true, "ordinary runtime budget starts exhausted");
  const restartAttempts = [];
  let shutdowns = 0;
  const rollbacks = [];
  const requestRestart = (reason, options) => {
    const plan = planRestart(budget, { ...(options ?? {}), now: 1 });
    restartAttempts.push({ reason, options, plan });
    if (!plan.accepted) shutdowns += 1;
  };
  const lifecycle = createCapabilityApplyLifecycle({
    onSuccess: () => {},
    onRestart: requestRestart,
    onRollback: (reason, pendingApply) => {
      rollbacks.push({ reason, pendingApply });
      restoreDashboardBackup({ active, backup });
      requestRestart("capability rollback to known-good dashboard", { allowBeyondBudget: true });
    }
  });

  lifecycle.activate({ revision: 9, backup });
  assert.equal(restartAttempts[0].plan.accepted, true);
  assert.equal(restartAttempts[0].plan.recorded, false);
  assert.equal(shutdowns, 0);

  for (let attempt = 0; attempt < CAPABILITY_APPLY_MAX_RECOVERY_FAILURES; attempt += 1) {
    lifecycle.handleAgentExit();
  }

  assert.equal(shutdowns, 0, "an exhausted unrelated budget cannot abandon Apply");
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].reason, "new_runtime_exited");
  assert.equal(rollbacks[0].pendingApply.recoveryFailures, CAPABILITY_APPLY_MAX_RECOVERY_FAILURES);
  assert.equal(lifecycle.activeApply, null);
  assert.equal(lifecycle.appliedRevision, null);
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "known-good");
  assert.equal(restartAttempts.length, CAPABILITY_APPLY_MAX_RECOVERY_FAILURES + 1);
  assert.ok(restartAttempts.every(({ plan }) => plan.accepted));
  assert.equal(restartAttempts.at(-1).reason, "capability rollback to known-good dashboard");
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

test("production runtime accepts only the bounded dashboard build identity", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-production-build-identity-"));
  const path = join(root, "dashboard-build.json");
  const revision = "a".repeat(40);
  writeFileSync(path, JSON.stringify({
    schemaVersion: "dashboard-build.v1",
    revision,
    profile: "accepted-v2",
    buildId: `${revision}:accepted-v2`
  }));
  assert.deepEqual(readProductionBuildIdentity(path).revision, revision);
  writeFileSync(path, JSON.stringify({
    schemaVersion: "dashboard-build.v1",
    revision,
    profile: "wrong",
    buildId: `${revision}:wrong`
  }));
  assert.throws(() => readProductionBuildIdentity(path), /build identity is invalid/);
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

test("post-swap health rejection restores the previous dashboard without discarding desired overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-rollback-"));
  const active = join(root, "dist");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  const overrides = join(root, "capability-overrides.json");
  mkdirSync(active); mkdirSync(staging);
  writeFileSync(join(active, "index.html"), "known-good");
  writeFileSync(join(active, "old-asset.js"), "old");
  writeFileSync(join(staging, "index.html"), "candidate");
  writeFileSync(join(staging, "new-asset.js"), "new");
  writeFileSync(overrides, JSON.stringify({
    schemaVersion: "capability-overrides.v1", revision: 4,
    updatedAt: "2026-08-26T00:00:00Z", overrides: { planning_calendar_route: false }
  }));

  activateStagedDashboard({ active, staging, backup });
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "candidate");
  // This represents the bounded supervisor health rejection.  The durable
  // desired override is intentionally not changed by rollback.
  restoreDashboardBackup({ active, backup });
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "known-good");
  assert.equal(readFileSync(join(active, "old-asset.js"), "utf8"), "old");
  assert.equal(existsSync(join(active, "new-asset.js")), false);
  assert.deepEqual(JSON.parse(readFileSync(overrides, "utf8")).overrides, { planning_calendar_route: false });
});

test("post-swap health acceptance leaves the new dashboard active", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-acceptance-"));
  const active = join(root, "dist");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  mkdirSync(active); mkdirSync(staging);
  writeFileSync(join(active, "index.html"), "known-good");
  writeFileSync(join(staging, "index.html"), "candidate");
  activateStagedDashboard({ active, staging, backup });
  // Healthy acceptance deliberately does not consume the backup before the
  // transaction completes; active remains the validated new bundle.
  assert.equal(readFileSync(join(active, "index.html"), "utf8"), "candidate");
  assert.equal(readFileSync(join(backup, "index.html"), "utf8"), "known-good");
});

test("capability revision reader fails closed on malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-capability-revision-"));
  const path = join(root, "capabilities.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: "capability-overrides.v1", revision: 7 }));
  assert.equal(capabilityStoreRevision(path), 7);
  writeFileSync(path, "not json");
  assert.equal(capabilityStoreRevision(path), null);
});
