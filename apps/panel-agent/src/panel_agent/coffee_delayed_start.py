"""Coffee-only durable delayed-start scheduler.

The scheduler owns one bounded JSON record and never accepts Home Assistant
identifiers, services, URLs, commands, or generic action names.  The caller
provides the already-verified Coffee turn-on implementation as a callback.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Literal, Mapping, Optional
from uuid import uuid4

MIN_DELAY_MINUTES = 1
MAX_DELAY_MINUTES = 120
MAX_FILE_BYTES = 16 * 1024
SCHEMA_VERSION = "coffee.delayed-start.v1"

ScheduleStatus = Literal["pending", "executing", "succeeded", "failed", "cancelled"]
TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


class CoffeeDelayedStartError(ValueError):
    """A safe, owner-facing failure from the fixed Coffee scheduler path."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class CoffeeDelayedStartStoreError(RuntimeError):
    pass


def validate_delay_minutes(value: Any) -> int:
    if type(value) is not int or not MIN_DELAY_MINUTES <= value <= MAX_DELAY_MINUTES:
        raise CoffeeDelayedStartError("coffee_delayed_start_delay_invalid")
    return value


def _parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _valid_request_id(value: Any) -> bool:
    return isinstance(value, str) and 8 <= len(value) <= 128 and all(
        character.isalnum() or character in "._:-" for character in value
    )


