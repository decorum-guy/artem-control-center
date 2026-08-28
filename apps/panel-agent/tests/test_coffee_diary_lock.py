from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from panel_agent import coffee_diary
from panel_agent.coffee_diary import (
    CoffeeDiaryBeanCreate,
    CoffeeDiaryStore,
    CoffeeDiaryStoreUnavailable,
    CoffeeDiaryValidationError,
)


_CHILD_LOCK_SCRIPT = """
import sys
import time
from pathlib import Path

from panel_agent.coffee_diary import _file_lock

data_path = Path(sys.argv[1])
marker_path = Path(sys.argv[2])
duration = float(sys.argv[3])

with _file_lock(data_path):
    marker_path.write_text("locked", encoding="utf-8")
    time.sleep(duration)
"""


def _bean(name: str) -> CoffeeDiaryBeanCreate:
    return CoffeeDiaryBeanCreate(name=name)


def _child_environment() -> dict[str, str]:
    source_path = str(Path(__file__).resolve().parents[1] / "src")
    environment = os.environ.copy()
    current_python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        path for path in (source_path, current_python_path) if path
    )
    return environment


def _start_lock_holder(data_path: Path, marker_path: Path, duration: float) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", _CHILD_LOCK_SCRIPT, str(data_path), str(marker_path), str(duration)],
        env=_child_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait_for_lock_holder(marker_path: Path, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 5.0
    while not marker_path.exists():
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(f"lock holder exited early: {process.returncode}\n{stdout}\n{stderr}")
        if time.monotonic() >= deadline:
            process.kill()
            process.communicate()
            raise AssertionError("lock holder did not acquire the lock")
        time.sleep(0.02)


def _finish_lock_holder(process: subprocess.Popen[str]) -> None:
    try:
        stdout, stderr = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise AssertionError(f"lock holder did not exit: {stdout}\n{stderr}")
    if process.returncode != 0:
        raise AssertionError(f"lock holder failed: {process.returncode}\n{stdout}\n{stderr}")


def test_sequential_independent_stores_release_the_os_lock(tmp_path):
    path = tmp_path / "coffee.json"
    store_a = CoffeeDiaryStore(path, writes_enabled=True)
    store_b = CoffeeDiaryStore(path, writes_enabled=True)

    for index in range(8):
        store = store_a if index % 2 == 0 else store_b
        created = store.create_bean(_bean(f"Последовательный кофе {index}"), f"lock-seq-{index:04d}")
        assert created.name == f"Последовательный кофе {index}"

    assert len(store_a.read_document().beans) == 8


def test_store_lock_releases_when_write_raises(tmp_path, monkeypatch):
    path = tmp_path / "coffee.json"
    store_a = CoffeeDiaryStore(path, writes_enabled=True)
    store_b = CoffeeDiaryStore(path, writes_enabled=True)

    def fail_write(_document):
        raise RuntimeError("intentional test failure")

    monkeypatch.setattr(store_a, "_write_document", fail_write)
    with pytest.raises(RuntimeError, match="intentional test failure"):
        store_a.create_bean(_bean("Ошибка записи"), "lock-error-0001")

    created = store_b.create_bean(_bean("После ошибки"), "lock-error-0002")
    assert created.name == "После ошибки"


def test_store_lock_releases_when_mutation_validation_raises(tmp_path):
    path = tmp_path / "coffee.json"
    store_a = CoffeeDiaryStore(path, writes_enabled=True)
    store_b = CoffeeDiaryStore(path, writes_enabled=True)

    def fail_validation(_document):
        raise CoffeeDiaryValidationError("intentional validation failure")

    with pytest.raises(CoffeeDiaryValidationError, match="intentional validation failure"):
        store_a._mutate(fail_validation)

    created = store_b.create_bean(_bean("После валидации"), "lock-validation-0001")
    assert created.name == "После валидации"


def test_cross_process_contention_waits_for_release(tmp_path):
    path = tmp_path / "coffee.json"
    marker = tmp_path / "holder.ready"
    holder = _start_lock_holder(path, marker, 0.25)
    try:
        _wait_for_lock_holder(marker, holder)
        store = CoffeeDiaryStore(path, writes_enabled=True)
        created = store.create_bean(_bean("После ожидания"), "lock-wait-0001")
        assert created.name == "После ожидания"
    finally:
        _finish_lock_holder(holder)

    assert len(store.read_document().beans) == 1


def test_cross_process_contention_fails_with_bounded_stable_error(tmp_path, monkeypatch):
    monkeypatch.setattr(coffee_diary, "_LOCK_TIMEOUT_SECONDS", 0.25)
    path = tmp_path / "coffee.json"
    marker = tmp_path / "holder.ready"
    holder = _start_lock_holder(path, marker, 0.8)
    try:
        _wait_for_lock_holder(marker, holder)
        store = CoffeeDiaryStore(path, writes_enabled=True)
        started = time.monotonic()
        with pytest.raises(CoffeeDiaryStoreUnavailable) as error:
            store.create_bean(_bean("Не дождалось"), "lock-timeout-0001")
        elapsed = time.monotonic() - started
        assert error.value.code == "coffee_diary_store_lock_busy"
        assert elapsed < 4.0
    finally:
        _finish_lock_holder(holder)

    assert not path.exists()
