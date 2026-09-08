import test from "node:test";
import assert from "node:assert/strict";
import { checkCommandPlan, runCheck } from "../check.mjs";

test("ordinary check retains the complete historical test and dashboard-build gate", () => {
  const plan = checkCommandPlan({ getTrustedStaging: () => null });
  assert.equal(plan.kind, "full");
  assert.deepEqual(plan.commands, [["npm", ["run", "test"]], ["npm", ["run", "build"]]]);
});

test("only proven exact production staging routes old updater check to its narrow preflight", () => {
  const plan = checkCommandPlan({
    env: { PANEL_RUNTIME_VENV: "C:/runtime/venvs/a" },
    getTrustedStaging: () => ({ revision: "a".repeat(40), venvRoot: "C:/runtime/venvs/a", python: "C:/runtime/venvs/a/Scripts/python.exe" })
  });
  assert.equal(plan.kind, "production-update-preflight");
  assert.deepEqual(plan.commands, [[process.execPath, ["scripts/production-update-preflight.mjs"]]]);
});

test("the compatibility route executes neither the full suite nor the ordinary build", () => {
  const commands = [];
  runCheck({
    getTrustedStaging: () => ({ revision: "a".repeat(40) }),
    execute: (command, args) => commands.push([command, args])
  });
  assert.deepEqual(commands, [[process.execPath, ["scripts/production-update-preflight.mjs"]]]);
});
