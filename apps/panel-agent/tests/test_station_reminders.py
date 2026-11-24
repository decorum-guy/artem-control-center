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
    return {
        "notes": list(notes), "total_notes_count": str(len(notes)), "undated_notes": [],
        "run_out_of_forward_notes": True, "forward_continuation_token": "",
    }


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
        **payload(recurring), "total_notes_count": "2", "forward_continuation_token": "partial"
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


def test_writer_requires_local_intent_profile_and_new_version(tmp_path, monkeypatch):
    from panel_agent.access_policy import AccessPolicyStore

    store = AccessPolicyStore(tmp_path / "access.json")
    store.set_profile("read_only")
    collector = reminders.StationRemindersCollector(tmp_path / "unused")
    headers = {"Cookie": "Session_id=fixture"}
    monkeypatch.setattr(collector, "_current_session", lambda: reminders._ReminderSession(1, headers))
    collector.writer = reminders.StationRemindersWriter(
        collector, access=lambda: store, write_enabled=lambda: True
    )

    real_client = httpx.AsyncClient
    writes = []
    item = {
        **note(schedule="DTSTART;TZID=Europe/Moscow:20411201T160000"),
        "status": "INCOMPLETE",
    }

    def yandex(request):
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "get_calendar_notes":
            return httpx.Response(200, json=payload(item))
        assert name == "update_note"
        request_note = json.loads(request.content)["note"]
        writes.append(name)
        assert set(request_note) == {"note_id", "status", "schedule"}
        assert request_note["note_id"] == item["note_id"]
        item.update(schedule=request_note["schedule"])
        return httpx.Response(200, json={"note": {"note_id": request_note["note_id"]}})

    monkeypatch.setattr(reminders.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(yandex), **kwargs))
    app = FastAPI()
    app.include_router(reminders.build_station_reminders_router(collector))
    exposed = reminders.normalize_reminder_list(payload(item))[0][0]
    endpoint = "/api/v1/station/reminders/" + exposed.id
    intent = {"Origin": "http://localhost", "X-Panel-Intent": "station-reminders"}
    change = {"attemptId": "78f80cdf-942e-4c61-a713-1fbfc914dfad",
              "dueLocal": "2041-12-01T16:15", "expectedVersion": exposed.version}

    with TestClient(app, base_url="http://localhost") as client:
        assert client.patch(endpoint, json=change, headers=intent).status_code == 403
        store.set_profile("standard")
        assert client.patch(endpoint, json=change).status_code == 403
        assert client.patch(endpoint, json=change, headers={**intent, "Origin": "https://unrelated.test"}).status_code == 403
        assert client.patch(endpoint, json={**change, "expectedVersion": "c" * 64}, headers=intent).status_code == 409
        assert not writes
        changed = client.patch(endpoint, json=change, headers=intent)
        assert changed.status_code == 200
        projected, = changed.json()["items"]
        assert projected["dueAt"] == "2041-12-01T16:15:00+03:00"
        assert projected["version"] != exposed.version
        assert projected["id"] == exposed.id
        assert client.patch(endpoint, json=change, headers=intent).json()["detail"] == "already_submitted"
        assert writes == ["update_note"]


def test_uncertain_creation_never_repeats_the_provider_post(tmp_path, monkeypatch):
    from panel_agent.access_policy import AccessPolicyStore

    store = AccessPolicyStore(tmp_path / "access.json")
    store.set_profile("standard")
    collector = reminders.StationRemindersCollector(tmp_path / "unused")
    monkeypatch.setattr(collector, "_current_session", lambda: reminders._ReminderSession(1, {"Cookie": "Session_id=fixture"}))
    collector.writer = reminders.StationRemindersWriter(
        collector, access=lambda: store, write_enabled=lambda: True, device_id="station-fixture"
    )
    real_client = httpx.AsyncClient
    writes = []

    def yandex(request):
        if request.url == httpx.URL(reminders.NOTES_URL):
            return httpx.Response(200, json=payload())
        writes.append(json.loads(request.content)["note"])
        raise httpx.ReadTimeout("provider result unknown", request=request)

    monkeypatch.setattr(reminders.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(yandex), **kwargs))
    app = FastAPI()
    app.include_router(reminders.build_station_reminders_router(collector))
    endpoint = "/api/v1/station/reminders"
    intent = {"Origin": "http://localhost", "X-Panel-Intent": "station-reminders"}
    change = {"attemptId": "78f80cdf-942e-4c61-a713-1fbfc914dfad",
              "dueLocal": "2041-12-01T16:15", "title": "Тестовая запись"}

    with TestClient(app, base_url="http://localhost") as client:
        assert client.post(endpoint, json=change, headers=intent).json()["detail"] == "unconfirmed"
        assert client.post(endpoint, json=change, headers=intent).json()["detail"] == "already_submitted"
    assert writes == [{"title": "Тестовая запись", "doable": True, "status": "INCOMPLETE",
                       "schedule": "DTSTART;TZID=Europe/Moscow:20411201T161500",
                       "reminders": [{"offset_seconds": "0", "play_settings": {
                           "play_location": {"selected_devices": {"selected_device_ids": ["station-fixture"]}}
                       }}]}]


