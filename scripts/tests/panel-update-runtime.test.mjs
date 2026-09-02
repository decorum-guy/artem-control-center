import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

import {
  activePanelUpdateLease,
  canPublishPanelUpdateEarlyExit,
  canPublishPanelUpdateRuntimeFailure,
  classifyPanelUpdateLockOwnership,
  createPanelUpdateSpawnLifecycle,
  isExactPanelUpdateLock,
  isSafePanelUpdateCommand,
  readUpdaterBootstrapEvidence,
  UPDATE_HANDOFF_MAX_AGE_MS
} from "../production-runtime.mjs";

const CURRENT = "a".repeat(40);
const TARGET = "b".repeat(40);
const REQUEST = "0123456789abcdef01234567";

function validCommand() {
  return {
    schemaVersion: 1,
    action: "update_panel",
    expectedCurrentHead: CURRENT,
    expectedTargetHead: TARGET,
    requestId: REQUEST,
    requestedAt: "2026-08-26T12:00:00.000Z"
  };
}

function fakeUpdater(pid = 4242) {
  const updater = new EventEmitter();
  updater.pid = pid;
  updater.unrefCalls = 0;
  updater.unref = () => { updater.unrefCalls += 1; };
  return updater;
}

function launchLifecycle({ authoritative = false, runtimeAlive = true, bootstrap = null } = {}) {
  const updater = fakeUpdater();
  const failures = [];
  const logs = [];
  createPanelUpdateSpawnLifecycle({
    command: validCommand(),
    updater,
    isRuntimeAlive: () => runtimeAlive,
    hasAuthoritativeEvidence: () => authoritative,
    publishFailure: (result) => { failures.push(result); return true; },
    readBootstrapEvidence: () => bootstrap,
    log: (level, message) => logs.push({ level, message })
  });
  return { updater, failures, logs };
}

function updateLock(updatedAt, ownerPid) {
  return {
    schemaVersion: 1,
    status: "updating",
    requestId: REQUEST,
    expectedCurrentHead: CURRENT,
    expectedTargetHead: TARGET,
    updatedAt,
    ...(ownerPid === undefined ? {} : { ownerPid })
  };
}

function activeUpdateState() {
  return {
    schemaVersion: 1,
    status: "updating",
    requestId: REQUEST,
    currentHead: CURRENT,
    targetHead: TARGET
  };
}

function simulateEarlyExit({ state = activeUpdateState(), lock, transaction = null } = {}) {
  const command = validCommand();
  const updater = fakeUpdater();
  const originalLock = lock;
  const originalTransaction = transaction;
  let currentState = state;
  let currentLock = lock;
  createPanelUpdateSpawnLifecycle({
    command,
    updater,
    isRuntimeAlive: () => true,
    hasAuthoritativeEvidence: () => (
      currentState?.schemaVersion === 1
      && ["success", "failed"].includes(currentState.status)
      && currentState.requestId === REQUEST
      && currentState.currentHead === CURRENT
      && currentState.targetHead === TARGET
    ),
    publishFailure: (result, { childPid } = {}) => {
      if (!canPublishPanelUpdateEarlyExit({ command, state: currentState, lock: currentLock, childPid })) return false;
      currentState = {
        schemaVersion: 1,
        status: "failed",
        result,
        requestId: REQUEST,
        currentHead: CURRENT,
        targetHead: TARGET
      };
      if (classifyPanelUpdateLockOwnership(currentLock, command, childPid) === "ownerless") currentLock = null;
      return true;
    },
    log: () => {}
  });
  updater.emit("spawn");
  updater.emit("exit", 1, null);
  return { state: currentState, lock: currentLock, transaction, originalLock, originalTransaction };
}

test("panel update command accepts only exact bounded revision metadata", () => {
  assert.equal(isSafePanelUpdateCommand(validCommand()), true);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), expectedTargetHead: CURRENT }), false);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), expectedTargetHead: CURRENT, repair: true }), true);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), expectedTargetHead: CURRENT, repair: false }), false);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), requestId: "bad" }), false);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), expectedCurrentHead: "main" }), false);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), requestedAt: "not-a-date" }), false);
});

test("panel update command rejects generic shell path branch and environment surfaces", () => {
  for (const extra of [
    { shell: "git pull" },
    { command: "powershell.exe" },
    { path: "C:/other-repo" },
    { branch: "feature" },
    { environment: { SECRET: "value" } }
  ]) {
    assert.equal(isSafePanelUpdateCommand({ ...validCommand(), ...extra }), false);
  }
});

test("update lease keeps a verified live updater authoritative and rejects a dead owner", () => {
  const nowMs = Date.parse("2026-08-26T14:00:00.000Z");
  const oldHeartbeat = "2026-08-26T10:00:00.000Z";
  const lock = updateLock(oldHeartbeat, 4242);

  assert.equal(
    activePanelUpdateLease(lock, {
      nowMs,
      ownerAlive: (pid, requestId) => pid === 4242 && requestId === REQUEST
    }),
    lock
  );
  assert.equal(
    activePanelUpdateLease(lock, { nowMs, ownerAlive: () => false }),
    null
  );
});

