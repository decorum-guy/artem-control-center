import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvText,
  RestartBudget,
  shouldCreateManualStop
} from "../production-runtime.mjs";

test("parseEnvText accepts comments, export and quoted values", () => {
  assert.deepEqual(
    parseEnvText(`
      # local configuration
      PANEL_AGENT_MODE=fixtures
      export PANEL_AVALAR_MAIN_URL="https://example.test"
      PANEL_EMPTY=''
    `),
    {
      PANEL_AGENT_MODE: "fixtures",
      PANEL_AVALAR_MAIN_URL: "https://example.test",
      PANEL_EMPTY: ""
    }
  );
});

test("parseEnvText rejects invalid keys and malformed lines", () => {
  assert.throws(() => parseEnvText("lowercase=value"), /Invalid runtime\.env key/);
  assert.throws(() => parseEnvText("PANEL_AGENT_MODE"), /Invalid runtime\.env line/);
});

test("RestartBudget enforces a bounded rolling window", () => {
  const budget = new RestartBudget({ maximum: 2, windowMs: 1_000 });
  assert.equal(budget.record(0), true);
  assert.equal(budget.record(500), true);
  assert.equal(budget.record(900), false);
  assert.equal(budget.count(900), 2);
  assert.equal(budget.record(1_501), true);
  assert.equal(budget.count(1_501), 1);
});

test("only a manual shutdown creates a persistent stop marker", () => {
  assert.equal(shouldCreateManualStop({ action: "shutdown" }), true);
  assert.equal(shouldCreateManualStop({ action: "shutdown", manual: true }), true);
  assert.equal(shouldCreateManualStop({ action: "shutdown", manual: false }), false);
  assert.equal(shouldCreateManualStop({ action: "hide" }), false);
});
