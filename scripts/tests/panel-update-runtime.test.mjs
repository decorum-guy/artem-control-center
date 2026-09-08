import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

import {
  activePanelUpdateLease,
  canPublishPanelUpdateEarlyExit,
  canPublishPanelUpdateRuntimeFailure,
  classifyPanelUpdateLockOwnership,
  createPanelUpdateLauncherLifecycle,
  isExactPanelUpdateLock,
  isSafePanelUpdateCommand,
  readUpdaterBootstrapEvidence,
  readUpdaterLaunchEvidence,
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

function fakeClock() {
  let current = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      const timer = { id: ++nextId, due: current + delay, callback, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer.id);
    },
    advance(milliseconds) {
      const target = current + milliseconds;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((left, right) => left.due - right.due)[0];
        if (!due) break;
        timers.delete(due.id);
        current = due.due;
        due.callback();
      }
      current = target;
    },
    get pending() {
      return timers.size;
    }
  };
}

function launchLifecycle({
  authoritative = false,
  runtimeAlive = true,
  bootstrap = null,
  launchReceipt = null,
  actualProcessAlive = true,
  durable = false,
  acceptanceTimeoutMs,
  probes
} = {}) {
  const launcher = fakeUpdater();
  const failures = [];
  const logs = [];
  const clock = fakeClock();
  let probeIndex = 0;
  createPanelUpdateLauncherLifecycle({
    command: validCommand(),
    launcher,
    isRuntimeAlive: () => runtimeAlive,
    hasAuthoritativeEvidence: () => authoritative,
    publishFailure: (result) => { failures.push(result); return true; },
    readBootstrapEvidence: () => typeof bootstrap === "function" ? bootstrap() : bootstrap,
    readLaunchEvidence: () => launchReceipt,
    isUpdaterProcessAlive: () => probes
      ? probes[Math.min(probeIndex++, probes.length - 1)]
      : actualProcessAlive,
    hasDurableEvidence: () => durable,
    ...(acceptanceTimeoutMs === undefined ? {} : { acceptanceTimeoutMs }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (level, message) => logs.push({ level, message })
  });
  return { launcher, failures, logs, clock };
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
  const clock = fakeClock();
  createPanelUpdateLauncherLifecycle({
    command,
    launcher: updater,
    isRuntimeAlive: () => true,
    hasAuthoritativeEvidence: () => (
      currentState?.schemaVersion === 1
      && ["success", "failed"].includes(currentState.status)
      && currentState.requestId === REQUEST
      && currentState.currentHead === CURRENT
      && currentState.targetHead === TARGET
    ),
    publishFailure: (result, { childPid } = {}) => {
      const durable = currentLock?.ownerPid === childPid || transaction?.requestId === REQUEST;
      if (!canPublishPanelUpdateEarlyExit({ command, state: currentState, lock: currentLock, durable, childPid })) return false;
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
    readLaunchEvidence: () => ({
      stage: "runtime-process-created",
      result: "recorded",
      processId: 4242
    }),
    isUpdaterProcessAlive: () => false,
    hasDurableEvidence: (childPid) => currentLock?.ownerPid === childPid || transaction?.requestId === REQUEST,
    earlyExitMinNegativeObservations: 3,
    earlyExitMinNegativeDurationMs: 20,
    pollIntervalMs: 10,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {}
  });
  updater.emit("spawn");
  updater.emit("exit", 1, null);
  clock.advance(20);
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
  const { launcher, failures, logs } = launchLifecycle();
  assert.equal(logs.length, 0);
  launcher.emit("spawn");
  assert.equal(launcher.unrefCalls, 1);
  assert.equal(failures.length, 0);
  assert.match(logs[0].message, new RegExp(`launcher created requestId=${REQUEST} pid=4242`));
});

test("updater spawn error publishes only the fixed safe spawn result", () => {
  const { launcher, failures, logs } = launchLifecycle();
  launcher.emit("error", new Error("private Powershell launch detail"));
  assert.deepEqual(failures, ["updater_spawn_failed"]);
  assert.equal(logs.some(({ message }) => message.includes("handoff accepted")), false);
  assert.equal(failures.join(" ").includes("private"), false);
});

test("receipt plus an immediate launcher exit tolerates transient false recognition until durable body proof", () => {
  let bootstrap = null;
  const { launcher, failures, logs, clock } = launchLifecycle({
    bootstrap: () => bootstrap,
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    probes: [false, false, false]
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(200);
  assert.deepEqual(failures, [], "one or more transient negatives are not child death");
  bootstrap = { stage: "script-entered", result: "recorded", processId: 4242 };
  clock.advance(100);
  assert.deepEqual(failures, []);
  assert.match(logs.map(({ message }) => message).join(" "), /accepted durable evidence.*body:script-entered/);
  assert.equal(clock.pending, 0, "body acceptance stops PID monitoring instead of leaking an observer");
});

test("multiple transient false probes followed by a live probe remain non-terminal", () => {
  const { launcher, failures, clock } = launchLifecycle({
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    probes: [false, false, true, false, true]
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(700);
  assert.deepEqual(failures, []);
});

test("matching body proof wins over later failed process recognition", () => {
  const { launcher, failures, clock } = launchLifecycle({
    bootstrap: { stage: "script-entered", result: "recorded", processId: 4242 },
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: false
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(1_000);
  assert.deepEqual(failures, []);
  assert.equal(clock.pending, 0);
});

test("matching updater lease, state, or transaction ownership wins over later failed recognition", () => {
  const { launcher, failures, clock } = launchLifecycle({
    durable: true,
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: false
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(1_000);
  assert.deepEqual(failures, []);
  assert.equal(clock.pending, 0);
});

test("genuine child death before body proof requires repeated confirmed absence over grace", () => {
  const { launcher, failures, logs, clock } = launchLifecycle({
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: false
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(499);
  assert.deepEqual(failures, []);
  clock.advance(1);
  assert.deepEqual(failures, ["updater_early_exit"]);
  assert.match(logs.map(({ message }) => message).join(" "), /classification=absent negativeCount=7 negativeDurationMs=500/);
});

test("recognition command and command-line uncertainty never count as process absence", () => {
  const { launcher, failures, logs, clock } = launchLifecycle({
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    probes: [
      { classification: "cim_invocation_failed" },
      { classification: "command_line_unavailable" },
      { classification: "request_mismatch" }
    ],
    acceptanceTimeoutMs: 400
  });
  launcher.emit("spawn");
  clock.advance(400);
  assert.deepEqual(failures, ["updater_stale"]);
  assert.match(logs.map(({ message }) => message).join(" "), /classification=cim_invocation_failed/);
  assert.match(logs.map(({ message }) => message).join(" "), /acceptance timeout.*lastProbe=request_mismatch/);
});

test("bootstrap reader correlates only exact strict bounded evidence", () => {
  const path = resolve(root, "package.json");
  assert.equal(readUpdaterBootstrapEvidence(path, REQUEST), null, "non-bootstrap JSON is ignored");
});

test("bootstrap body proof is strict, request-bound, and PID-bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "artem-bootstrap-evidence-"));
  const path = join(directory, "update-bootstrap.json");
  try {
    const payload = {
      schemaVersion: 2,
      requestId: REQUEST,
      processId: 4242,
      stage: "script-entered",
      result: "recorded",
      updatedAt: new Date().toISOString()
    };
    writeFileSync(path, JSON.stringify(payload));
    assert.deepEqual(readUpdaterBootstrapEvidence(path, REQUEST), {
      stage: "script-entered", result: "recorded", processId: 4242
    });
    writeFileSync(path, JSON.stringify({ ...payload, requestId: "f".repeat(24) }));
    assert.equal(readUpdaterBootstrapEvidence(path, REQUEST), null, "stale request evidence is ignored");
    writeFileSync(path, JSON.stringify({ ...payload, processId: null }));
    assert.equal(readUpdaterBootstrapEvidence(path, REQUEST), null, "body proof requires the actual child PID");
    writeFileSync(path, JSON.stringify({ ...payload, unexpected: true }));
    assert.equal(readUpdaterBootstrapEvidence(path, REQUEST), null, "schema is closed to extra fields");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launch receipt correlates only an actual private updater process", () => {
  const path = resolve(root, "package.json");
  assert.equal(readUpdaterLaunchEvidence(path, REQUEST), null, "non-launch JSON is ignored");
});

test("stale or malformed launch receipt is ignored", () => {
  const directory = mkdtempSync(join(tmpdir(), "artem-launch-receipt-"));
  const path = join(directory, "update-launch.json");
  try {
    const receipt = {
      schemaVersion: 1,
      requestId: REQUEST,
      stage: "runtime-process-created",
      result: "recorded",
      processId: 4242,
      updatedAt: new Date().toISOString()
    };
    writeFileSync(path, JSON.stringify({ ...receipt, requestId: "f".repeat(24) }));
    assert.equal(readUpdaterLaunchEvidence(path, REQUEST), null);
    writeFileSync(path, JSON.stringify({ ...receipt, processId: null }));
    assert.equal(readUpdaterLaunchEvidence(path, REQUEST), null);
    writeFileSync(path, JSON.stringify({ ...receipt, unexpected: true }));
    assert.equal(readUpdaterLaunchEvidence(path, REQUEST), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mismatched request body marker is ignored and cannot accept a different updater", () => {
  const { launcher, failures, clock } = launchLifecycle({
    bootstrap: { stage: "script-entered", result: "recorded", processId: 5252 },
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: true,
    acceptanceTimeoutMs: 200
  });
  launcher.emit("spawn");
  clock.advance(200);
  assert.deepEqual(failures, ["updater_stale"]);
});

test("no receipt or body proof reaches a bounded stale acceptance failure", () => {
  const { launcher, failures, clock } = launchLifecycle({ acceptanceTimeoutMs: 300 });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(300);
  assert.deepEqual(failures, ["updater_stale"]);
  assert.equal(clock.pending, 0);
});

test("launcher exit is not updater success without receipt/body evidence", () => {
  const { launcher, failures, clock } = launchLifecycle({
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: true,
    acceptanceTimeoutMs: 0
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  clock.advance(0);
  assert.deepEqual(failures, ["updater_stale"], "launcher exit alone must not publish success");
});

test("real updater body evidence accepts a surviving independent process", () => {
  const { launcher, failures, logs } = launchLifecycle({
    bootstrap: { stage: "script-entered", result: "recorded", processId: 4242 },
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: true
  });
  launcher.emit("spawn");
  launcher.emit("exit", 0, null);
  assert.deepEqual(failures, []);
  assert.match(logs.map(({ message }) => message).join(" "), /accepted durable evidence.*body:script-entered/);
});

test("authoritative updater evidence wins over early child exit", () => {
  const { launcher, failures, logs } = launchLifecycle({
    authoritative: true,
    launchReceipt: { stage: "runtime-process-created", result: "recorded", processId: 4242 },
    actualProcessAlive: false
  });
  launcher.emit("spawn");
  launcher.emit("exit", 1, null);
  assert.deepEqual(failures, []);
  assert.match(logs.at(-1).message, /accepted durable evidence.*authoritative-state/);
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
  assert.equal(
    canPublishPanelUpdateEarlyExit({
      command,
      state,
      lock: updateLock(new Date().toISOString(), 4242),
      childPid: 4242,
      durable: true
    }),
    false,
    "matching durable updater ownership cannot be overwritten by launch monitoring"
  );
});

test("H1 claimed exact updater lock is durable ownership and suppresses supervisor early exit", () => {
  const lock = updateLock(new Date().toISOString(), 4242);
  const result = simulateEarlyExit({ lock });
  assert.equal(result.state.status, "updating");
  assert.equal(result.state.result, undefined);
  assert.equal(result.lock, result.originalLock);
});

test("H2 matching incomplete transaction is durable ownership and suppresses supervisor early exit", () => {
  const transaction = {
    schemaVersion: 1,
    status: "incomplete",
    phase: "started",
    requestId: REQUEST,
    previousHead: CURRENT,
    targetHead: TARGET
  };
  const result = simulateEarlyExit({ lock: updateLock(new Date().toISOString(), 4242), transaction });
  assert.equal(result.state.status, "updating");
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
  assert.match(source, /const updaterLauncherPath = resolve\(root, "scripts", "windows", "launch-update-production\.ps1"\)/);
  assert.match(source, /command\.action === "update_panel"/);
  assert.match(source, /spawnWindowsUpdaterLauncher/);
  assert.match(source, /"-ExpectedCurrentHead"[\s\S]*command\.expectedCurrentHead/);
  assert.match(source, /"-ExpectedTargetHead"[\s\S]*command\.expectedTargetHead/);
  assert.match(source, /"-RequestId"[\s\S]*command\.requestId/);
  assert.match(source, /function probeUpdaterOwnerProcess/);
  assert.match(source, /CommandLine -notlike '\*update-production\.ps1\*'/);
  assert.match(source, /CommandLine -notlike '\*\$\{requestId\}\*'/);
  assert.match(source, /cim_invocation_failed/);
  assert.match(source, /readUpdaterLaunchEvidence/);
  assert.match(source, /createPanelUpdateLauncherLifecycle/);
  assert.doesNotMatch(source, /detached\s*:\s*true/);
  assert.doesNotMatch(source, /command\.(?:shell|path|branch|environment|args)/);
});

test("canonical Node launcher uses typed fixed arguments without detached PowerShell", () => {
  const source = readFileSync(resolve("scripts/production-runtime.mjs"), "utf8");
  const launcher = source.slice(source.indexOf("export function spawnWindowsUpdaterLauncher"));
  assert.match(launcher, /spawn\([\s\S]*"powershell\.exe"/);
  assert.match(launcher, /"-NoProfile"[\s\S]*"-NonInteractive"[\s\S]*"-ExecutionPolicy"[\s\S]*"Bypass"/);
  assert.match(launcher, /"-File"[\s\S]*launcherPath/);
  assert.match(launcher, /stdio: "ignore"/);
  assert.doesNotMatch(launcher, /detached\s*:/);
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
