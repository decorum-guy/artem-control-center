import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const venvPython = resolve(root, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
const executable = existsSync(venvPython) ? venvPython : isWindows ? "py" : "python3";
const child = spawn(executable, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

