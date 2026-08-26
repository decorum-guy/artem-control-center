import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  activePanelUpdateLease,
  isSafePanelUpdateCommand,
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

test("panel update command accepts only exact bounded revision metadata", () => {
  assert.equal(isSafePanelUpdateCommand(validCommand()), true);
  assert.equal(isSafePanelUpdateCommand({ ...validCommand(), expectedTargetHead: CURRENT }), false);
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
