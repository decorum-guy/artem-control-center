import asyncio
from datetime import datetime, timezone

import pytest

from panel_agent.hse_calendar import HseCalendar, event_order
from panel_agent.planning_adapter import PlanningAdapter, PlanningUpstreamError
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


def calendar(*events):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n" + "".join(events) + "END:VCALENDAR\r\n").encode()


def lesson(uid, timing):
    return ("BEGIN:VEVENT\r\nUID:" + uid + "\r\nDTSTAMP:20260810T090000Z\r\n"
            + timing + "\r\nSUMMARY:Учебное занятие\r\nEND:VEVENT\r\n")


TIMED = lesson("lesson-synthetic", "DTSTART:20260812T140000\r\nDURATION:PT90M")
ALL_DAY = lesson("day-synthetic", "DTSTART;VALUE=DATE:20260812")


def test_subscription_update_is_atomic_cache_bounded_and_read_only():
    replies = iter([calendar(TIMED, ALL_DAY), b"invalid", OSError("sensitive failure detail"), calendar()])
    reads = []
    time = [1]

    def download(key):
        reads.append(key)
        response = next(replies)
        if isinstance(response, Exception):
            raise response
        return response

    feed = HseCalendar("private-synthetic", download=download, clock=lambda: time[0])

    async def exercise():
        await asyncio.gather(feed.refresh(), feed.refresh())
        assert len(reads) == 1
        assert feed.status().status == "current"
        whole_day, timed = sorted(feed.events(), key=event_order)
        assert whole_day.endDateExclusive == "2026-08-13"
        assert timed.startAtUtc == "2026-08-12T11:00:00Z"
        assert timed.endAtUtc == "2026-08-12T12:30:00Z"
        assert all(not (e.canEdit or e.canDelete or e.localOnlyMutable) for e in feed.events())
        assert all(e.providerWriteState == "read_only" for e in feed.events())
        success = feed.last_success
        time[0] += 600
        await feed.refresh()
        assert feed.status().status == "stale"
        assert feed.status().errorCode == "subscription_data_invalid"
        assert feed.last_success == success
        assert feed.event(timed.id).syncState == "stale"
        await feed.refresh()
        assert len(reads) == 2
        time[0] += 60
        await feed.refresh()
        assert feed.status().errorCode == "subscription_read_failed"
        assert "sensitive" not in feed.status().model_dump_json()
        time[0] += 60
        await feed.refresh()
        assert feed.status().status == "current"
        assert feed.events() == []

    asyncio.run(exercise())


def test_unsupported_recurrence_never_claims_a_complete_feed():
    event = lesson("series", "DTSTART:20260812T120000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY")
    feed = HseCalendar("synthetic", download=lambda _: calendar(event))
    asyncio.run(feed.refresh())
    assert feed.status().status == "error"
    assert feed.last_success is None


def test_planning_merges_interleaved_pages_and_keeps_subscription_read_only(tmp_path):
    scenario = "b3-route-pagination"
    feed = HseCalendar("synthetic", download=lambda _: calendar(TIMED, ALL_DAY))
    adapter = PlanningAdapter(
        IntegrationSettings(
            panel_planning_enabled=True,
            panel_planning_base_url="http://fixture.test",
            panel_planning_internal_secret="synthetic-internal-secret",
            panel_planning_secret="synthetic-panel-agent-secret",
            panel_planning_cache_path=str(tmp_path / "planning.json"),
        ),
        transport=PlanningFixtureTransport(scenario), subscription=feed,
        wall_clock=lambda: datetime(2026, 8, 12, 9, tzinfo=timezone.utc),
    )

    async def exercise():
        date_range = dict(from_utc="2026-08-11T21:00:00Z", to_utc="2026-08-21T21:00:00Z")
        try:
            await adapter.start()
            whole = await adapter.read_events(**date_range, limit=100, offset=0)
            assert len(whole.items) == 32
            assert [e.id for e in whole.items] == [e.id for e in sorted(whole.items, key=event_order)]
            assert any(source.provider == "hse" for source in whole.sources)
            for offset in (0, 4, 12, 28, 32, 64):
                page = await adapter.read_events(**date_range, limit=4, offset=offset)
                assert page.items == whole.items[offset:offset + 4]
                assert page.hasMore == (offset + 4 < len(whole.items))
            event = feed.events()[0]
            detail = await adapter.read_event_by_id(event_id=event.id)
            assert detail.object == event
            assert any(source.provider == "hse" and source.status == "current" for source in adapter.read_status().providerStatuses)
            with pytest.raises(PlanningUpstreamError, match="provider_read_only"):
                await adapter.delete_event(event_id=event.id, expected_version=1, idempotency_key="synthetic")
        finally:
            await adapter.close()

    asyncio.run(exercise())
