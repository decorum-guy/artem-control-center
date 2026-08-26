import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isSafePanelUpdateCommand } from "../production-runtime.mjs";

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

test("supervisor handoff is wired to the fixed canonical updater script", () => {
  const source = readFileSync(resolve("scripts/production-runtime.mjs"), "utf8");
  assert.match(source, /const updaterPath = resolve\(root, "scripts", "windows", "update-production\.ps1"\)/);
  assert.match(source, /command\.action === "update_panel"/);
  assert.match(source, /"-ExpectedCurrentHead"[\s\S]*command\.expectedCurrentHead/);
  assert.match(source, /"-ExpectedTargetHead"[\s\S]*command\.expectedTargetHead/);
  assert.match(source, /"-RequestId"[\s\S]*command\.requestId/);
  assert.doesNotMatch(source, /command\.(?:shell|path|branch|environment|args)/);
});
