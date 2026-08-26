import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid runtime.env line: ${rawLine}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid runtime.env key: ${key}`);
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export class RestartBudget {
  constructor({ maximum = 5, windowMs = 10 * 60_000 } = {}) {
    this.maximum = maximum;
    this.windowMs = windowMs;
    this.events = [];
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.events = this.events.filter((timestamp) => timestamp >= cutoff);
  }

  record(now = Date.now()) {
    this.prune(now);
    if (this.events.length >= this.maximum) return false;
    this.events.push(now);
    return true;
  }

  count(now = Date.now()) {
    this.prune(now);
    return this.events.length;
  }
}

export function planRestart(budget, { allowBeyondBudget = false, now = Date.now() } = {}) {
  const recorded = budget.record(now);
  const count = budget.count(now);
  return {
    accepted: recorded || allowBeyondBudget,
    recorded,
    delayMs: Math.min(1_000 * 2 ** Math.max(0, count - 1), 15_000)
  };
}

export const CAPABILITY_APPLY_MAX_RECOVERY_FAILURES = 3;

export function createCapabilityApplyLifecycle({ onSuccess, onRestart, onRollback }) {
  let activeApply = null;
  let appliedRevision = null;

  function clear() {
    appliedRevision = null;
    activeApply = null;
  }

  return {
    get activeApply() {
      return activeApply;
    },
    get appliedRevision() {
      return appliedRevision;
    },
    activate({ revision, backup }) {
      activeApply = { revision, backup, recoveryFailures: 0 };
      appliedRevision = revision;
      onRestart("capabilities applied", { allowBeyondBudget: true });
    },
    acceptHealth() {
      if (appliedRevision === null) return false;
      const revision = appliedRevision;
      onSuccess(revision);
      clear();
      return true;
    },
    handleAgentExit() {
      if (!activeApply) {
        onRestart("agent process exited unexpectedly");
        return "normal_restart";
      }

      activeApply.recoveryFailures += 1;
      if (activeApply.recoveryFailures >= CAPABILITY_APPLY_MAX_RECOVERY_FAILURES) {
        const pendingApply = activeApply;
        clear();
        onRollback("new_runtime_exited", pendingApply);
        return "rollback";
      }

      onRestart("agent process exited during capability apply", { allowBeyondBudget: true });
      return "recovery_restart";
    },
    handleHealthFailure() {
      if (!activeApply) {
        onRestart("three consecutive health failures");
        return "normal_restart";
      }

      const pendingApply = activeApply;
      clear();
      onRollback("new_runtime_health_failed", pendingApply);
      return "rollback";
    }
  };
}

export function shouldCreateManualStop(command) {
  return command?.action === "shutdown" && command.manual !== false;
}

function atomicWriteJson(path, payload) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    rmSync(path, { force: true });
    renameSync(temporary, path);
  }
}

function pruneLogs(logDir, retentionDays = 14) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith("runtime-") || !name.endsWith(".log")) continue;
    const path = join(logDir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A log being rotated or removed concurrently is harmless.
    }
  }
}

function createLogger(logDir) {
  mkdirSync(logDir, { recursive: true });
  pruneLogs(logDir);
  return (level, message) => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const line = `${now.toISOString()} [${level}] ${String(message).replace(/\r?\n/g, "\\n")}\n`;
    appendFileSync(join(logDir, `runtime-${day}.log`), line, "utf8");
  };
}

function attachStream(stream, prefix, log) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line) log("INFO", `${prefix} ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffer) log("INFO", `${prefix} ${buffer}`);
  });
}

