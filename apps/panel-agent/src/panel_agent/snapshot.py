from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Awaitable, Callable, Iterable

from .contracts import DashboardSnapshot, PanelMode, ServiceSnapshot
from .planning import PlanningProjection


class SnapshotPublisher:
    """Owns the latest normalized snapshot and coalesced revision notifications."""

    def __init__(
        self,
        *,
        mode: PanelMode,
        services_builder: Callable[[], Iterable[ServiceSnapshot]],
        planning_builder: Callable[[], PlanningProjection | None] | None = None,
        heartbeat_seconds: float = 20,
    ) -> None:
        self._mode = mode
        self._services_builder = services_builder
        self._planning_builder = planning_builder
        self._heartbeat_seconds = max(0.01, heartbeat_seconds)
        self._snapshot: DashboardSnapshot | None = None
        self._fingerprint: str | None = None
        self._revision = 0
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue[int]] = set()
        self._closed = False

    @property
    def revision(self) -> int:
        return self._revision

    @property
    def snapshot(self) -> DashboardSnapshot | None:
        return self._snapshot.model_copy(deep=True) if self._snapshot else None

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def heartbeat_seconds(self) -> float:
        return self._heartbeat_seconds

    async def rebuild(self) -> DashboardSnapshot:
        services = list(self._services_builder())
        planning = self._planning_builder() if self._planning_builder is not None else None
        fingerprint = _fingerprint(services, self._mode, planning)
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        async with self._lock:
            if self._snapshot is not None and fingerprint == self._fingerprint:
                return self._snapshot.model_copy(deep=True)
            self._revision += 1
            self._fingerprint = fingerprint
            previous_generated_at = (
                self._snapshot.generatedAt if self._snapshot is not None else None
            )
            self._snapshot = DashboardSnapshot(
                revision=self._revision,
                generatedAt=_next_generated_at(previous_generated_at),
                mode=self._mode,
                fixtureScenario=None,
                services=services,
                planning=planning,
            )
            revision = self._revision
            for queue in tuple(self._subscribers):
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                try:
                    queue.put_nowait(revision)
                except asyncio.QueueFull:
                    pass
            return self._snapshot.model_copy(deep=True)

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[int]]:
        queue: asyncio.Queue[int] = asyncio.Queue(maxsize=1)
        if self._closed:
            raise RuntimeError("Snapshot publisher is closed")
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def close(self) -> None:
        self._closed = True
        self._subscribers.clear()

    async def event_stream(
        self,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[str]:
        async with self.subscribe() as queue:
            current = self._revision
            generated_at = (
                self._snapshot.generatedAt if self._snapshot else _now()
            )
            yield sse_event(
                "connected",
                {"revision": current, "generatedAt": generated_at},
                event_id=current,
            )
            while not await is_disconnected():
                try:
                    next_revision = await asyncio.wait_for(
                        queue.get(),
                        timeout=self._heartbeat_seconds,
                    )
                    yield sse_event(
                        "snapshot",
                        {"revision": next_revision},
                        event_id=next_revision,
                    )
                except asyncio.TimeoutError:
                    yield sse_event(
                        "heartbeat",
                        {"revision": self._revision},
                    )


def sse_event(event: str, data: dict, *, event_id: int | None = None) -> str:
    lines = [f"event: {event}"]
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(
        "data: "
        + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    )
    return "\n".join(lines) + "\n\n"


def _fingerprint(
    services: list[ServiceSnapshot],
    mode: PanelMode,
    planning: PlanningProjection | None = None,
) -> str:
    payload = {
        "mode": mode,
        "services": [
            _without_technical_fields(
                service.model_dump(mode="json", exclude_none=False)
            )
            for service in services
        ],
        "planning": (
            _without_technical_fields(planning.model_dump(mode="json", exclude_none=False))
            if planning is not None
            else None
        ),
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


_TECHNICAL_FIELDS = {
    "generatedAt",
    "revision",
    "observedAt",
    "fetchedAt",
    "freshnessLabel",
    "latencyMs",
    "detailsObservedAt",
    "lastSuccessfulObservedAt",
    "timingPolicyFetchedAt",
    "lastSuccessfulRestAt",
    "lastTransportConnectedAt",
    "lastTransportFailureAt",
    "lastSyncedAt",
    "staleAfter",
    "providerLastSyncAt",
    "healthObservedAt",
}


def _without_technical_fields(value):
    if isinstance(value, dict):
        return {
            key: _without_technical_fields(item)
            for key, item in value.items()
            if key not in _TECHNICAL_FIELDS
        }
    if isinstance(value, list):
        return [_without_technical_fields(item) for item in value]
    return value


def _next_generated_at(previous: str | None) -> str:
    current = datetime.now(timezone.utc)
    if previous is not None:
        previous_datetime = datetime.fromisoformat(previous)
        if current <= previous_datetime:
            current = previous_datetime + timedelta(microseconds=1)
    return current.isoformat()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
