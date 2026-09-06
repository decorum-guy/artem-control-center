import { existsSync } from "node:fs";
import { resolve } from "node:path";

const revisionPattern = /^[a-f0-9]{40}$/;

export function resolveSetupVenvRoot(root, configuredVenv) {
  return configuredVenv ? resolve(configuredVenv) : resolve(root, ".venv");
}

export function resolveRevisionScopedVenvRoot(runtimeRoot, revision) {
  if (!revisionPattern.test(revision)) {
    throw new Error("A revision-scoped runtime environment requires an exact Git revision");
  }
  return resolve(runtimeRoot, "venvs", revision);
}

export function resolveVenvPython(venvRoot, platform = process.platform) {
  return resolve(venvRoot, platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export function resolvePythonExecutable(root, configuredVenv, platform = process.platform, exists = existsSync) {
  const venvPython = resolveVenvPython(resolveSetupVenvRoot(root, configuredVenv), platform);
  if (configuredVenv) {
    if (!exists(venvPython)) {
      throw new Error("PANEL_RUNTIME_VENV is configured but its Python executable is missing");
    }
    return venvPython;
  }

  return exists(venvPython) ? venvPython : platform === "win32" ? "py" : "python3";
}