def _safe_record(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        return None
    if not _valid_request_id(raw.get("requestId")):
        return None
    schedule_id = raw.get("scheduleId")
    if not isinstance(schedule_id, str) or len(schedule_id) > 80:
        return None
    status = raw.get("status")
    if status not in {"pending", "executing", "succeeded", "failed", "cancelled"}:
        return None
    delay = raw.get("delayMinutes")
    if type(delay) is not int or not MIN_DELAY_MINUTES <= delay <= MAX_DELAY_MINUTES:
        return None
    due_at = _parse_datetime(raw.get("dueAt"))
    created_at = _parse_datetime(raw.get("createdAt"))
    updated_at = _parse_datetime(raw.get("updatedAt"))
    if not due_at or not created_at or not updated_at:
        return None
    failure_code = raw.get("failureCode")
    if failure_code is not None and (
        not isinstance(failure_code, str) or len(failure_code) > 120
    ):
        return None
    return {
        "schemaVersion": SCHEMA_VERSION,
        "scheduleId": schedule_id,
        "requestId": raw["requestId"],
        "delayMinutes": delay,
        "status": status,
        "dueAt": _iso(due_at),
        "createdAt": _iso(created_at),
        "updatedAt": _iso(updated_at),
        "failureCode": failure_code,
    }


class CoffeeDelayedStartStore:
    """Atomic single-record storage with bounded recovery semantics."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path or ".cache/coffee-delayed-start.json")

    def read(self) -> Optional[Dict[str, Any]]:
        if not self.path.exists():
            return None
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                return None
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        return _safe_record(raw)

    def write(self, record: Mapping[str, Any]) -> Dict[str, Any]:
        safe = _safe_record(dict(record))
        if safe is None:
            raise CoffeeDelayedStartStoreError("coffee_delayed_start_record_invalid")
        encoded = json.dumps(safe, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise CoffeeDelayedStartStoreError("coffee_delayed_start_record_oversized")
        parent = self.path.parent
        temporary_path: Optional[Path] = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=parent,
                delete=False,
            ) as handle:
                temporary_path = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
            temporary_path = None
        except OSError as exc:
            raise CoffeeDelayedStartStoreError("coffee_delayed_start_store_unavailable") from exc
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except OSError:
                    pass
        return safe


class CoffeeDelayedStartScheduler:
    """One Coffee schedule, serialized mutations, and durable due claims."""

    def __init__(
        self,
        path: str | Path,
        *,
        can_schedule: Callable[[], bool],
        execute_turn_on: Callable[[str], Awaitable[None]],
        machine_state: Callable[[], str | None],
        clock: Callable[[], datetime] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self.store = CoffeeDelayedStartStore(path)
        self._can_schedule = can_schedule
        self._execute_turn_on = execute_turn_on
        self._machine_state = machine_state
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._sleep = sleep or asyncio.sleep
        # Python 3.9 binds asyncio synchronization primitives to an event
        # loop when they are created.  The Panel Agent constructs this object
        # during module import, before its lifespan loop exists, so create the
        # lock on first async use instead.
        self._lock: asyncio.Lock | None = None
        self._wake: asyncio.Event | None = None
        self._task: asyncio.Task[None] | None = None

    def _current_lock(self) -> asyncio.Lock:
        running_loop = asyncio.get_running_loop()
        lock = self._lock
        if lock is None or getattr(lock, "_loop", None) not in (None, running_loop):
            lock = asyncio.Lock()
            self._lock = lock
        return lock

    def _current_wake(self) -> asyncio.Event:
        running_loop = asyncio.get_running_loop()
        wake = self._wake
        if wake is None or getattr(wake, "_loop", None) not in (None, running_loop):
            wake = asyncio.Event()
            self._wake = wake
        return wake

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def read(self) -> Optional[Dict[str, Any]]:
        return deepcopy(self.store.read())

    async def start(self) -> None:
        async with self._current_lock():
            await self._recover_locked()
            if self.running:
                return
            self._task = asyncio.create_task(self._run(), name="coffee-delayed-start")
        self._current_wake().set()

    async def close(self) -> None:
        task = self._task
        if task is None or task.get_loop() is not asyncio.get_running_loop():
            # Fixture TestClients can open the same imported app from several
            # event loops.  Only the lifespan that owns the worker may cancel
            # it; awaiting a task from another loop would deadlock shutdown.
            return
        self._task = None
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def create_or_replace(self, delay_minutes: Any, request_id: str) -> Dict[str, Any]:
        delay = validate_delay_minutes(delay_minutes)
        if not _valid_request_id(request_id):
            raise CoffeeDelayedStartError("coffee_delayed_start_request_id_invalid")
        async with self._current_lock():
            await self._reconcile_locked()
            current = self.store.read()
            if current and current["requestId"] == request_id:
                return deepcopy(current)
            if current and current["status"] == "executing":
                raise CoffeeDelayedStartError("coffee_delayed_start_execution_in_progress")
            if not self._can_schedule() or self._machine_state() != "off":
                raise CoffeeDelayedStartError("coffee_delayed_start_unavailable")
            now = self._clock()
            record = {
                "schemaVersion": SCHEMA_VERSION,
                "scheduleId": str(uuid4()),
                "requestId": request_id,
                "delayMinutes": delay,
                "status": "pending",
                "dueAt": _iso(now + timedelta(minutes=delay)),
                "createdAt": _iso(now),
                "updatedAt": _iso(now),
                "failureCode": None,
            }
            saved = self.store.write(record)
        self._current_wake().set()
        return deepcopy(saved)

    async def cancel(self) -> Optional[Dict[str, Any]]:
        async with self._current_lock():
            await self._reconcile_locked()
            current = self.store.read()
            if not current or current["status"] in TERMINAL_STATUSES:
                return deepcopy(current)
            if current["status"] == "executing":
                return deepcopy(current)
            now = self._clock()
            current["status"] = "cancelled"
            current["failureCode"] = "cancelled_by_owner"
            current["updatedAt"] = _iso(now)
            saved = self.store.write(current)
        self._current_wake().set()
        return deepcopy(saved)

    async def reconcile(self) -> Optional[Dict[str, Any]]:
        async with self._current_lock():
            changed = await self._reconcile_locked()
            result = self.store.read()
        if changed:
            self._current_wake().set()
        return deepcopy(result)

    async def _recover_locked(self) -> None:
        current = self.store.read()
        if current and current["status"] == "executing":
            # The durable claim is the at-most-once boundary.  A restart must
            # not issue a second physical turn-on when the old process may
            # have reached Home Assistant just before it stopped.
            now = self._clock()
            current["status"] = "failed"
            current["failureCode"] = "coffee_delayed_start_execution_uncertain"
            current["updatedAt"] = _iso(now)
            self.store.write(current)
        await self._reconcile_locked()

    async def _reconcile_locked(self) -> bool:
        current = self.store.read()
        if not current or current["status"] != "pending":
            return False
        if self._machine_state() != "on":
            return False
        now = self._clock()
        current["status"] = "cancelled"
        current["failureCode"] = "coffee_machine_turned_on_manually"
        current["updatedAt"] = _iso(now)
        self.store.write(current)
        return True

    async def _run(self) -> None:
        while True:
            try:
                async with self._current_lock():
                    await self._reconcile_locked()
                    current = self.store.read()
                    if not current or current["status"] != "pending":
                        wait_seconds = None
                    else:
                        due_at = _parse_datetime(current["dueAt"])
                        wait_seconds = max(0.0, (due_at - self._clock()).total_seconds()) if due_at else 0.0
                if wait_seconds is None:
                    wake = self._current_wake()
                    wake.clear()
                    await wake.wait()
                    continue
                if wait_seconds > 0:
                    wake = self._current_wake()
                    wake.clear()
                    try:
                        await asyncio.wait_for(wake.wait(), timeout=min(wait_seconds, 30.0))
                    except asyncio.TimeoutError:
                        pass
                    continue
                claimed = await self._claim_due()
                if claimed is None:
                    continue
                schedule_id, request_id = claimed
                try:
                    await self._execute_turn_on(request_id)
                except Exception as exc:  # The record must expose a truthful terminal result.
                    code = getattr(exc, "code", None) or str(exc) or "coffee_delayed_start_execution_failed"
                    await self._finish(schedule_id, "failed", str(code)[:120])
                else:
                    await self._finish(schedule_id, "succeeded", None)
            except asyncio.CancelledError:
                raise
            except Exception:
                await self._sleep(1.0)

    async def _claim_due(self) -> tuple[str, str] | None:
        async with self._current_lock():
            current = self.store.read()
            if not current or current["status"] != "pending":
                return None
            due_at = _parse_datetime(current["dueAt"])
            if not due_at or due_at > self._clock():
                return None
            machine_state = self._machine_state()
            if machine_state == "on":
                now = self._clock()
                current["status"] = "cancelled"
                current["failureCode"] = "coffee_machine_turned_on_manually"
                current["updatedAt"] = _iso(now)
                self.store.write(current)
                return None
            if machine_state != "off" or not self._can_schedule():
                now = self._clock()
                current["status"] = "failed"
                current["failureCode"] = "coffee_delayed_start_unavailable_at_due_time"
                current["updatedAt"] = _iso(now)
                self.store.write(current)
                return None
            now = self._clock()
            current["status"] = "executing"
            current["updatedAt"] = _iso(now)
            self.store.write(current)
            return current["scheduleId"], current["requestId"]

    async def _finish(self, schedule_id: str, status: ScheduleStatus, failure_code: str | None) -> None:
        async with self._current_lock():
            current = self.store.read()
            if not current or current["scheduleId"] != schedule_id or current["status"] != "executing":
                return
            current["status"] = status
            current["failureCode"] = failure_code
            current["updatedAt"] = _iso(self._clock())
            self.store.write(current)
        self._current_wake().set()
