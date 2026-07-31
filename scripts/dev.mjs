import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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

const runtimeDir = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, "ArtemControlCenter")
  : resolve(root, ".runtime");
const runtimeCommandPath = process.env.PANEL_RUNTIME_COMMAND_PATH
  ?? resolve(runtimeDir, "runtime-command.json");
const kioskControlsEnabled = process.env.PANEL_KIOSK_CONTROLS_ENABLED
  ?? (isWindows ? "true" : "false");

mkdirSync(runtimeDir, { recursive: true });
rmSync(runtimeCommandPath, { force: true });

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
    if (!shuttingDown) shutdown(code ?? 1);
  });
}

let shuttingDown = false;
let commandTimer;

function stopChildTree(child) {
  if (!child.pid || child.killed) return;
  if (isWindows) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  child.kill("SIGTERM");
}

function closeKioskWindow() {
  if (!isWindows) return;
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
    "| Where-Object { $_.CommandLine -like '*--kiosk*' -and $_.CommandLine -like '*127.0.0.1:5173/overview*' }",
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join(" ");
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: "ignore", windowsHide: true }
  );
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (commandTimer) clearInterval(commandTimer);
  rmSync(runtimeCommandPath, { force: true });
  for (const child of children) stopChildTree(child);
  setTimeout(() => process.exit(code), 100).unref();
}

function consumeRuntimeCommand() {
  if (!existsSync(runtimeCommandPath) || shuttingDown) return;
  try {
    const command = JSON.parse(readFileSync(runtimeCommandPath, "utf8"));
    rmSync(runtimeCommandPath, { force: true });
    if (command.action === "hide") {
      closeKioskWindow();
      return;
    }
    if (command.action === "shutdown") {
      closeKioskWindow();
      setTimeout(() => shutdown(0), 150).unref();
    }
  } catch (error) {
    rmSync(runtimeCommandPath, { force: true });
    console.error("Invalid runtime command:", error);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(
  venvPython,
  ["-m", "uvicorn", "panel_agent.main:app", "--app-dir", "apps/panel-agent/src", "--host", "127.0.0.1", "--port", "8787", "--reload"],
  {
    PANEL_AGENT_MODE: requestedMode,
    PANEL_FIXTURE_WRITES_ENABLED: requestedMode === "fixtures" ? "true" : "false",
    PANEL_KIOSK_CONTROLS_ENABLED: kioskControlsEnabled,
    PANEL_RUNTIME_COMMAND_PATH: runtimeCommandPath
  }
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

commandTimer = setInterval(consumeRuntimeCommand, 250);
commandTimer.unref();
