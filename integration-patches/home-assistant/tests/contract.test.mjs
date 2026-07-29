import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packagePath = path.join(root, "config/packages/coffee_control_center.yaml");
const manifestPath = path.join(root, "entity-manifest.json");
const packageText = fs.readFileSync(packagePath, "utf8");
const config = yaml.load(packageText);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("package YAML parses and canonical entities use valid domains", () => {
  assert.equal(config.input_number.coffee_warmup_minutes.initial, 13);
  assert.equal(config.input_number.coffee_long_running_minutes.initial, 60);
  assert.equal(config.input_datetime.coffee_last_turned_on.has_time, true);

  for (const entityId of Object.values(manifest.entities)) {
    assert.match(entityId, /^[a-z_]+\.[a-z0-9_]+$/);
  }
});

test("activation capture accepts only a confirmed off-to-on transition", () => {
  const automation = config.automation.find(
    (item) => item.id === "coffee_capture_confirmed_turn_on",
  );

  assert.equal(automation.trigger.length, 1);
  assert.deepEqual(automation.trigger[0], {
    platform: "state",
    entity_id: "switch.kofemashina",
    from: "off",
    to: "on",
  });
  assert.equal(
    automation.action[0].target.entity_id,
    "input_datetime.coffee_last_turned_on",
  );
});

test("safe scripts target the discovered HA entities", () => {
  assert.equal(
    config.script.coffee_turn_on.sequence[0].target.entity_id,
    "switch.kofemashina",
  );
  assert.equal(
    config.script.kettle_boil.sequence[0].target.entity_id,
    "water_heater.chainik",
  );
  assert.equal(
    config.script.kettle_stop.sequence[0].data.operation_mode,
    "off",
  );
  assert.doesNotMatch(packageText, /\boverheat(?:ed|ing)?\b/i);
});
