from __future__ import annotations

import asyncio

from panel_agent.contracts import ServiceSnapshot
from panel_agent.snapshot import SnapshotPublisher


def _service(summary: str = "Ready") -> ServiceSnapshot:
    return ServiceSnapshot(
        id="test-service",
        title="Test service",
        health="healthy",
        source="live",
        summary=summary,
        dataContract="service.health.v1",
        actions=[],
        data={},
    )


def test_revision_changes_only_for_meaningful_snapshot_changes():
    services = [_service()]
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=lambda: services,
    )

    async def exercise():
        first = await publisher.rebuild()
        identical = await publisher.rebuild()
        services[0] = _service("Changed")
        changed = await publisher.rebuild()
        assert first.revision == 1
        assert identical.revision == 1
        assert identical.generatedAt == first.generatedAt
        assert changed.revision == 2
        assert changed.generatedAt != first.generatedAt

    asyncio.run(exercise())


def test_subscriber_is_coalesced_non_blocking_and_removed():
    services = [_service()]
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=lambda: services,
    )

    async def exercise():
        await publisher.rebuild()
        async with publisher.subscribe() as queue:
            services[0] = _service("second")
            await publisher.rebuild()
            services[0] = _service("third")
            await publisher.rebuild()
            assert queue.qsize() == 1
            assert queue.get_nowait() == 3
            assert publisher.subscriber_count == 1
        assert publisher.subscriber_count == 0

    asyncio.run(exercise())


def test_sse_connected_snapshot_heartbeat_and_cleanup():
    services = [_service()]
    publisher = SnapshotPublisher(
        mode="read_only",
        services_builder=lambda: services,
        heartbeat_seconds=0.01,
    )

    async def connected_and_snapshot():
        await publisher.rebuild()
        stream = publisher.event_stream(lambda: _false())
        connected = await stream.__anext__()
        assert "event: connected" in connected
        assert '"revision":1' in connected
        assert "token" not in connected.lower()

        next_event = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0)
        services[0] = _service("changed")
        await publisher.rebuild()
        snapshot = await next_event
        assert "event: snapshot" in snapshot
        assert '"revision":2' in snapshot
        await stream.aclose()
        assert publisher.subscriber_count == 0

    async def heartbeat():
        await publisher.rebuild()
        stream = publisher.event_stream(lambda: _false())
        await stream.__anext__()
        event = await stream.__anext__()
        assert "event: heartbeat" in event
        await stream.aclose()

    asyncio.run(connected_and_snapshot())
    asyncio.run(heartbeat())


async def _false() -> bool:
    return False
