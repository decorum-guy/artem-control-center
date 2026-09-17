import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, ["playwright", "test", "tests/e2e/issue-173-coffee-geometry.spec.ts"], {
  cwd: root,
  env: {
    ...process.env,
    VITE_V2_VISUAL_SHELL: "true",
    VITE_OVERVIEW_V2_ENABLED: "true"
  },
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
