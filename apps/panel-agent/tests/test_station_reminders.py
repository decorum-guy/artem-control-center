import asyncio
import json
from datetime import datetime
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent import station_reminders as reminders


def note(time="160000", *, identity="test-reminder", schedule=None, offset="0"):
    return {
        "title": "Синтетическое напоминание",
        "note_id": "provider-note-id",
        "deadline": f"2026-11-26T{time[:2]}:{time[2:4]}:00",
        "schedule": schedule or f"DTSTART;TZID=Europe/Moscow:20261126T{time}",
        "reminders": [{
            "reminder_id": identity, "offset_seconds": offset, "origin_device_id": "private-device-id"
        }],
    }


def payload(*notes):
    return {"notes": list(notes), "total_notes_count": len(notes)}


def test_normalization_keeps_identity_timezone_and_confirmed_recurrence():
    recurring = note(schedule="DTSTART;TZID=Europe/Moscow:20261126T160000\r\nRRULE:FREQ=WEEKLY")
    recurring["deadline"] = "2026-12-03T16:00:00"
    items, complete = reminders.normalize_reminder_list(payload({"reminders": []}, recurring))
    assert complete
    item, = items
    assert item.repeats
    assert item.timezone == "Europe/Moscow"
    assert datetime.fromisoformat(item.dueAt).isoformat() == "2026-12-03T16:00:00+03:00"
    assert item.id not in {"provider-note-id", "private-device-id", "test-reminder"}
    _, complete = reminders.normalize_reminder_list({
        **payload(recurring), "total_notes_count": 2, "continuation_token": "partial"
    })
    assert not complete


@pytest.mark.parametrize("bad_note", [
    {"title": "Unknown envelope"},
    note(schedule="DTSTART:20261126T160000"),
    note(offset="30"),
])
def test_an_incomplete_record_cannot_authorize_a_clear(bad_note):
    items, complete = reminders.normalize_reminder_list(payload(bad_note))
    assert not complete
    assert not items


def test_refresh_retains_previous_reading_and_detects_update_and_delete(tmp_path, monkeypatch):
    vault = tmp_path / "reminders.dpapi"
    vault.write_bytes(json.dumps({
        "client_uuid": "a" * 32, "cookies": {"Session_id": "test-cookie"}
    }).encode())
    monkeypatch.setattr(reminders, "dpapi", lambda data, *, decrypt: data)
    sequence = iter([
        (200, payload(note())),
        (200, {"notes": [], "total_notes_count": 1}),
        (502, {}),
        (200, payload(note(time="161500"))),
        (200, payload()),
        (401, {}),
    ])

    def origin(request):
        assert request.url == httpx.URL(reminders.NOTES_URL)
        assert request.method == "POST"
        assert request.headers["cookie"] == "Session_id=test-cookie"
        assert json.loads(request.content) == {"hide_completed": True}
        status, message = next(sequence)
        return httpx.Response(status, json=message)

    async def check():
        collector = reminders.StationRemindersCollector(vault)
        async with httpx.AsyncClient(transport=httpx.MockTransport(origin), trust_env=False) as session:
            await collector.refresh(session)
            original = collector.state
            assert original.status == "fresh" and original.items[0].dueAt.endswith("16:00:00+03:00")
            await collector.refresh(session)
            assert collector.state.status == "partial" and collector.state.items == original.items
            assert collector.state.observedAt == original.observedAt
            await collector.refresh(session)
            assert collector.state.status == "stale" and collector.state.items == original.items
            await collector.refresh(session)
            changed = collector.state.items[0]
            assert changed.id == original.items[0].id and changed.dueAt.endswith("16:15:00+03:00")
            await collector.refresh(session)
            assert collector.state.status == "fresh" and not collector.state.items
            await collector.refresh(session)
            assert collector.state.status == "auth_required" and not collector.state.items
        return collector

    collector = asyncio.run(check())
    app = FastAPI()
    app.include_router(reminders.build_station_reminders_router(collector))
    with TestClient(app) as client:
        result = client.get("/api/v1/station/reminders")
        assert result.headers["cache-control"] == "no-store"
        assert result.json()["status"] == "auth_required"
        assert "test-cookie" not in result.text


def test_collector_lifecycle_owns_one_task_and_stops(monkeypatch):
    async def check():
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def fake_run():
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        collector = reminders.StationRemindersCollector(Path("unused"))
        monkeypatch.setattr(collector, "_run", fake_run)
        collector.start()
        await started.wait()
        task = collector._task
        collector.start()
        assert task is collector._task
        await collector.close()
        assert collector._task is None and stopped.is_set()

    asyncio.run(check())


def test_rejects_cookie_injection_and_credential_fields():
    for cookies in ({"Session_id": "x; tracker=abc"}, {"Session_id": "x", "other": "y"}):
        with pytest.raises(ValueError):
            reminders.reminder_session(json.dumps({"client_uuid": "f" * 32, "cookies": cookies}).encode())
