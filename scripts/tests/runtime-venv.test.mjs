import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveRevisionScopedVenvRoot,
  resolveSetupVenvRoot,
  resolveVenvPython
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
