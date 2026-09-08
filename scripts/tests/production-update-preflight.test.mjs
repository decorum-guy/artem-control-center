import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveTrustedProductionUpdateStaging, runProductionUpdatePreflight } from "../production-update-preflight.mjs";

const revision = "a".repeat(40);
const venv = resolve("/temporary/ArtemControlCenter/venvs", revision);

function trustedOptions(overrides = {}) {
  return {
    platform: "linux",
    exists: () => true,
    getRevision: () => revision,
    readMarker: () => venv,
    ...overrides
  };
}

test("exact revision marker and executable resolve a trusted staging preflight", () => {
  const staging = resolveTrustedProductionUpdateStaging("/target", venv, trustedOptions());
  assert.deepEqual(staging, { revision, venvRoot: venv, python: resolve(venv, "bin/python") });
});

test("missing, malformed, mismatched, wrong-revision, and missing-python evidence cannot select narrow staging", () => {
  for (const options of [
    trustedOptions({ readMarker: () => null }),
    trustedOptions({ getRevision: () => null }),
    trustedOptions({
      getRevision: () => "b".repeat(40),
      readMarker: (_root, requestedRevision) => requestedRevision === revision ? venv : null
    }),
    trustedOptions({ exists: () => false })
  ]) {
    assert.equal(resolveTrustedProductionUpdateStaging("/target", undefined, options), null);
  }
  assert.equal(resolveTrustedProductionUpdateStaging("/target", "/other/venv", trustedOptions()), null);
});

test("preflight launches only the exact Python version and import checks without starting a runtime", () => {
  const calls = [];
  const staging = runProductionUpdatePreflight({
    root: "/target",
    resolveStaging: () => ({ revision, venvRoot: venv, python: "/venv/python" }),
    spawn: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(staging.revision, revision);
  assert.deepEqual(calls.map(([, args]) => args[0]), ["--version", "-c"]);
  assert.match(calls[1][1][1], /import panel_agent\.main/);
  assert.doesNotMatch(calls[1][1][1], /uvicorn|8787|lifespan/);
});

test("missing Python, marker mismatch, and failed production import stop before cutover", () => {
  assert.throws(
    () => runProductionUpdatePreflight({ resolveStaging: () => null }),
    /requires exact revision staging evidence/
  );
  assert.throws(
    () => runProductionUpdatePreflight({
      resolveStaging: () => ({ revision, venvRoot: venv, python: "/venv/python" }),
      spawn: (_command, args) => ({ status: args[0] === "--version" ? 0 : 1, stderr: "required import failed" })
    }),
    /required import failed/
  );
});
