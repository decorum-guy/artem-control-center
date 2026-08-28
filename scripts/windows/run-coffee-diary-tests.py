"""Run Coffee Diary tests in isolated, bounded subprocesses on Windows CI."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = "apps/panel-agent/tests/test_coffee_diary.py"
LOCK_TEST_FILE = "apps/panel-agent/tests/test_coffee_diary_lock.py"


def _pytest(
    *arguments: str,
    capture_output: bool = False,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest", *arguments],
        cwd=ROOT,
        check=False,
        text=True,
        capture_output=capture_output,
        timeout=timeout,
    )


def _collect_test_functions() -> list[str]:
    result = _pytest(TEST_FILE, "--collect-only", "-q", capture_output=True)
    if result.returncode != 0:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    nodes: list[str] = []
    for line in result.stdout.splitlines():
        if "::test_" not in line:
            continue
        node = line.split("[", 1)[0]
        if node.startswith("tests/"):
            node = f"apps/panel-agent/{node}"
        if node not in nodes:
            nodes.append(node)
    return nodes


def main() -> int:
    nodes = _collect_test_functions()
    if not nodes:
        print("No Coffee Diary tests were collected", flush=True)
        return 1
    for node in nodes:
        print(f"Running {node}", flush=True)
        try:
            result = _pytest(node, "-q", timeout=30)
        except subprocess.TimeoutExpired:
            print(f"Coffee Diary test timed out: {node}", flush=True)
            return 124
        if result.returncode != 0:
            print(f"Coffee Diary test failed: {node} (exit {result.returncode})", flush=True)
            return result.returncode
    result = _pytest(LOCK_TEST_FILE, "-q", timeout=30)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