function currentRevision(root) {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function buildAgentEnvironment({
  baseEnv = {},
  fileEnv = {},
  mode,
  commandPath,
  dashboardDist,
  stateCachePath,
  calendarDisplayColorPath,
  capabilityOverridesPath,
  capabilityApplyStatePath,
  buildRevision = "unknown"
}) {
  return {
    ...baseEnv,
    ...fileEnv,
    PANEL_AGENT_MODE: mode,
    PANEL_AGENT_BUILD_REVISION: buildRevision,
    PANEL_KIOSK_CONTROLS_ENABLED: "true",
    PANEL_RUNTIME_COMMAND_PATH: commandPath,
    PANEL_DASHBOARD_DIST: dashboardDist,
    PANEL_STATE_CACHE_PATH: stateCachePath,
    PANEL_CALENDAR_DISPLAY_COLOR_PATH: calendarDisplayColorPath,
    PANEL_CAPABILITY_OVERRIDES_PATH: capabilityOverridesPath,
    PANEL_CAPABILITY_APPLY_STATE_PATH: capabilityApplyStatePath,
    PANEL_CAPABILITY_APPLY_ENABLED: "true"
  };
}

export function isSafeCapabilityApplyCommand(command) {
  return Boolean(
    command
    && command.schemaVersion === 1
    && command.action === "apply_capabilities"
    && Number.isInteger(command.expectedRevision)
    && command.expectedRevision >= 0
    && typeof command.requestId === "string"
    && /^[a-f0-9]{24}$/.test(command.requestId)
  );
}

export function isSafePanelUpdateCommand(command) {
  if (!command || typeof command !== "object") return false;
  const keys = Object.keys(command).sort();
  const allowed = [
    "action",
    "expectedCurrentHead",
    "expectedTargetHead",
    "requestId",
    "requestedAt",
    "schemaVersion"
  ].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return false;
  return Boolean(
    command.schemaVersion === 1
    && command.action === "update_panel"
    && typeof command.expectedCurrentHead === "string"
    && /^[a-f0-9]{40}$/.test(command.expectedCurrentHead)
    && typeof command.expectedTargetHead === "string"
    && /^[a-f0-9]{40}$/.test(command.expectedTargetHead)
    && command.expectedCurrentHead !== command.expectedTargetHead
    && typeof command.requestId === "string"
    && /^[a-f0-9]{24}$/.test(command.requestId)
    && typeof command.requestedAt === "string"
    && Number.isFinite(Date.parse(command.requestedAt))
  );
}

export const UPDATE_HANDOFF_MAX_AGE_MS = 2 * 60_000;

export function activePanelUpdateLease(
  payload,
  { nowMs = Date.now(), ownerAlive = () => false } = {}
) {
  if (
    !payload
    || payload.schemaVersion !== 1
    || payload.status !== "updating"
    || typeof payload.requestId !== "string"
    || !/^[a-f0-9]{24}$/.test(payload.requestId)
  ) {
    return null;
  }
  const updatedAt = Date.parse(payload.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;

  if (payload.ownerPid !== undefined && payload.ownerPid !== null) {
    if (!Number.isInteger(payload.ownerPid) || payload.ownerPid <= 0) return null;
    return ownerAlive(payload.ownerPid, payload.requestId) ? payload : null;
  }

  const ageMs = nowMs - updatedAt;
  if (ageMs < 0 || ageMs > UPDATE_HANDOFF_MAX_AGE_MS) return null;
  return payload;
}

export function capabilityStoreRevision(path) {
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return payload?.schemaVersion === "capability-overrides.v1" && Number.isInteger(payload.revision)
      ? payload.revision
      : null;
  } catch {
    return null;
  }
}

export function activateStagedDashboard({ active, staging, backup }) {
  if (!existsSync(join(staging, "index.html"))) throw new Error("staged_dashboard_missing_index");
  if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  let activeMoved = false;
  try {
    if (existsSync(active)) {
      renameSync(active, backup);
      activeMoved = true;
    }
    renameSync(staging, active);
  } catch (error) {
    if (activeMoved && !existsSync(active) && existsSync(backup)) renameSync(backup, active);
    throw error;
  }
}

export function restoreDashboardBackup({ active, backup }) {
  if (!existsSync(backup)) throw new Error("dashboard_backup_missing");
  rmSync(active, { recursive: true, force: true });
  renameSync(backup, active);
}

function stopProcessTree(child, log) {
  if (!child?.pid || child.killed) return;
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { encoding: "utf8", windowsHide: true }
    );
    if (result.status !== 0) {
      log("WARN", `taskkill for agent ${child.pid} returned ${result.status}`);
    }
  } else {
    child.kill("SIGTERM");
  }
}

