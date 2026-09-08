import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveTrustedProductionUpdateStaging } from "./production-update-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * `check` remains the normal full repository gate. The sole exception is a
 * target worktree which can independently prove that setup created its exact
 * revision-scoped runtime environment. This lets the already-installed c8
 * updater call `npm run check` without repeating CI before its separate
 * accepted-v2 build.
 */
export function checkCommandPlan({ root: workingRoot = root, env = process.env, getTrustedStaging = resolveTrustedProductionUpdateStaging } = {}) {
  const trusted = getTrustedStaging(workingRoot, env.PANEL_RUNTIME_VENV);
  return trusted
    ? { kind: "production-update-preflight", commands: [[process.execPath, ["scripts/production-update-preflight.mjs"]]] }
    : { kind: "full", commands: [[npmCommand, ["run", "test"]], [npmCommand, ["run", "build"]]] };
}

export function runCheck(options = {}) {
  const { root: workingRoot = root, env = process.env, getTrustedStaging, execute = run } = options;
  const plan = checkCommandPlan({ root: workingRoot, env, getTrustedStaging });
  for (const [command, args] of plan.commands) execute(command, args, workingRoot, env);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) runCheck();
