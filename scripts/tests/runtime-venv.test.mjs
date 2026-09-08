import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearStagedRuntimeVenvMarker,
  readStagedRuntimeVenvRoot,
  resolveRevisionScopedVenvRoot,
  resolveSetupVenvRoot,
  resolveVenvPython,
  stagedRuntimeVenvMarkerPath,
  writeStagedRuntimeVenvMarker
} from "../runtime-venv.mjs";

test("explicit setup environment uses its requested revision-scoped path", () => {
  const root = resolve("/project");
  const runtimeRoot = resolve("/temporary/ArtemControlCenter");
  const revision = "a".repeat(40);
  const scoped = resolveRevisionScopedVenvRoot(runtimeRoot, revision);
  assert.equal(resolveSetupVenvRoot(root, scoped), scoped);
  assert.equal(resolveVenvPython(scoped, "linux"), resolve(scoped, "bin/python"));
  assert.equal(resolveVenvPython(scoped, "win32"), resolve(scoped, "Scripts/python.exe"));
});

test("ordinary developer setup retains the checkout-local virtualenv default", () => {
  const root = resolve("/project");
  assert.equal(resolveSetupVenvRoot(root, ""), resolve(root, ".venv"));
  assert.equal(resolveSetupVenvRoot(root, undefined), resolve(root, ".venv"));
});

test("revision-scoped environments reject symbolic or malformed revisions", () => {
  assert.throws(
    () => resolveRevisionScopedVenvRoot(resolve("/temporary/ArtemControlCenter"), "main"),
    /exact Git revision/
  );
});

test("first-rollout staging marker binds only the exact target revision venv", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-first-rollout-venv-"));
  const revision = "d".repeat(40);
  const runtimeRoot = join(root, "ArtemControlCenter");
  const targetVenv = resolveRevisionScopedVenvRoot(runtimeRoot, revision);
  try {
    const marker = writeStagedRuntimeVenvMarker(root, targetVenv, revision);
    assert.equal(marker, stagedRuntimeVenvMarkerPath(root));
    assert.equal(readStagedRuntimeVenvRoot(root, revision), targetVenv);

    const markerPayload = JSON.parse(readFileSync(marker, "utf8"));
    assert.deepEqual(Object.keys(markerPayload).sort(), ["revision", "schemaVersion", "venvRoot"]);
    assert.equal(markerPayload.revision, revision);

    assert.equal(
      writeStagedRuntimeVenvMarker(root, join(runtimeRoot, "venvs", "e".repeat(40)), revision),
      null,
      "a setup environment for another revision cannot become a fallback"
    );
    clearStagedRuntimeVenvMarker(root);
    assert.equal(readStagedRuntimeVenvRoot(root, revision), null, "ordinary setup can restore developer selection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging marker reader rejects malformed, stale, and non-runtime paths", () => {
  const root = mkdtempSync(join(tmpdir(), "artem-first-rollout-venv-invalid-"));
  const revision = "f".repeat(40);
  try {
    mkdirSync(resolve(root, "node_modules", ".cache", "artem-control-center"), { recursive: true });
    const marker = stagedRuntimeVenvMarkerPath(root);
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "panel-staged-runtime-venv.v1",
      revision: "e".repeat(40),
      venvRoot: join(root, "runtime", "venvs", revision)
    }));
    assert.equal(readStagedRuntimeVenvRoot(root, revision), null);

    writeFileSync(marker, JSON.stringify({
      schemaVersion: "panel-staged-runtime-venv.v1",
      revision,
      venvRoot: join(root, "runtime", "other", revision)
    }));
    assert.equal(readStagedRuntimeVenvRoot(root, revision), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production smoke provisions the exact runtime contract without enabling Coffee ingress", () => {
  const smoke = readFileSync(new URL("../production-smoke.mjs", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../production-runtime.mjs", import.meta.url), "utf8");
  assert.match(smoke, /git", \["rev-parse", "HEAD"\]/);
  assert.match(smoke, /PANEL_RUNTIME_VENV: smokeVenv/);
  assert.match(smoke, /provisionSmokeVenv\(\)/);
  assert.match(smoke, /PANEL_COFFEE_DIARY_UPLOAD_ORIGIN: ""/);
  assert.match(runtime, /resolveRevisionScopedVenvRoot\(runtimeDir, revision\)/);
  assert.doesNotMatch(runtime, /resolve\(root, "\.venv"/);
});