def test_recurrence_without_next_deadline_has_no_due_time():
    recurring = note(schedule="DTSTART;TZID=Europe/Moscow:20261126T160000\r\nRRULE:FREQ=WEEKLY")
    recurring.pop("deadline")
    (item,), complete = reminders.normalize_reminder_list(payload(recurring))
    assert complete and item.repeats and item.dueAt is None and item.version is None


def test_rotation_drops_in_flight_result_and_partial_cache(tmp_path, monkeypatch):
    vault = tmp_path / "reminders.dpapi"
    monkeypatch.setattr(reminders, "dpapi", lambda data, *, decrypt: data)

    def install(cookie):
        vault.write_text(json.dumps({"client_uuid": "a" * 32, "cookies": {"Session_id": cookie}}))

    async def check():
        entered, release = asyncio.Event(), asyncio.Event()
        install("previous")
        collector = reminders.StationRemindersCollector(vault)
        old = {**note(), "title": "Previous account"}
        new = {**note(), "title": "New account"}
        reads = 0

        async def provider(request):
            nonlocal reads
            reads += 1
            if reads == 2:
                entered.set()
                await release.wait()
            if request.headers["cookie"] == "Session_id=previous":
                return httpx.Response(200, json=payload(old))
            return httpx.Response(200, json={**payload(new), "total_notes_count": "2"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            await collector.refresh(client)
            assert collector.state.status == "fresh"
            waiting = asyncio.create_task(collector.refresh(client))
            await entered.wait()
            install("replacement")
            assert collector.projection().items == ()
            release.set()
            await waiting
            assert collector.projection().items == ()
            await collector.refresh(client)
            assert collector.state.status == "partial" and collector.state.observedAt is None
            assert [item.title for item in collector.state.items] == ["New account"]

    asyncio.run(check())


def test_calendar_notes_follows_both_directions_and_deduplicates():
    anchor = {**note(identity="center"), "note_id": "center"}
    upcoming = {**note(identity="next"), "note_id": "next"}
    previous = {**note(identity="prev"), "note_id": "prev"}
    requests = []

    def provider(request):
        body = json.loads(request.content)
        requests.append(body)
        if "forward_continuation_token" in body:
            page = {**payload(anchor, upcoming), "run_out_of_forward_notes": True}
        elif "backward_continuation_token" in body:
            page = {**payload(previous), "run_out_of_backward_notes": True}
        else:
            page = {**payload(anchor), "forward_continuation_token": "next-page", "run_out_of_forward_notes": False,
                    "backward_continuation_token": "prior-page", "run_out_of_backward_notes": False}
        return httpx.Response(200, json={**page, "total_notes_count": "3"})

    async def run():
        collector = reminders.StationRemindersCollector(Path("unused"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            merged = await collector._read(client, {"Cookie": "fixture"})
        items, complete = reminders.normalize_reminder_list(merged)
        assert complete and len(items) == 3

    asyncio.run(run())
    assert requests == [
        {"hide_completed": True},
        {"hide_completed": True, "forward_continuation_token": "next-page"},
        {"hide_completed": True, "backward_continuation_token": "prior-page"},
    ]


def test_repeated_calendar_cursor_marks_snapshot_partial():
    requests = []

    def provider(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={**payload(note()), "total_notes_count": "1",
                                        "forward_continuation_token": "repeated", "run_out_of_forward_notes": False})

    async def run():
        collector = reminders.StationRemindersCollector(Path("unused"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            merged = await collector._read(client, {"Cookie": "fixture"})
        items, complete = reminders.normalize_reminder_list(merged)
        assert len(items) == 1 and not complete

    asyncio.run(run())
    assert len(requests) == 2


def test_calendar_notes_budget_applies_across_pages():
    response_count = 0

    def provider(_request):
        nonlocal response_count
        response_count += 1
        return httpx.Response(200, json={
            **payload(note()), "forward_continuation_token": "more",
            "padding": "x" * (reminders.MAX_RESPONSE_BYTES // 2),
        })

    async def run():
        collector = reminders.StationRemindersCollector(Path("unused"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            with pytest.raises(ValueError, match="Oversized"):
                await collector._read(client, {"Cookie": "fixture"})

    asyncio.run(run())
    assert response_count == 2