function closeKioskWindow(edgeProfileDir, log) {
  if (process.platform !== "win32") return;
  const escaped = edgeProfileDir.replace(/'/g, "''");
  const script = [
    `$profile = '${escaped}'`,
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
    "| Where-Object { $_.CommandLine -like ('*' + $profile + '*') }",
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) log("WARN", "Unable to close the panel-owned Edge profile");
}

function updaterOwnerProcessAlive(ownerPid, requestId) {
  if (process.platform !== "win32" || !Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  if (typeof requestId !== "string" || !/^[a-f0-9]{24}$/.test(requestId)) return false;
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${ownerPid}\" -ErrorAction SilentlyContinue`,
    "$hasRequestArgument = $null -ne $process -and $process.CommandLine -like '*-RequestId*'",
    "if ($null -ne $process",
    "-and $process.Name -in @('powershell.exe','pwsh.exe')",
    "-and $process.CommandLine -like '*update-production.ps1*'",
    `-and (-not $hasRequestArgument -or $process.CommandLine -like '*${requestId}*')) { exit 0 }`,
    "exit 1"
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  return result.status === 0;
}

async function probeHealth(url, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runProductionRuntime() {
  const root = resolve(import.meta.dirname, "..");
  const isWindows = process.platform === "win32";
  const runtimeDir = process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "ArtemControlCenter")
    : resolve(root, ".runtime", "production");
  const logDir = join(runtimeDir, "logs");
  const configPath = join(runtimeDir, "runtime.env");
  const commandPath = join(runtimeDir, "runtime-command.json");
  const statePath = join(runtimeDir, "runtime-state.json");
  const manualStopPath = join(runtimeDir, "manual-stop.json");
  const edgeProfileDir = join(runtimeDir, "edge-profile");
  const dashboardDist = resolve(root, "apps", "dashboard", "dist");
  const capabilityOverridesPath = join(runtimeDir, "capability-overrides.json");
  const capabilityApplyStatePath = join(runtimeDir, "capability-apply-state.json");
  const updateLockPath = join(runtimeDir, "update-lock.json");
  const updateStatePath = join(runtimeDir, "update-state.json");
  const updaterPath = resolve(root, "scripts", "windows", "update-production.ps1");
  const venvPython = resolve(root, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
  const log = createLogger(logDir);

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(edgeProfileDir, { recursive: true });

  if (existsSync(manualStopPath)) {
    log("INFO", "Manual-stop marker present; production runtime will not start");
    return 0;
  }
  if (!existsSync(venvPython)) throw new Error("Python environment missing; run npm run setup");
  if (!existsSync(join(dashboardDist, "index.html"))) {
    throw new Error("Dashboard build missing; run npm run build");
  }

  const fileEnv = existsSync(configPath)
    ? parseEnvText(readFileSync(configPath, "utf8"))
    : {};
  const mode = fileEnv.PANEL_AGENT_MODE || process.env.PANEL_AGENT_MODE || "fixtures";
  if (!new Set(["fixtures", "read_only", "integration_test", "production"]).has(mode)) {
    throw new Error(`Unsupported PANEL_AGENT_MODE in runtime.env: ${mode}`);
  }

  const revision = currentRevision(root);
  const agentEnv = buildAgentEnvironment({
    baseEnv: process.env,
    fileEnv,
    mode,
    buildRevision: revision,
    commandPath,
    dashboardDist,
    stateCachePath: fileEnv.PANEL_STATE_CACHE_PATH || join(runtimeDir, "panel-state-cache.json"),
    calendarDisplayColorPath: fileEnv.PANEL_CALENDAR_DISPLAY_COLOR_PATH || join(runtimeDir, "calendar-display-colors.json"),
    capabilityOverridesPath,
    capabilityApplyStatePath
  });

  process.title = "artem-control-center-runtime";
  rmSync(commandPath, { force: true });

  const restartBudget = new RestartBudget();
  const expectedExitPids = new Set();
  let agent = null;
  let restartPending = false;
  let shuttingDown = false;
  let healthFailures = 0;
  let healthCheckRunning = false;
  let commandTimer = null;
  let healthTimer = null;
  let restartTimer = null;
  let applyingCapabilities = false;

  function writeCapabilityApplyState(status, extra = {}) {
    atomicWriteJson(capabilityApplyStatePath, {
      schemaVersion: 1,
      status,
      updatedAt: new Date().toISOString(),
      ...extra
    });
  }

  function writeUpdateState(status, result) {
    atomicWriteJson(updateStatePath, {
      schemaVersion: 1,
      status,
      updatedAt: new Date().toISOString(),
      ...(result ? { result } : {})
    });
  }

  function activeUpdateLock() {
    try {
      const payload = JSON.parse(readFileSync(updateLockPath, "utf8"));
      return activePanelUpdateLease(payload, { ownerAlive: updaterOwnerProcessAlive });
    } catch {
      return null;
    }
  }

  function rejectUpdateHandoff(command, reason) {
    log("WARN", `Rejected panel update handoff: ${reason}`);
    writeUpdateState("failed", reason);
    const lock = activeUpdateLock();
    if (lock?.requestId === command?.requestId) rmSync(updateLockPath, { force: true });
  }

  function writeState(status, extra = {}) {
    atomicWriteJson(statePath, {
      schemaVersion: 1,
      status,
      supervisorPid: status === "stopped" ? null : process.pid,
      agentPid: agent?.pid ?? null,
      mode,
      revision,
      observedAt: new Date().toISOString(),
      restartCountInWindow: restartBudget.count(),
      ...extra
    });
  }

  function spawnAgent() {
    if (shuttingDown) return;
    const child = spawn(
      venvPython,
      [
        "-m",
        "uvicorn",
        "panel_agent.production:app",
        "--app-dir",
        "apps/panel-agent/src",
        "--host",
        "127.0.0.1",
        "--port",
        "8787"
      ],
      {
        cwd: root,
        env: agentEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    agent = child;
    healthFailures = 0;
    attachStream(child.stdout, "[agent]", log);
    attachStream(child.stderr, "[agent:error]", log);
    log("INFO", `Panel Agent started with pid=${child.pid}, mode=${mode}, revision=${revision}`);
    writeState("starting");

    child.once("exit", (code, signal) => {
      if (agent === child) agent = null;
      const expected = expectedExitPids.delete(child.pid);
      log(
        expected ? "INFO" : "ERROR",
        `Panel Agent exited pid=${child.pid} code=${code ?? "null"} signal=${signal ?? "none"}`
      );
      if (!shuttingDown && !expected) {
        capabilityApplyLifecycle.handleAgentExit();
      }
    });
  }

  function requestRestart(reason, { allowBeyondBudget = false } = {}) {
    if (shuttingDown || restartPending) return;
    const restartPlan = planRestart(restartBudget, { allowBeyondBudget });
    if (!restartPlan.accepted) {
      log("ERROR", `Restart budget exhausted after: ${reason}`);
      writeState("failed", { lastError: "restart_budget_exhausted" });
      void shutdown(1);
      return;
    }
    restartPending = true;
    log("WARN", `Restarting Panel Agent: ${reason}`);
    const previous = agent;
    if (previous?.pid) expectedExitPids.add(previous.pid);
    stopProcessTree(previous, log);
    agent = null;
    const delay = restartPlan.delayMs;
    restartTimer = setTimeout(() => {
      restartPending = false;
      spawnAgent();
    }, delay);
  }

  function rollbackCapabilityApply(reason, pendingApply) {
    if (!pendingApply) return;
    log("ERROR", `Capability apply health acceptance failed: ${reason}`);
    if (agent?.pid) expectedExitPids.add(agent.pid);
    stopProcessTree(agent, log);
    agent = null;
    try {
      restoreDashboardBackup({ active: dashboardDist, backup: pendingApply.backup });
    } catch (error) {
      log("ERROR", `Capability dashboard rollback failed: ${error?.message || error}`);
      writeCapabilityApplyState("failed", { revision: pendingApply.revision, code: "rollback_failed" });
      return;
    }
    writeCapabilityApplyState("failed", { revision: pendingApply.revision, code: "new_runtime_unhealthy" });
    requestRestart("capability rollback to known-good dashboard", { allowBeyondBudget: true });
  }

  const capabilityApplyLifecycle = createCapabilityApplyLifecycle({
    onSuccess: (revision) => writeCapabilityApplyState("success", { revision }),
    onRestart: (reason, options) => requestRestart(reason, options),
    onRollback: (reason, pendingApply) => rollbackCapabilityApply(reason, pendingApply)
  });

  async function shutdown(exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (commandTimer) clearInterval(commandTimer);
    if (healthTimer) clearInterval(healthTimer);
    if (restartTimer) clearTimeout(restartTimer);
    rmSync(commandPath, { force: true });
    closeKioskWindow(edgeProfileDir, log);
    if (agent?.pid) expectedExitPids.add(agent.pid);
    stopProcessTree(agent, log);
    agent = null;
    writeState("stopped", { exitCode });
    log("INFO", `Production runtime stopped with exitCode=${exitCode}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    process.exit(exitCode);
  }

  function currentCheckoutIsBuildSafe() {
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (inside.status !== 0 || inside.stdout.trim() !== "true") return false;
    const changes = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", windowsHide: true });
    return changes.status === 0 && changes.stdout.trim() === "";
  }

  function applyCapabilities(command) {
    if (applyingCapabilities) return;
    applyingCapabilities = true;
    writeCapabilityApplyState("queued", { revision: command.expectedRevision });
    try {
      if (!isSafeCapabilityApplyCommand(command)) throw new Error("invalid_capability_apply_command");
      if (activeUpdateLock()) throw new Error("software_update_active");
      if (capabilityStoreRevision(capabilityOverridesPath) !== command.expectedRevision) throw new Error("capability_revision_changed");
      if (!currentCheckoutIsBuildSafe()) throw new Error("production_checkout_not_build_safe");

      const staging = join(runtimeDir, `dashboard-staging-${command.requestId}`);
      const backup = join(runtimeDir, "dashboard-last-known-good");
      rmSync(staging, { recursive: true, force: true });
      writeCapabilityApplyState("building", { revision: command.expectedRevision });
      const npmCli = process.env.npm_execpath;
      const commandName = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
      const commandArgs = npmCli ? [npmCli, "run", "build:production"] : ["run", "build:production"];
      const build = spawnSync(commandName, commandArgs, {
        cwd: root,
        env: {
          ...process.env,
          PANEL_CAPABILITY_OVERRIDES_PATH: capabilityOverridesPath,
          PANEL_PRODUCTION_BUILD_OUT_DIR: staging
        },
        encoding: "utf8",
        windowsHide: true
      });
      if (build.status !== 0 || !existsSync(join(staging, "index.html")) || !existsSync(join(staging, "dashboard-capabilities.json"))) {
        rmSync(staging, { recursive: true, force: true });
        throw new Error("capability_build_failed");
      }
      if (capabilityStoreRevision(capabilityOverridesPath) !== command.expectedRevision) {
        rmSync(staging, { recursive: true, force: true });
        throw new Error("capability_revision_changed");
      }
      writeCapabilityApplyState("restarting", { revision: command.expectedRevision });
      activateStagedDashboard({ active: dashboardDist, staging, backup });
      capabilityApplyLifecycle.activate({ revision: command.expectedRevision, backup });
    } catch (error) {
      log("ERROR", `Capability apply failed: ${error?.message || error}`);
      writeCapabilityApplyState("failed", { revision: command.expectedRevision, code: "apply_failed" });
    } finally {
      applyingCapabilities = false;
    }
  }

  function launchPanelUpdate(command) {
    if (!isSafePanelUpdateCommand(command)) {
      rejectUpdateHandoff(command, "invalid_update_command");
      return;
    }
    if (!isWindows || !existsSync(updaterPath)) {
      rejectUpdateHandoff(command, "updater_unavailable");
      return;
    }
    if (applyingCapabilities || capabilityApplyLifecycle.activeApply) {
      rejectUpdateHandoff(command, "capability_apply_active");
      return;
    }
    const lock = activeUpdateLock();
    if (
      !lock
      || lock.requestId !== command.requestId
      || lock.expectedCurrentHead !== command.expectedCurrentHead
      || lock.expectedTargetHead !== command.expectedTargetHead
    ) {
      rejectUpdateHandoff(command, "update_lock_mismatch");
      return;
    }

    const updater = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        updaterPath,
        "-ExpectedCurrentHead",
        command.expectedCurrentHead,
        "-ExpectedTargetHead",
        command.expectedTargetHead,
        "-RequestId",
        command.requestId
      ],
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      }
    );
    updater.unref();
    log("INFO", `Panel update handoff accepted requestId=${command.requestId}`);
  }

  function consumeRuntimeCommand() {
    if (shuttingDown || !existsSync(commandPath)) return;
    let command;
    try {
      command = JSON.parse(readFileSync(commandPath, "utf8"));
    } catch (error) {
      log("ERROR", `Invalid runtime command JSON: ${error}`);
      rmSync(commandPath, { force: true });
      return;
    }
    rmSync(commandPath, { force: true });
    if (command?.schemaVersion !== 1) {
      log("WARN", "Rejected runtime command with unsupported schemaVersion");
      return;
    }
    if (command.action === "hide") {
      log("INFO", "Runtime command accepted: hide kiosk");
      closeKioskWindow(edgeProfileDir, log);
      return;
    }
    if (command.action === "shutdown") {
      const manual = shouldCreateManualStop(command);
      log("INFO", `Runtime command accepted: shutdown manual=${manual}`);
      if (manual) {
        atomicWriteJson(manualStopPath, {
          schemaVersion: 1,
          reason: "manual_shutdown",
          createdAt: new Date().toISOString()
        });
      }
      void shutdown(0);
      return;
    }
    if (command.action === "apply_capabilities") {
      applyCapabilities(command);
      return;
    }
    if (command.action === "update_panel") {
      launchPanelUpdate(command);
      return;
    }
    log("WARN", `Rejected unsupported runtime action: ${String(command?.action)}`);
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    log("ERROR", `Uncaught exception: ${error?.stack || error}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (error) => {
    log("ERROR", `Unhandled rejection: ${error?.stack || error}`);
    void shutdown(1);
  });

  log("INFO", `Production runtime starting root=${root}`);
  spawnAgent();
  commandTimer = setInterval(consumeRuntimeCommand, 250);
  healthTimer = setInterval(async () => {
    if (shuttingDown || restartPending || healthCheckRunning || !agent) return;
    healthCheckRunning = true;
    try {
      const healthy = await probeHealth("http://127.0.0.1:8787/health/live");
      if (healthy) {
        if (healthFailures > 0) log("INFO", "Panel Agent health recovered");
        healthFailures = 0;
        writeState("running");
        capabilityApplyLifecycle.acceptHealth();
      } else {
        healthFailures += 1;
        log("WARN", `Panel Agent health failure ${healthFailures}/3`);
        if (healthFailures >= 3) {
          capabilityApplyLifecycle.handleHealthFailure();
        }
      }
    } finally {
      healthCheckRunning = false;
    }
  }, 10_000);

  return await new Promise(() => {});
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  runProductionRuntime()
    .then((code) => process.exit(code))
    .catch((error) => {
      const runtimeDir = process.env.LOCALAPPDATA
        ? resolve(process.env.LOCALAPPDATA, "ArtemControlCenter")
        : resolve(import.meta.dirname, "..", ".runtime", "production");
      const log = createLogger(join(runtimeDir, "logs"));
      log("ERROR", error?.stack || error);
      process.exit(1);
    });
}
