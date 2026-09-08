import test from "node:test";
import assert from "node:assert/strict";
import { checkCommandPlan, runCheck, runCheckCommand } from "../check.mjs";

test("ordinary check retains the complete historical test and dashboard-build gate", () => {
  const plan = checkCommandPlan({ platform: process.platform, getTrustedStaging: () => null });
  assert.equal(plan.kind, "full");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  assert.deepEqual(plan.commands, [[npmCommand, ["run", "test"]], [npmCommand, ["run", "build"]]]);
});

test("Windows ordinary check remains full and plans npm.cmd for both gates", () => {
  const plan = checkCommandPlan({ platform: "win32", getTrustedStaging: () => null });
  assert.equal(plan.kind, "full");
  assert.deepEqual(plan.commands, [["npm.cmd", ["run", "test"]], ["npm.cmd", ["run", "build"]]]);
});

test("only proven exact production staging routes old updater check to its narrow preflight", () => {
  const plan = checkCommandPlan({
    platform: "win32",
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

test("Windows .cmd commands use the explicit command processor without shell mode", () => {
  const calls = [];
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  runCheckCommand("npm.cmd", ["run", "test"], "/repo", env, {
    platform: "win32",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    }
  });
  assert.deepEqual(calls, [{
    command: env.ComSpec,
    args: ["/d", "/s", "/c", "npm.cmd", "run", "test"],
    options: { cwd: "/repo", env, stdio: "inherit", shell: false }
  }]);
});

test("non-Windows commands remain directly spawned without a shell wrapper", () => {
  const calls = [];
  runCheckCommand("npm", ["run", "test"], "/repo", {}, {
    platform: "linux",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    }
  });
  assert.deepEqual(calls, [{
    command: "npm",
    args: ["run", "test"],
    options: { cwd: "/repo", env: {}, stdio: "inherit", shell: false }
  }]);
});

test("spawn failures produce bounded diagnostics without exposing the child error", () => {
  let exitCode;
  let diagnostic = "";
  runCheckCommand("npm", ["run", "test"], "/repo", {}, {
    platform: "linux",
    spawn: () => ({ status: null, error: new Error("secret environment detail") }),
    exit: (code) => { exitCode = code; },
    writeError: (message) => { diagnostic += `${message}\n`; }
  });
  assert.equal(exitCode, 1);
  assert.equal(diagnostic, "Failed to start check command: npm\n");
  assert.doesNotMatch(diagnostic, /secret environment detail/);
});
