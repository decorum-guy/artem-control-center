"""Run the Coffee Diary tests one function at a time on Windows CI."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = ROOT / "apps/panel-agent/tests/test_coffee_diary.py"
LOCK_TEST_FILE = ROOT / "apps/panel-agent/tests/test_coffee_diary_lock.py"
NODE_PATTERN = re.compile(r"test_coffee_diary\.py::(test_[^\[\r\n]+)")


def run_pytest(*arguments: str, timeout: float) -> int:
    command = [sys.executable, "-m", "pytest", *arguments]
    print("$ " + " ".join(command), flush=True)
    try:
        result = subprocess.run(command, cwd=ROOT, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"Timed out after {timeout:.0f}s: {' '.join(arguments)}", flush=True)
        return 124
    return result.returncode


def main() -> int:
    print(f"Collecting {TEST_FILE}", flush=True)
    collection_command = [sys.executable, "-m", "pytest", str(TEST_FILE), "--collect-only", "-q"]
    try:
        collected = subprocess.run(
            collection_command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        print("Timed out while collecting Coffee Diary tests", flush=True)
        return 124
    print(collected.stdout, end="", flush=True)
    print(collected.stderr, end="", file=sys.stderr, flush=True)
    if collected.returncode != 0:
        return collected.returncode

    functions: list[str] = []
    for match in NODE_PATTERN.finditer(collected.stdout):
        function = match.group(1)
        if function not in functions:
            functions.append(function)
    if not functions:
        print("No Coffee Diary tests were collected", flush=True)
        return 1

    for function in functions:
        result = run_pytest(f"{TEST_FILE}::{function}", "-q", timeout=30)
        if result != 0:
            print(f"Coffee Diary test failed: {function} (exit {result})", flush=True)
            return result
    return run_pytest(str(LOCK_TEST_FILE), "-q", timeout=30)


if __name__ == "__main__":
    raise SystemExit(main())
