import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolvePythonExecutable } from "./runtime-venv.mjs";

const root = resolve(import.meta.dirname, "..");
let executable;
try {
  executable = resolvePythonExecutable(root, process.env.PANEL_RUNTIME_VENV);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to resolve the Python executable");
  process.exit(2);
}

const child = spawn(executable, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
