import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, ["playwright", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
