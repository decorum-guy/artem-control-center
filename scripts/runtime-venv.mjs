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
