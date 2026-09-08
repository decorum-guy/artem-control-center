import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveTrustedProductionUpdateStaging } from "./production-update-preflight.mjs";

const root = resolve(import.meta.dirname, "..");

export function runCheckCommand(
  command,
  args,
  cwd = root,
  env = process.env,
  {
    platform = process.platform,
    spawn = spawnSync,
    exit = (code) => process.exit(code),
    writeError = (message) => process.stderr.write(`${message}\n`)
  } = {}
) {
  const usesWindowsCmdWrapper = platform === "win32" && command.toLowerCase().endsWith(".cmd");
  const executable = usesWindowsCmdWrapper ? env.ComSpec || "cmd.exe" : command;
  const executableArgs = usesWindowsCmdWrapper ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawn(executable, executableArgs, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) {
    writeError(`Failed to start check command: ${usesWindowsCmdWrapper ? "cmd.exe" : command}`);
    exit(result.status ?? 1);
    return result;
  }
  if (result.status !== 0) exit(result.status ?? 1);
  return result;
}

/**
 * `check` remains the normal full repository gate. The sole exception is a
 * target worktree which can independently prove that setup created its exact
 * revision-scoped runtime environment. This lets the already-installed c8
 * updater call `npm run check` without repeating CI before its separate
 * accepted-v2 build.
 */
export function checkCommandPlan({ root: workingRoot = root, env = process.env, platform = process.platform, getTrustedStaging = resolveTrustedProductionUpdateStaging } = {}) {
  const trusted = getTrustedStaging(workingRoot, env.PANEL_RUNTIME_VENV);
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  return trusted
    ? { kind: "production-update-preflight", commands: [[process.execPath, ["scripts/production-update-preflight.mjs"]]] }
    : { kind: "full", commands: [[npmCommand, ["run", "test"]], [npmCommand, ["run", "build"]]] };
}

export function runCheck(options = {}) {
  const { root: workingRoot = root, env = process.env, platform = process.platform, getTrustedStaging, execute } = options;
  const plan = checkCommandPlan({ root: workingRoot, env, platform, getTrustedStaging });
  const run = execute ?? ((command, args, cwd, runEnv) => runCheckCommand(command, args, cwd, runEnv, { platform }));
  for (const [command, args] of plan.commands) run(command, args, workingRoot, env);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) runCheck();
