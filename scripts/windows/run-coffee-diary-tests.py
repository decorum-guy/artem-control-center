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
    process = subprocess.Popen(command, cwd=ROOT)
    try:
        result = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
                timeout=10,
            )
        else:
            process.kill()
        process.wait(timeout=10)
        print(f"Timed out after {timeout:.0f}s: {' '.join(arguments)}", flush=True)
        return 124
    return result


def main() -> int:
    print(f"Collecting {TEST_FILE}", flush=True)
    collection_command = [sys.executable, "-m", "pytest", str(TEST_FILE), "--collect-only", "-q"]
    collection_process = subprocess.Popen(
        collection_command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        collection_stdout, collection_stderr = collection_process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(collection_process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
                timeout=10,
            )
        else:
            collection_process.kill()
        collection_process.wait(timeout=10)
        print("Timed out while collecting Coffee Diary tests", flush=True)
        return 124
    print(collection_stdout, end="", flush=True)
    print(collection_stderr, end="", file=sys.stderr, flush=True)
    if collection_process.returncode != 0:
        return collection_process.returncode

    functions: list[str] = []
    for match in NODE_PATTERN.finditer(collection_stdout):
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
