import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { delayedBuildCapabilityVariables, loadProductionCapabilityOverrides, productionBuildCapabilities, productionBuildEnvironment, productionBuildProfileName } from "./production-build-profile.mjs";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli ? [npmCli, "run", "build"] : ["run", "build"];

const overrides = loadProductionCapabilityOverrides(process.env);
const capabilities = productionBuildCapabilities(overrides);
const buildEnvironment = productionBuildEnvironment(process.env, overrides);
for (const variable of Object.values(delayedBuildCapabilityVariables)) {
  process.env[variable] = buildEnvironment[variable];
}
const outDir = process.env.PANEL_PRODUCTION_BUILD_OUT_DIR
  ? resolve(process.env.PANEL_PRODUCTION_BUILD_OUT_DIR)
  : resolve(root, "apps", "dashboard", "dist");
console.log(`Building production profile: ${productionBuildProfileName}`);
const result = spawnSync(command, args, {
  cwd: root,
  env: buildEnvironment,
  stdio: "inherit",
  shell: false,
  windowsHide: true
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
writeFileSync(resolve(outDir, "dashboard-capabilities.json"), `${JSON.stringify({
  schemaVersion: "dashboard-capabilities.v1",
  profile: productionBuildProfileName,
  baseline: capabilities.baseline,
  active: capabilities.active,
  flags: capabilities.flags
}, null, 2)}\n`, "utf8");
await import("./production-build-assert.mjs");
