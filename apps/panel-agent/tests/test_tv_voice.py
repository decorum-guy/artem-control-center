import asyncio
import json
from datetime import datetime, timedelta, timezone
from threading import Event

import pytest

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.tv_voice import SCENARIOS, TVVoiceBridge

NOW = datetime(2026, 11, 24, tzinfo=timezone.utc)
STATION = "media_player.fixture_station"


def event(action, identity, *, age=0):
    return {
        "event_type": "yandex_scenario", "origin": "LOCAL",
        "time_fired": (NOW - timedelta(seconds=age)).isoformat(), "context": {"id": identity},
        "data": {"entity_id": STATION, "instance": "text_action", "value": "ничего не делай",
                 "scenario_name": next(name for name, value in SCENARIOS.items() if value == action)},
    }


class Executor:
    def __init__(self, results):
        self.results = iter(results)
        self.calls = []

    def invoke(self, command=None):
        self.calls.append((command.action, command.app) if command else ("status", None))
        return next(self.results)


def bridge_for(tmp_path, executor, *, enabled=True, profile="standard"):
    path = tmp_path / "access.json"
    path.write_text(json.dumps({"schemaVersion": 1, "baseProfile": profile}), encoding="utf-8")
    store = AccessPolicyStore(path)
    bridge = TVVoiceBridge(station_entity=STATION, executor=executor, access=lambda: store,
                           write_enabled=lambda: enabled, clock=lambda: NOW)
    return bridge, store


@pytest.mark.parametrize(("screen", "wake", "expected", "calls"), [
    ("on", None, "app-open", ["status", "open-app"]),
    ("off", (200, {"outcome": "confirmed", "screen": "on"}), "app-open", ["status", "screen-on", "open-app"]),
    ("off", (502, {"outcome": "unconfirmed"}), "unconfirmed", ["status", "screen-on"]),
    ("off", (200, {"outcome": "confirmed", "screen": "off"}), "unconfirmed", ["status", "screen-on"]),
    ("unknown", None, "unconfirmed", ["status"]),
])
def test_youtube_checks_catalog_and_requires_screen_readback(tmp_path, screen, wake, expected, calls):
    responses = [(200, {"availability": "online", "screen": screen, "apps": [{"id": "youtube"}]})]
    if wake:
        responses.append(wake)
    if expected == "app-open":
        responses.append((200, {"outcome": "app-open", "playbackConfirmed": False}))
    executor = Executor(responses)
    bridge, _ = bridge_for(tmp_path, executor)
    assert bridge._execute("youtube") == expected
    assert executor.calls == [(action, "youtube" if action == "open-app" else None) for action in calls]


def test_offline_and_missing_catalog_do_not_issue_command(tmp_path):
    executor = Executor([(503, {"availability": "offline"}),
                         (200, {"availability": "online", "screen": "off", "apps": []})])
    bridge, _ = bridge_for(tmp_path, executor)
    assert bridge._execute("youtube") == "offline"
    assert bridge._execute("youtube") == "app-unavailable"
    assert executor.calls == [("status", None)] * 2


@pytest.mark.parametrize(("enabled", "profile"), [(False, "full"), (True, "read_only")])
def test_voice_requires_write_gate_and_access(tmp_path, enabled, profile):
    executor = Executor([])
    bridge, _ = bridge_for(tmp_path, executor, enabled=enabled, profile=profile)
    assert bridge._execute("screen-on") == "blocked"
    assert not executor.calls


def test_youtube_rechecks_profile_between_screen_and_app(tmp_path):
    class ChangingExecutor(Executor):
        def invoke(self, command=None):
            response = super().invoke(command)
            if command and command.action == "screen-on":
                store.set_profile("read_only")
            return response

    executor = ChangingExecutor([
        (200, {"availability": "online", "screen": "off", "apps": [{"id": "youtube"}]}),
        (200, {"outcome": "confirmed", "screen": "on"}),
    ])
    bridge, store = bridge_for(tmp_path, executor)
    assert bridge._execute("youtube") == "blocked"
    assert executor.calls == [("status", None), ("screen-on", None)]


def test_event_ingress_keeps_reader_free_and_drops_busy_duplicate_stale_and_tts(tmp_path):
    async def check():
        started, release = Event(), Event()

        class SlowExecutor(Executor):
            def invoke(self, command=None):
                started.set()
                assert release.wait(3)
                return super().invoke(command)

        executor = SlowExecutor([(503, {"outcome": "unconfirmed"})])
        bridge, _ = bridge_for(tmp_path, executor)
        first = event("screen-on", "one")
        pending = event("screen-off", "two")
        tts = event("screen-off", "three")
        tts["data"]["instance"] = "tts"
        wrong_station = event("screen-off", "four")
        wrong_station["data"]["entity_id"] = "media_player.other_station"
        bridge.handle(tts)
        bridge.handle(wrong_station)
        bridge.handle(event("screen-on", "old", age=60))
        assert bridge.task is None
        bridge.handle(first)
        try:
            assert await asyncio.to_thread(started.wait, 2)
            bridge.handle(pending)
            assert not bridge.task.done()
        finally:
            release.set()
        await bridge.task
        bridge.handle(first)
        bridge.handle(pending)
        bridge.handle(event("screen-on", "same-action-new-id"))
        assert executor.calls == [("screen-on", None)]
        await bridge.close()
        bridge.handle(event("screen-off", "after-close"))
        assert bridge.task is None

    asyncio.run(check())


def test_youtube_scenario_aliases_share_deduplication(tmp_path):
    async def check():
        executor = Executor([
            (200, {"availability": "online", "screen": "on", "apps": [{"id": "youtube"}]}),
            (200, {"outcome": "app-open"}),
        ])
        bridge, _ = bridge_for(tmp_path, executor)
        unknown = event("youtube", "unknown")
        unknown["data"]["scenario_name"] = "Панель ТВ · YouTube другое"
        bridge.handle(unknown)
        assert bridge.task is None

        short = event("youtube", "short")
        short["data"]["scenario_name"] = "Панель ТВ · YouTube коротко"
        bridge.handle(short)
        task = bridge.task
        assert task is not None
        await task

        bridge.handle(event("youtube", "canonical"))
        assert bridge.task is task
        assert executor.calls == [("status", None), ("open-app", "youtube")]
        await bridge.close()

    asyncio.run(check())
