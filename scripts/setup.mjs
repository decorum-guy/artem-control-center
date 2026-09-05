import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveSetupVenvRoot, resolveVenvPython } from "./runtime-venv.mjs";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
// Production updates prepare an exact-revision virtualenv beneath the runtime
// root before cutover.  It is deliberately outside the checkout: a venv embeds
// its creation path and cannot safely be moved from a worktree afterwards.
const configuredVenv = process.env.PANEL_RUNTIME_VENV;
const venvRoot = resolveSetupVenvRoot(root, configuredVenv);
const venvPython = resolveVenvPython(venvRoot, process.platform);

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    run(process.execPath, [npmCli, ...args]);
    return;
  }
  if (isWindows) {
    console.error("npm CLI path is unavailable. Run `npm run setup`.");
    process.exit(2);
  }
  run("npm", args);
}

if (!existsSync(resolve(root, "node_modules"))) {
  runNpm(["install"]);
}

if (!existsSync(venvPython)) {
  run(isWindows ? "py" : "python3", ["-m", "venv", venvRoot]);
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "-r", "apps/panel-agent/requirements-dev.txt"]);

console.log("Setup complete. Start with: npm run dev:fixtures");
