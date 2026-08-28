"""Run each Coffee Diary test node in a bounded child process on Windows CI."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = ROOT / "apps/panel-agent/tests/test_coffee_diary.py"
TEST_TIMEOUT_SECONDS = 30


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    else:
        process.kill()
    process.wait(timeout=10)


def _run_node(node: str) -> int:
    test_id = f"{TEST_FILE}::{node.split('::', 1)[1]}"
    command = [sys.executable, "-m", "pytest", test_id, "-q"]
    print(f"START {node}", flush=True)
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        output, _ = process.communicate(timeout=TEST_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        _terminate_process(process)
        output = error.output or ""
        print(f"TIMEOUT after {TEST_TIMEOUT_SECONDS}s: {node}", flush=True)
        if output:
            print(output[-4000:], end="" if output.endswith("\n") else "\n", flush=True)
        return 124
    if output:
        print(output[-4000:], end="" if output.endswith("\n") else "\n", flush=True)
    if process.returncode != 0:
        print(f"FAIL exit {process.returncode}: {node}", flush=True)
    else:
        print(f"PASS {node}", flush=True)
    return process.returncode


def _collect_nodes() -> list[str]:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(TEST_FILE), "--collect-only", "-q"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=TEST_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        print(result.stdout, end="", flush=True)
        print(result.stderr, end="", file=sys.stderr, flush=True)
        raise SystemExit(result.returncode)
    nodes: list[str] = []
    for line in result.stdout.splitlines():
        if "test_coffee_diary.py::test_" in line:
            node = line.strip()
            if node not in nodes:
                nodes.append(node)
    if not nodes:
        raise SystemExit("No Coffee Diary tests were collected")
    return nodes


def main() -> int:
    nodes = _collect_nodes()
    print(f"Collected {len(nodes)} Coffee Diary test nodes", flush=True)
    for node in nodes:
        result = _run_node(node)
        if result != 0:
            return result
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
