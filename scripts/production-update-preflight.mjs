import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readStagedRuntimeVenvRoot, resolveVenvPython } from "./runtime-venv.mjs";

const root = resolve(import.meta.dirname, "..");
const revisionPattern = /^[a-f0-9]{40}$/;

export function checkoutRevision(workingRoot, spawn = spawnSync) {
  const result = spawn("git", ["rev-parse", "HEAD"], {
    cwd: workingRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  const revision = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return revisionPattern.test(revision) ? revision : null;
}

/**
 * A configured venv is only a location hint. The target checkout-local marker
 * written by setup is the authority, and it must bind this exact HEAD and the
 * same revision-scoped venv. This also supports c8, which restores the env
 * after setup before invoking target `npm run check`.
 */
export function resolveTrustedProductionUpdateStaging(
  workingRoot,
  configuredVenv,
  { platform = process.platform, exists = existsSync, getRevision = checkoutRevision, readMarker = readStagedRuntimeVenvRoot } = {}
) {
  const revision = getRevision(workingRoot);
  if (!revision) return null;
  const markerVenv = readMarker(workingRoot, revision);
  if (!markerVenv) return null;
  if (configuredVenv && resolve(configuredVenv) !== markerVenv) return null;
  const python = resolveVenvPython(markerVenv, platform);
  if (!exists(python)) return null;
  return { revision, venvRoot: markerVenv, python };
}

function runPython(python, args, workingRoot, env, spawn) {
  const result = spawn(python, args, {
    cwd: workingRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(`Production update preflight failed: ${detail}`);
  }
}

export function runProductionUpdatePreflight({
  root: workingRoot = root,
  env = process.env,
  resolveStaging = resolveTrustedProductionUpdateStaging,
  spawn = spawnSync
} = {}) {
  const trusted = resolveStaging(workingRoot, env.PANEL_RUNTIME_VENV);
  if (!trusted) {
    throw new Error("Production update preflight requires exact revision staging evidence and its Python executable");
  }
  runPython(trusted.python, ["--version"], workingRoot, env, spawn);
  // This imports the real ASGI application without starting uvicorn, opening
  // port 8787, or entering its lifespan.
  runPython(
    trusted.python,
    ["-c", "import sys; sys.path.insert(0, 'apps/panel-agent/src'); import fastapi; import panel_agent.main; assert panel_agent.main.app"],
    workingRoot,
    env,
    spawn
  );
  return trusted;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const trusted = runProductionUpdatePreflight();
    console.log(`Production update preflight passed for ${trusted.revision}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production update preflight failed");
    process.exit(1);
  }
}
