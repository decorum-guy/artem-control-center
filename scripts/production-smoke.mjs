import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRevisionScopedVenvRoot } from "./runtime-venv.mjs";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "artem-runtime-smoke-"));
const runtimeRoot = join(temporaryRoot, "ArtemControlCenter");
const commandPath = join(runtimeRoot, "runtime-command.json");
const manualStopPath = join(runtimeRoot, "manual-stop.json");
const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const revision = revisionResult.status === 0 ? revisionResult.stdout.trim().toLowerCase() : "";
const smokeVenv = resolveRevisionScopedVenvRoot(runtimeRoot, revision);

const smokeEnvironment = {
  ...process.env,
  LOCALAPPDATA: temporaryRoot,
  PANEL_RUNTIME_VENV: smokeVenv,
  PANEL_AGENT_MODE: "fixtures",
  PANEL_WRITES_ENABLED: "false",
  PANEL_COFFEE_TIMING_WRITES_ENABLED: "false",
  PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED: "false",
  PANEL_COFFEE_ACTIONS_ENABLED: "false",
  PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: "",
  PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST: "",
  PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT: ""
};

function provisionSmokeVenv() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "run", "setup"] : ["run", "setup"];
  const result = spawnSync(command, args, {
    cwd: root,
    env: smokeEnvironment,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Smoke runtime setup failed with ${result.status ?? "unknown"}`);
}

let child = null;

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Startup connection failures are expected until Uvicorn is listening.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForExit(timeoutMs) {
  if (!child) throw new Error("Production runtime was not started");
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code))),
    sleep(timeoutMs).then(() => {
      throw new Error("Production runtime did not exit after shutdown command");
    })
  ]);
}

function runtimeLogs() {
  const logDir = join(runtimeRoot, "logs");
  if (!existsSync(logDir)) return "No runtime log directory was created.";
  return readdirSync(logDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => `--- ${name} ---\n${readFileSync(join(logDir, name), "utf8")}`)
    .join("\n");
}

try {
  provisionSmokeVenv();
  child = spawn(process.execPath, ["scripts/production-runtime.mjs"], {
    cwd: root,
    env: smokeEnvironment,
    stdio: "ignore",
    windowsHide: true
  });
  await waitFor(async () => {
    const response = await fetch("http://127.0.0.1:8787/health/ready");
    return response.ok;
  }, 45_000, "Panel Agent readiness");

  const page = await fetch("http://127.0.0.1:8787/overview");
  if (!page.ok || !(await page.text()).includes('id="root"')) {
    throw new Error("Built dashboard was not served by the production ASGI app");
  }

  const runtimeStatus = await fetch("http://127.0.0.1:8787/api/v1/system/runtime");
  const statusPayload = await runtimeStatus.json();
  if (!runtimeStatus.ok || statusPayload.enabled !== true) {
    throw new Error("Runtime control API was not enabled by the supervisor");
  }

  writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      action: "shutdown",
      manual: false,
      requestedAt: new Date().toISOString(),
      requestedBy: "ci-smoke"
    })}\n`,
    "utf8"
  );

  const exitCode = await waitForExit(20_000);
  if (exitCode !== 0) throw new Error(`Production runtime exited with ${exitCode}`);
  if (existsSync(manualStopPath)) {
    throw new Error("Maintenance shutdown incorrectly created a manual-stop marker");
  }

  console.log("Production runtime smoke test passed.");
} catch (error) {
  if (child?.exitCode === null) child.kill("SIGTERM");
  console.error(runtimeLogs());
  throw error;
} finally {
  if (child?.exitCode === null) child.kill("SIGTERM");
  await sleep(300);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
