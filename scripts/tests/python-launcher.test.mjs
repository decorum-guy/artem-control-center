import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolvePythonExecutable,
  resolveRevisionScopedVenvRoot,
  resolveSetupVenvRoot,
  resolveVenvPython
} from "../runtime-venv.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

function withDetachedSource(callback) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "artem-python-launcher-source-"));
  try {
    mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
    copyFileSync(resolve(repoRoot, "scripts/python.mjs"), join(sourceRoot, "scripts/python.mjs"));
    copyFileSync(resolve(repoRoot, "scripts/runtime-venv.mjs"), join(sourceRoot, "scripts/runtime-venv.mjs"));
    assert.equal(existsSync(join(sourceRoot, ".venv")), false);
    return callback(sourceRoot);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function runDetachedLauncher(sourceRoot, configuredVenv, args) {
  const env = { ...process.env, PANEL_RUNTIME_VENV: configuredVenv };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return spawnSync(
    process.execPath,
    [join(sourceRoot, "scripts/python.mjs"), ...args],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env,
      windowsHide: true
    }
  );
}

test("configured revision-scoped venv is authoritative without a checkout-local .venv", () => {
  const checkoutRoot = resolve("/detached/source");
  const runtimeRoot = resolve("/runtime/ArtemControlCenter");
  const configuredVenv = resolveRevisionScopedVenvRoot(runtimeRoot, "a".repeat(40));
  const expectedPython = resolveVenvPython(configuredVenv, "win32");

  assert.equal(
    resolvePythonExecutable(
      checkoutRoot,
      configuredVenv,
      "win32",
      (candidate) => candidate === expectedPython
    ),
    expectedPython
  );
});

test("explicitly configured venv does not fall back when its Python is missing", () => {
  const configuredVenv = resolve("/runtime/ArtemControlCenter/venvs/" + "b".repeat(40));

  assert.throws(
    () => resolvePythonExecutable(resolve("/detached/source"), configuredVenv, "linux", () => false),
    /PANEL_RUNTIME_VENV is configured but its Python executable is missing/
  );
});

test("developer selection still prefers .venv and retains the system fallback", () => {
  const checkoutRoot = resolve("/checkout");
  const localPython = resolveVenvPython(resolveSetupVenvRoot(checkoutRoot), "linux");

  assert.equal(
    resolvePythonExecutable(checkoutRoot, undefined, "linux", (candidate) => candidate === localPython),
    localPython
  );
  assert.equal(resolvePythonExecutable(checkoutRoot, undefined, "linux", () => false), "python3");
  assert.equal(resolvePythonExecutable(checkoutRoot, "", "win32", () => false), "py");
});

test("setup and the Python launcher share the configured venv root contract", () => {
  const checkoutRoot = resolve("/detached/source");
  const configuredVenv = resolveRevisionScopedVenvRoot(
    resolve("/runtime/ArtemControlCenter"),
    "c".repeat(40)
  );
  const setupRoot = resolveSetupVenvRoot(checkoutRoot, configuredVenv);
  const expectedPython = resolveVenvPython(setupRoot, "linux");

  assert.equal(setupRoot, configuredVenv);
  assert.equal(
    resolvePythonExecutable(checkoutRoot, configuredVenv, "linux", (candidate) => candidate === expectedPython),
    expectedPython
  );
});

test("detached source runs pytest through the configured environment", (t) => {
  const configuredVenv = resolve(repoRoot, ".venv");
  const configuredPython = resolveVenvPython(configuredVenv);
  if (!existsSync(configuredPython)) {
    t.skip("run npm run setup before the executable Python launcher regression");
    return;
  }

  withDetachedSource((sourceRoot) => {
    const testRoot = join(sourceRoot, "apps/panel-agent/tests");
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(
      join(testRoot, "test_configured_runtime_venv.py"),
      `import os\nimport sys\n\n\ndef normalized(path):\n    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))\n\n\ndef test_python_and_pytest_are_from_configured_environment():\n    expected = normalized(os.environ["PANEL_RUNTIME_VENV"])\n    assert normalized(sys.prefix) == expected\n    assert os.path.normcase(os.path.abspath(sys.executable)).startswith(expected + os.sep)\n    import pytest\n    assert normalized(pytest.__file__).startswith(expected + os.sep)\n`,
      "utf8"
    );

    const result = runDetachedLauncher(sourceRoot, configuredVenv, [
      "-m",
      "pytest",
      "apps/panel-agent/tests/test_configured_runtime_venv.py",
      "-q"
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /1 passed/);
  });
});

test("detached source reports a missing configured interpreter without system fallback", () => {
  withDetachedSource((sourceRoot) => {
    const missingVenv = join(sourceRoot, "runtime/venvs", "d".repeat(40));
    const result = runDetachedLauncher(sourceRoot, missingVenv, [
      "-c",
      "print('system-fallback-marker')"
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PANEL_RUNTIME_VENV is configured but its Python executable is missing/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /system-fallback-marker/);
  });
});
