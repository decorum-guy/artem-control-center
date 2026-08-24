import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { productionBuildEnvironment, productionBuildProfileName } from "./production-build-profile.mjs";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli ? [npmCli, "run", "build"] : ["run", "build"];

console.log(`Building production profile: ${productionBuildProfileName}`);
const result = spawnSync(command, args, {
  cwd: root,
  env: productionBuildEnvironment(),
  stdio: "inherit",
  shell: false,
  windowsHide: true
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./production-build-assert.mjs");