test("pre-owner handoff lease is short and future timestamps cannot become immortal", () => {
  const nowMs = Date.parse("2026-08-26T14:00:00.000Z");
  assert.ok(activePanelUpdateLease(updateLock("2026-08-26T13:59:00.000Z"), { nowMs }));
  assert.equal(
    activePanelUpdateLease(
      updateLock(new Date(nowMs - UPDATE_HANDOFF_MAX_AGE_MS - 1).toISOString()),
      { nowMs }
    ),
    null
  );
  assert.equal(
    activePanelUpdateLease(updateLock("2999-01-01T00:00:00.000Z"), { nowMs }),
    null
  );
});

test("successful updater spawn records request-bound acceptance only after spawn", () => {
  const { updater, failures, logs } = launchLifecycle();
  assert.equal(logs.length, 0);
  updater.emit("spawn");
  assert.equal(updater.unrefCalls, 1);
  assert.equal(failures.length, 0);
  assert.match(logs[0].message, new RegExp(`accepted requestId=${REQUEST} pid=4242`));
});

test("updater spawn error publishes only the fixed safe spawn result", () => {
  const { updater, failures, logs } = launchLifecycle();
  updater.emit("error", new Error("private Powershell launch detail"));
  assert.deepEqual(failures, ["updater_spawn_failed"]);
  assert.equal(logs.some(({ message }) => message.includes("handoff accepted")), false);
  assert.equal(failures.join(" ").includes("private"), false);
});

test("unexplained early updater exit publishes the fixed safe early-exit result", () => {
  const { updater, failures } = launchLifecycle();
  updater.emit("spawn");
  updater.emit("exit", 71, null);
  assert.deepEqual(failures, ["updater_early_exit"]);
  assert.equal(failures.join(" ").includes("71"), false);
});

for (const [label, bootstrap] of [
  ["pre-script", null],
  ["after process creation before script body", { stage: "runtime-process-created", result: "recorded" }],
  ["after script body entry", { stage: "script-entered", result: "recorded" }],
  ["after helper load", { stage: "helpers-loaded", result: "recorded" }],
  ["after lease claim", { stage: "lease-claimed", result: "recorded" }]
]) {
  test(`early updater exit logs bounded ${label} bootstrap classification`, () => {
    const { updater, failures, logs } = launchLifecycle({ bootstrap });
    updater.emit("spawn");
    updater.emit("exit", 0, null);
    assert.deepEqual(failures, ["updater_early_exit"]);
    const expectedStage = !bootstrap || bootstrap.stage === "runtime-process-created"
      ? "host_or_parameter_pre_script_exit"
      : bootstrap.stage;
    assert.match(logs.at(-1).message, new RegExp(`bootstrapStage=${expectedStage}`));
    assert.match(logs.at(-1).message, new RegExp(`bootstrapResult=${bootstrap?.result ?? "recorded"}`));
    assert.doesNotMatch(logs.map(({ message }) => message).join(" "), /C:\\\\|secret|private/i);
  });
}

test("bootstrap reader correlates only exact strict bounded evidence", () => {
  const path = resolve(root, "package.json");
  assert.equal(readUpdaterBootstrapEvidence(path, REQUEST), null, "non-bootstrap JSON is ignored");
});

test("authoritative updater evidence wins over early child exit", () => {
  const { updater, failures, logs } = launchLifecycle({ authoritative: true });
  updater.emit("spawn");
  updater.emit("exit", 1, null);
  assert.deepEqual(failures, []);
  assert.match(logs.at(-1).message, /retained authoritative evidence/);
});

test("exact ownerless lock matching never accepts updater-owned or different requests", () => {
  const command = validCommand();
  assert.equal(isExactPanelUpdateLock(updateLock(new Date().toISOString()), command, { ownerless: true }), true);
  assert.equal(isExactPanelUpdateLock(updateLock(new Date().toISOString(), 4242), command, { ownerless: true }), false);
  assert.equal(
    isExactPanelUpdateLock({ ...updateLock(new Date().toISOString()), requestId: "f".repeat(24) }, command, { ownerless: true }),
    false
  );
});

test("runtime spawn failure publisher still requires an exact ownerless lock", () => {
  const command = validCommand();
  const state = {
    schemaVersion: 1,
    status: "updating",
    requestId: REQUEST,
    currentHead: CURRENT,
    targetHead: TARGET
  };
  assert.equal(canPublishPanelUpdateRuntimeFailure({ command, state, lock: updateLock(new Date().toISOString()) }), true);
  assert.equal(canPublishPanelUpdateRuntimeFailure({ command, state, lock: updateLock(new Date().toISOString(), 4242) }), false);
  assert.equal(
    canPublishPanelUpdateRuntimeFailure({
      command,
      state: { ...state, requestId: "f".repeat(24) },
      lock: { ...updateLock(new Date().toISOString()), requestId: "f".repeat(24) }
    }),
    false,
    "a different request cannot be overwritten"
  );
  assert.equal(
    canPublishPanelUpdateRuntimeFailure({ command, state, lock: updateLock(new Date().toISOString()), authoritative: true }),
    false,
    "a terminal updater state wins"
  );
});

