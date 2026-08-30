import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const updater = readFileSync(resolve(root, "scripts/windows/update-production.ps1"), "utf8");
const recovery = readFileSync(resolve(root, "scripts/windows/updater-recovery.ps1"), "utf8");

test("target-dependent update work is below the explicit target continuation", () => {
  const continuation = updater.indexOf("if ($Continuation)");
  const targetProof = updater.indexOf("Assert-ArtemTargetUpdaterLogic", continuation);
  const build = updater.indexOf("Invoke-IsolatedValidation", targetProof);
  const restart = updater.indexOf("Ensure-ArtemHealthyVisiblePanel", build);
  assert.ok(continuation >= 0);
  assert.ok(targetProof > continuation);
  assert.ok(build > targetProof);
  assert.ok(restart > build);
  assert.match(updater, /-File\"?,\s*\$targetScriptArgument/);
  assert.match(updater, /\"-Continuation\"/);
});

test("same-SHA updates require artifact and served-runtime proof", () => {
  assert.match(updater, /\$currentHead\s+-eq\s+\$targetHead/);
  assert.match(updater, /Test-ArtemProductionDeploymentHealthy/);
  assert.match(updater, /Assert-ArtemStagedProductionBuild/);
  assert.match(updater, /Assert-ArtemServedProductionBuildIdentity/);
  assert.doesNotMatch(updater, /if \(\$currentHead\s+-eq\s+\$targetHead\)\s*\{[\s\S]{0,240}?return/);
  assert.match(updater, /Get-ArtemProductionUpdateDecision/);
  assert.match(recovery, /function Get-ArtemProductionUpdateDecision/);
});

test("the production updater and executable recovery fixture share the bounded decision contract", () => {
  for (const functionName of [
    "Get-ArtemProductionUpdateDecision",
    "Get-ArtemProductionFailureState",
    "Get-ArtemProductionRollbackState",
  ]) {
    assert.match(recovery, new RegExp(`function ${functionName}`));
    assert.match(updater, new RegExp(functionName));
  }
});

test("interruption and failure paths retain bounded recovery state", () => {
  for (const field of ["UpdateTransactionState", "previousHead", "targetHead", "requestId", "phase", "status = \"incomplete\""]) {
    assert.match(updater, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(updater, /Write-ArtemUpdateTransaction[\s\S]*-Phase \"rollback\"/);
  assert.match(updater, /RollbackDashboard/);
  assert.match(updater, /rollback_restored/);
  assert.match(updater, /rollback_failed/);
});

test("production failures cannot be accepted from a command exit code alone", () => {
  const buildAssertion = updater.indexOf("Assert-ArtemStagedProductionBuild");
  const promotion = updater.indexOf("Promote-ArtemProductionBuild");
  assert.ok(buildAssertion >= 0 && promotion > buildAssertion);
  assert.match(updater, /Assert-ArtemProductionBuildIdentity[\s\S]*Assert-ArtemServedProductionBuildIdentity/);
});

test("terminal update state records the verified served target for dashboard recovery", () => {
  assert.match(updater, /function Write-ArtemUpdateState/);
  assert.match(updater, /servedRevision/);
  assert.match(updater, /Status "success" -Result "updated" -ServedRevision \$targetHead/);
  assert.match(updater, /Status "success" -Result "up_to_date" -ServedRevision \$targetHead/);
});

test("the updater keeps the protected process and repository boundaries", () => {
  assert.doesNotMatch(updater, /git(?:\.exe)?\s+clean/);
  assert.match(updater, /git\.exe[\s\S]*?merge[\s\S]*?--ff-only[\s\S]*?\$targetHead/);
  assert.match(updater, /Stop-ArtemRuntime\s+-Paths\s+\$paths\s+-Manual\s+\$false/);
  assert.doesNotMatch(updater, /CommandLine\s+-like\s+['\"]\*--kiosk/);
});

test("Windows PowerShell atomic state publication passes a true CLR null backup path", () => {
  assert.match(updater, /\[System\.Management\.Automation\.Language\.NullString\]::Value/);
  assert.doesNotMatch(updater, /\[IO\.File\]::Replace\([\s\S]{0,160},\s*\$null\)/);

  const productionScripts = readFileSync(resolve(root, "scripts/windows/test-production-scripts.ps1"), "utf8");
  for (const functionName of [
    "Write-ArtemUpdateJson",
    "Write-ArtemUpdateState",
    "New-ArtemUpdateLock",
    "Claim-ArtemUpdateLock",
    "Refresh-ArtemUpdateLock",
    "Write-ArtemUpdateTransaction"
  ]) {
    assert.match(productionScripts, new RegExp(functionName));
  }
  assert.match(productionScripts, /first write must publish by Move/i);
  assert.match(productionScripts, /second must publish by File\.Replace/i);
});

test("owner-safe update progress is server-owned and rollback remains a distinct phase", () => {
  const systemUpdate = readFileSync(resolve(root, "apps/panel-agent/src/panel_agent/system_update.py"), "utf8");
  const observer = readFileSync(resolve(root, "apps/dashboard/src/runtimeUpdateObserver.ts"), "utf8");
  const controls = readFileSync(resolve(root, "apps/dashboard/src/RuntimeControls.tsx"), "utf8");
  assert.match(systemUpdate, /UPDATE_ACTIVITY_MAX\s*=\s*32/);
  assert.match(systemUpdate, /UPDATE_PHASE_PROGRESS/);
  assert.match(systemUpdate, /progressPercent/);
  assert.match(systemUpdate, /served_verified/);
  assert.match(observer, /UPDATE_ACTIVITY_COPY/);
  assert.match(observer, /no browser elapsed-time deadline/);
  assert.match(controls, /runtime-update-activity/);
  assert.match(controls, /runtime-update-progress/);
  assert.match(controls, /Object\.prototype\.hasOwnProperty/);
});
