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
  assert.match(updater, /Publish-ArtemTargetHandoffLease/);
  assert.match(updater, /Start-ArtemTargetContinuation/);
  const handoff = readFileSync(resolve(root, "scripts/windows/updater-target-handoff.ps1"), "utf8");
  assert.match(handoff, /"-File", \('\"\{0\}\"' -f \$TargetScript\)/);
  assert.match(handoff, /"-Continuation"/);
  assert.match(handoff, /Claim-ArtemTargetHandoffLease/);
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
  assert.match(updater, /\$ArtemUpdateActivityCodes\s*=\s*@\(/);
  assert.match(updater, /ArtemUpdateActivityCodes\s+-notcontains/);
  assert.doesNotMatch(updater, /[А-Яа-яЁё]/);
  assert.doesNotMatch(productionScripts, /[А-Яа-яЁё]/);
  for (const functionName of [
    "Write-ArtemUpdateJson",
    "Write-ArtemUpdateState",
    "New-ArtemUpdateLock",
    "Claim-ArtemUpdateLock",
    "Refresh-ArtemUpdateLock",
    "Bind-ArtemUpdateLockRevisions",
    "Assert-ArtemExpectedUpdatePreflight",
    "Write-ArtemUpdateTransaction"
  ]) {
    assert.match(productionScripts, new RegExp(functionName));
  }
  assert.match(productionScripts, /first write must publish by Move/i);
  assert.match(productionScripts, /second must publish by File\.Replace/i);
  assert.match(productionScripts, /Manual preflight did not bind the owned lease/);
  assert.match(productionScripts, /Panel target change rewrote the accepted lease or reached handoff/);
  const expectedAssertion = updater.indexOf("Assert-ArtemExpectedUpdatePreflight", updater.indexOf("$preflight = Get-ArtemUpdatePreflight"));
  const manualBinding = updater.indexOf("Bind-ArtemUpdateLockRevisions", expectedAssertion);
  const transaction = updater.indexOf("Write-ArtemUpdateTransaction", expectedAssertion);
  const shutdown = updater.indexOf("Stop-ArtemRuntime", expectedAssertion);
  const handoff = updater.indexOf("Invoke-ArtemTargetUpdater", expectedAssertion);
  assert.ok(expectedAssertion >= 0 && manualBinding > expectedAssertion);
  assert.ok(transaction > expectedAssertion && shutdown > expectedAssertion && handoff > expectedAssertion);
  assert.match(updater, /function Assert-ArtemExpectedUpdatePreflight[\s\S]*?-not \$Continuation -and \$HasExpected -and \([\s\S]*?\$Current -ne \$ExpectedCurrent[\s\S]*?\$Target -ne \$ExpectedTarget[\s\S]*?throw "Update target changed since it was checked in the panel"/);
  assert.match(updater, /if \(-not \$Continuation -and -not \$hasExpected\)\s*\{[\s\S]{0,240}?Bind-ArtemUpdateLockRevisions/);
});

test("target continuation has a bounded private lease handoff and executable Windows regression", () => {
  const handoff = readFileSync(resolve(root, "scripts/windows/updater-target-handoff.ps1"), "utf8");
  const windowsRegression = readFileSync(resolve(root, "scripts/windows/test-updater-target-handoff.ps1"), "utf8");
  const child = readFileSync(resolve(root, "scripts/windows/test-updater-target-handoff-child.ps1"), "utf8");
  const legacyParent = readFileSync(resolve(root, "scripts/windows/test-updater-target-handoff-legacy-parent.ps1"), "utf8");
  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(handoff, /handoff = "target-continuation"/);
  assert.match(handoff, /New-Object -TypeName System\.Threading\.Mutex/);
  assert.match(handoff, /Reclaim-ArtemTargetHandoffLease/);
  assert.match(handoff, /Test-ArtemLegacyTargetHandoffLease/);
  assert.match(handoff, /Test-ArtemNullHeadLegacyTargetHandoffLease/);
  assert.match(handoff, /Test-ArtemTargetHandoffTransaction/);
  assert.match(handoff, /Restore-ArtemLegacyTargetHandoffLease/);
  assert.match(handoff, /update-handoff-\{0\}\.json/);
  assert.match(windowsRegression, /Start-ArtemTargetContinuation/);
  assert.match(windowsRegression, /-Label "request id"/);
  assert.match(windowsRegression, /-Label "current revision"/);
  assert.match(windowsRegression, /-Label "target revision"/);
  assert.match(windowsRegression, /-Label "competing owner"/);
  assert.match(windowsRegression, /Parent could not reclaim rollback authority after child failure/);
  assert.match(windowsRegression, /Legacy parent continuation child failed/);
  assert.match(windowsRegression, /Populated legacy parent continuation child failed/);
  assert.match(windowsRegression, /only current missing/);
  assert.match(windowsRegression, /only target missing/);
  assert.match(windowsRegression, /completed transaction/);
  assert.match(windowsRegression, /populated mismatched current lock SHA/);
  assert.match(windowsRegression, /Rejected legacy child claim removed the parent lease/);
  assert.match(windowsRegression, /Failed legacy child did not restore parent rollback authority/);
  assert.match(windowsRegression, /Reclaim overwrote a competing owner/);
  assert.match(windowsRegression, /ownerless no-marker/);
  assert.match(child, /\[switch\]\$Continuation/);
  assert.match(legacyParent, /a2b0eb4b241032eb3b8975a7c8fff24fc4966219/);
  assert.match(legacyParent, /Start-Process/);
  assert.doesNotMatch(legacyParent, /Publish-ArtemTargetHandoffLease/);
  assert.match(updater, /\[int\]\$existing\.ownerPid\s+-eq\s+\$PID/);
  assert.match(ci, /test-updater-target-handoff\.ps1/);
});

test("dashboard failure reasons are exhaustive over the bounded owner result union", () => {
  const controls = readFileSync(resolve(root, "apps/dashboard/src/RuntimeControls.tsx"), "utf8");
  assert.match(controls, /type UpdateFailureResult = Exclude<UpdateOwnerResult, "updated" \| "up_to_date">/);
  for (const result of [
    "rollback_restored",
    "rollback_failed",
    "pre_update_failed",
    "invalid_update_command",
    "updater_unavailable",
    "capability_apply_active",
    "update_lock_mismatch",
    "build_failed",
    "artifact_assertion_failed",
    "served_artifact_mismatch",
    "restart_failed",
    "repair_required",
    "target_handoff_lease_rejected",
    "updater_spawn_failed",
    "updater_early_exit",
    "updater_stale"
  ]) {
    assert.match(controls, new RegExp(`^  ${result}:`, "m"));
  }
  assert.match(controls, /Обновление не завершено\. Повторите попытку или проверьте установку панели\./);
});

test("owner-safe update progress is server-owned and rollback remains a distinct phase", () => {
  const systemUpdate = readFileSync(resolve(root, "apps/panel-agent/src/panel_agent/system_update.py"), "utf8");
  const observer = readFileSync(resolve(root, "apps/dashboard/src/runtimeUpdateObserver.ts"), "utf8");
  const controls = readFileSync(resolve(root, "apps/dashboard/src/RuntimeControls.tsx"), "utf8");
  assert.match(systemUpdate, /UPDATE_ACTIVITY_MAX\s*=\s*32/);
  assert.match(systemUpdate, /UPDATE_PHASE_PROGRESS/);
  assert.match(systemUpdate, /progressPercent/);
  assert.match(systemUpdate, /served_verified/);
  assert.match(systemUpdate, /target_handoff_lease_rejected/);
  assert.match(systemUpdate, /set\(evidence\) != \{"schemaVersion", "requestId", "stage", "result", "updatedAt"\}/);
  assert.match(observer, /UPDATE_ACTIVITY_COPY/);
  assert.match(observer, /no browser elapsed-time deadline/);
  assert.match(controls, /runtime-update-activity/);
  assert.match(controls, /runtime-update-progress/);
  assert.match(controls, /Object\.prototype\.hasOwnProperty/);
});
