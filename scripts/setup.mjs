import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const venvPython = resolve(root, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");

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
  run(isWindows ? "py" : "python3", ["-m", "venv", ".venv"]);
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "-r", "apps/panel-agent/requirements-dev.txt"]);

console.log("Setup complete. Start with: npm run dev:fixtures");