test("H1 claimed exact updater lock then pre-transcript exit publishes early exit without releasing the lock", () => {
  const lock = updateLock(new Date().toISOString(), 4242);
  const result = simulateEarlyExit({ lock });
  assert.equal(result.state.result, "updater_early_exit");
  assert.equal(result.state.requestId, REQUEST);
  assert.equal(result.state.currentHead, CURRENT);
  assert.equal(result.state.targetHead, TARGET);
  assert.equal("ownerPid" in result.state, false);
  assert.equal(result.lock, result.originalLock);
});

test("H2 incomplete transaction remains diagnostic evidence and does not suppress an exited child", () => {
  const transaction = {
    schemaVersion: 1,
    status: "incomplete",
    phase: "started",
    requestId: REQUEST,
    previousHead: CURRENT,
    targetHead: TARGET
  };
  const result = simulateEarlyExit({ lock: updateLock(new Date().toISOString(), 4242), transaction });
  assert.equal(result.state.result, "updater_early_exit");
  assert.equal(result.transaction, result.originalTransaction);
  assert.equal(result.lock.ownerPid, 4242);
});

test("H3 a different updater owner PID prevents state overwrite and lock cleanup", () => {
  const state = activeUpdateState();
  const lock = updateLock(new Date().toISOString(), 5252);
  const result = simulateEarlyExit({ state, lock });
  assert.equal(result.state, state);
  assert.equal(result.lock, lock);
});

test("H4 terminal updater success remains authoritative after child exit", () => {
  const state = { ...activeUpdateState(), status: "success", result: "updated" };
  const result = simulateEarlyExit({ state, lock: updateLock(new Date().toISOString(), 4242) });
  assert.equal(result.state, state);
});

test("H5 terminal updater failure remains authoritative after child exit", () => {
  const state = { ...activeUpdateState(), status: "failed", result: "build_failed" };
  const result = simulateEarlyExit({ state, lock: updateLock(new Date().toISOString(), 4242) });
  assert.equal(result.state, state);
});

test("H6 ownerless early exit publishes and removes only the exact ownerless lock", () => {
  const result = simulateEarlyExit({ lock: updateLock(new Date().toISOString()) });
  assert.equal(result.state.result, "updater_early_exit");
  assert.equal(result.lock, null);
});

test("H7 different request or revisions cannot be mutated on child exit", () => {
  const state = { ...activeUpdateState(), requestId: "f".repeat(24) };
  const lock = { ...updateLock(new Date().toISOString(), 4242), expectedTargetHead: "c".repeat(40) };
  const result = simulateEarlyExit({ state, lock });
  assert.equal(result.state, state);
  assert.equal(result.lock, lock);
});

test("supervisor handoff is wired to the fixed canonical updater script and owner identity", () => {
  const source = readFileSync(resolve("scripts/production-runtime.mjs"), "utf8");
  assert.match(source, /const updaterPath = resolve\(root, "scripts", "windows", "update-production\.ps1"\)/);
  assert.match(source, /command\.action === "update_panel"/);
  assert.match(source, /"-ExpectedCurrentHead"[\s\S]*command\.expectedCurrentHead/);
  assert.match(source, /"-ExpectedTargetHead"[\s\S]*command\.expectedTargetHead/);
  assert.match(source, /"-RequestId"[\s\S]*command\.requestId/);
  assert.match(source, /CommandLine -like '\*update-production\.ps1\*'/);
  assert.match(source, /CommandLine -like '\*\$\{requestId\}\*'/);
  assert.doesNotMatch(source, /command\.(?:shell|path|branch|environment|args)/);
});

test("canonical Windows launcher enables the separately classified update gate", () => {
  const source = readFileSync(resolve("scripts/windows/start-production.ps1"), "utf8");
  assert.match(source, /\$env:PANEL_UPDATE_CONTROLS_ENABLED\s*=\s*"true"/);
  assert.match(source, /Get-ArtemSoftwareUpdateLock/);
  assert.match(source, /-not\s+\$UpdateRequestId/);
});

test("dashboard observes the durable update transaction without a browser timeout", () => {
  const controls = readFileSync(resolve("apps/dashboard/src/RuntimeControls.tsx"), "utf8");
  const observer = readFileSync(resolve("apps/dashboard/src/runtimeUpdateObserver.ts"), "utf8");
  assert.doesNotMatch(controls, /UPDATE_STATUS_MAX_POLLS/);
  assert.match(controls, /observePanelUpdate/);
  assert.match(controls, /api\/v1\/system\/production-build/);
  assert.match(controls, /Переподключаемся к панели/);
  assert.match(observer, /no browser elapsed-time deadline/);
  assert.match(observer, /event\.type === "success" \|\| event\.type === "failure"/);
});
