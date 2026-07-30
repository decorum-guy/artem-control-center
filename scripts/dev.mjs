import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requestedMode = process.argv[2] ?? "read_only";
const allowedModes = new Set(["fixtures", "read_only", "integration_test"]);
if (!allowedModes.has(requestedMode)) {
  console.error(`Unsupported development mode: ${requestedMode}`);
  process.exit(2);
}

const isWindows = process.platform === "win32";
const venvPython = resolve(root, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
if (!existsSync(venvPython)) {
  console.error("Python environment missing. Run `npm run setup` first.");
  process.exit(2);
}

const children = [];
function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(
  venvPython,
  ["-m", "uvicorn", "panel_agent.main:app", "--app-dir", "apps/panel-agent/src", "--host", "127.0.0.1", "--port", "8787", "--reload"],
  { PANEL_AGENT_MODE: requestedMode }
);

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("npm CLI path is unavailable. Start through an npm script.");
  shutdown(2);
} else {
  const viteArgs = [
    npmCli,
    "run",
    "dev",
    "--workspace",
    "@artem/dashboard",
    "--",
    "--host",
    "127.0.0.1"
  ];
  if (process.argv.includes("--open")) viteArgs.push("--open");
  start(process.execPath, viteArgs, { VITE_PANEL_MODE: requestedMode });
}

