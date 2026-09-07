import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

const revisionPattern = /^[a-f0-9]{40}$/;
export const STAGED_RUNTIME_VENV_MARKER_SCHEMA = "panel-staged-runtime-venv.v1";
export const STAGED_RUNTIME_VENV_MARKER_PATH = join(
  "node_modules",
  ".cache",
  "artem-control-center",
  "revision-runtime-venv.json"
);

export function resolveSetupVenvRoot(root, configuredVenv) {
  return configuredVenv ? resolve(configuredVenv) : resolve(root, ".venv");
}

export function resolveRevisionScopedVenvRoot(runtimeRoot, revision) {
  if (!revisionPattern.test(revision)) {
    throw new Error("A revision-scoped runtime environment requires an exact Git revision");
  }
  return resolve(runtimeRoot, "venvs", revision);
}

export function stagedRuntimeVenvMarkerPath(root) {
  return resolve(root, STAGED_RUNTIME_VENV_MARKER_PATH);
}

function checkoutRevision(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  const revision = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return revisionPattern.test(revision) ? revision : null;
}

function isRevisionScopedRuntimeVenv(venvRoot, revision) {
  const normalized = resolve(venvRoot);
  return (
    basename(normalized).toLowerCase() === revision
    && basename(dirname(normalized)).toLowerCase() === "venvs"
    && basename(dirname(dirname(normalized))).toLowerCase() === "artemcontrolcenter"
  );
}

/**
 * A staged worktree cannot rely on its parent updater retaining environment
 * variables.  Setup records only the explicit, exact-revision runtime venv in
 * the worktree's ignored dependency cache.  It is intentionally not a general
 * Python discovery mechanism: revision, schema, and venv layout must all match.
 */
export function writeStagedRuntimeVenvMarker(root, configuredVenv, revision = checkoutRevision(root)) {
  if (!configuredVenv || !revision || !isRevisionScopedRuntimeVenv(configuredVenv, revision)) return null;
  const markerPath = stagedRuntimeVenvMarkerPath(root);
  const payload = {
    schemaVersion: STAGED_RUNTIME_VENV_MARKER_SCHEMA,
    revision,
    venvRoot: resolve(configuredVenv)
  };
  mkdirSync(dirname(markerPath), { recursive: true });
  const temporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  try {
    renameSync(temporary, markerPath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    rmSync(markerPath, { force: true });
    renameSync(temporary, markerPath);
  }
  return markerPath;
}

export function clearStagedRuntimeVenvMarker(root) {
  rmSync(stagedRuntimeVenvMarkerPath(root), { force: true });
}

export function readStagedRuntimeVenvRoot(root, revision = checkoutRevision(root)) {
  if (!revision) return null;
  try {
    const marker = JSON.parse(readFileSync(stagedRuntimeVenvMarkerPath(root), "utf8"));
    if (
      !marker
      || typeof marker !== "object"
      || Array.isArray(marker)
      || Object.keys(marker).sort().join(",") !== "revision,schemaVersion,venvRoot"
      || marker.schemaVersion !== STAGED_RUNTIME_VENV_MARKER_SCHEMA
      || marker.revision !== revision
      || typeof marker.venvRoot !== "string"
      || !isRevisionScopedRuntimeVenv(marker.venvRoot, revision)
    ) {
      return null;
    }
    return resolve(marker.venvRoot);
  } catch {
    return null;
  }
}

export function resolveVenvPython(venvRoot, platform = process.platform) {
  return resolve(venvRoot, platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export function resolvePythonExecutable(root, configuredVenv, platform = process.platform, exists = existsSync) {
  // This bridge is solely for OLD-UPDATER -> NEW-TARGET staging: old updater
  // versions restore PANEL_RUNTIME_VENV after `npm run setup`, while the target
  // still has to run its check/build from the same worktree.  Normal developer
  // setup creates no marker and retains the checkout-local .venv behavior.
  const stagedVenv = configuredVenv ? null : readStagedRuntimeVenvRoot(root);
  const selectedVenv = configuredVenv || stagedVenv;
  const venvPython = resolveVenvPython(resolveSetupVenvRoot(root, selectedVenv), platform);
  if (configuredVenv) {
    if (!exists(venvPython)) {
      throw new Error("PANEL_RUNTIME_VENV is configured but its Python executable is missing");
    }
    return venvPython;
  }

  if (stagedVenv) {
    if (!exists(venvPython)) {
      throw new Error("The staged revision runtime Python executable is missing");
    }
    return venvPython;
  }

  return exists(venvPython) ? venvPython : platform === "win32" ? "py" : "python3";
}
