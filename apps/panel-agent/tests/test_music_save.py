from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.alice_voice_feedback import AliceVoiceFeedback
from panel_agent.music_matching import Candidate, Track, match
from panel_agent.music_save import MusicSave, SCENARIO, SCENARIOS, dispatch_scenario
from panel_agent.station_playback import StationPlaybackCollector
from panel_agent.youtube_music import MusicAuthRequired, MusicSession, MusicUnavailable


NOW = datetime(2026, 11, 24, 2, 0, tzinfo=timezone.utc)
CATALOG = Candidate("ABCDEFGHIJK", "Отпусти", ("Артист", "Гость"), "Один", 202)
LIVE = Candidate("ABCDEFGHIJL", "Отпусти (Live)", ("Артист", "Гость"), None, 215)


def test_matching_needs_extra_evidence_and_respects_version():
    source = Track("yandex:1", "Отпусти", "АРТИСТ feat. Гость", 203, None, 1, NOW, NOW)
    assert match(source, [CATALOG]) == (CATALOG, [])
    assert match(source, [CATALOG, LIVE]) == (None, [CATALOG, LIVE])
    no_length = Track("yandex:1", "Отпусти", "АРТИСТ, Гость", None, None, 1, NOW, NOW)
    assert match(no_length, [CATALOG]) == (None, [CATALOG])
    cover = Candidate("01234567890", "Отпусти", ("Другой",), "Один", 202)
    assert match(source, [cover]) == (None, [])
    assert match(source, [Candidate("xyz12345678", "Otpusti", ("Artist",), None, 202)]) == (None, [])


class FakeMusic:
    def __init__(self):
        self.version = b"first"
        self.auth = True
        self.rating_state = "none"
        self.rates = 0
        self.find = [CATALOG]
        self.in_music = True
        self.searches = []
        self.wait = None
        self.timeout_on_save = False

    async def sign_in(self):
        if not self.auth:
            raise MusicAuthRequired
        return MusicSession(self.version, "fixture", "fixture", "@example", 0)

    def is_current(self, session):
        return self.version == session.generation

    def require_current(self, session):
        if not self.is_current(session):
            raise MusicAuthRequired

    async def search(self, session, track):
        self.searches.append(track)
        if self.wait is not None:
            await self.wait.wait()
        return self.find

    async def verify_song(self, _session, _video):
        return True

    async def rating(self, _session, _candidate):
        return self.rating_state

    async def rate(self, _session, _candidate):
        self.rates += 1
        self.rating_state = "like"
        if self.timeout_on_save:
            raise MusicUnavailable

    async def liked(self, _session, _candidate):
        return self.in_music


def event(now, identity="event", scenario=SCENARIO):
    return {"event_type": "yandex_scenario", "origin": "LOCAL", "time_fired": now.isoformat(),
            "context": {"id": identity}, "data": {"scenario_name": scenario,
                "entity_id": "media_player.mini", "instance": "text_action", "value": "ничего не делай"}}


def setup(tmp_path):
    time = [NOW]
    access = AccessPolicyStore(tmp_path / "access.json")
    access.set_profile("standard")
    station = StationPlaybackCollector(None, clock=lambda: time[0])
    provider = FakeMusic()
    bridge = MusicSave(station, provider, target="media_player.mini",
                       access=lambda: access, writes=lambda: True, clock=lambda: time[0])
    return station, provider, bridge, time, access


@pytest.mark.parametrize("already_liked, timeout, in_music, expected", [
    (False, False, True, "in_music"),
    (True, False, True, "already_in_music"),
    (False, True, False, "youtube_like"),
])
def test_recovers_unknown_write_via_read_without_resending(tmp_path, already_liked, timeout, in_music, expected):
    async def run():
        station, provider, bridge, time, _ = setup(tmp_path)
        provider.rating_state = "like" if already_liked else "none"
        provider.timeout_on_save = timeout
        provider.in_music = in_music
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="1", duration=202)
        original = event(time[0])
        bridge.handle(original)
        bridge.handle(original)
        await bridge.task
        assert bridge.projection()["operation"]["status"] == expected
        assert provider.rates == (0 if already_liked else 1)
    asyncio.run(run())


def test_capture_precedes_wait_and_versions_and_source_are_distinct(tmp_path):
    async def run():
        station, provider, bridge, time, _ = setup(tmp_path)
        provider.wait = asyncio.Event()
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="first", duration=202)
        bridge.handle(event(time[0]))
        time[0] += timedelta(seconds=2)
        await station.update("playing", "Следующий", "Тот же", track_key="next", duration=240)
        provider.wait.set()
        await bridge.task
        assert provider.searches[0].source_id == "first"
        assert bridge.operation.title == CATALOG.title
        bridge.handle(event(time[0], "near-boundary"))
        await bridge.task
        assert bridge.operation.status == "choose_source"
        bridge.saved.clear()
        provider.find = [CATALOG, LIVE]
        bridge.choose(bridge.operation.id, "choose_source", "0")
        await bridge.task
        assert bridge.operation.status == "choose_version"
        assert bridge.operation.title == CATALOG.title
        bridge.choose(bridge.operation.id, "choose_version", LIVE.video_id)
        await bridge.task
        assert bridge.operation.status == "already_in_music"
        assert provider.rates == 1
    asyncio.run(run())


def test_paused_stale_and_unmatched_never_write(tmp_path):
    async def run():
        station, provider, bridge, time, _ = setup(tmp_path)
        await station.update("paused", CATALOG.title, CATALOG.artist, track_key="paused")
        bridge.handle(event(time[0], "paused"))
        assert bridge.operation.status == "no_track"
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="old", duration=202)
        time[0] += timedelta(minutes=5)
        bridge.handle(event(time[0], "stale"))
        assert bridge.operation.status == "no_track"
        await station.update("playing", "Другая", CATALOG.artist, track_key="fresh")
        bridge.handle(event(time[0], "unmatched"))
        await bridge.task
        assert bridge.operation.status == "no_match"
        assert provider.rates == 0
    asyncio.run(run())


def test_account_rotation_and_policy_change_cancel_pending_write(tmp_path):
    async def run():
        station, provider, bridge, time, access = setup(tmp_path)
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="track", duration=202)
        provider.wait = asyncio.Event()
        bridge.handle(event(time[0], "pending"))
        await asyncio.sleep(0)
        provider.version = b"second"
        provider.wait.set()
        await bridge.task
        assert bridge.operation.status == "auth_required" and provider.rates == 0
        provider.auth = False
        bridge.handle(event(time[0], "missing"))
        await bridge.task
        assert bridge.operation.status == "auth_required"
        provider.auth = True
        provider.wait = asyncio.Event()
        bridge.handle(event(time[0], "restored"))
        await asyncio.sleep(0)
        access.set_profile("read_only")
        provider.wait.set()
        await bridge.task
        assert bridge.operation.status == "blocked" and provider.rates == 0
        assert bridge.projection()["channel"] == "@example"
    asyncio.run(run())


@pytest.mark.parametrize("scenario", sorted(SCENARIOS))
def test_dispatch_keeps_tv_and_music_independent(tmp_path, scenario):
    station, provider, bridge, time, _ = setup(tmp_path)
    seen = []
    wrong_device = event(time[0], "music", scenario)
    wrong_device["data"]["entity_id"] = "media_player.other"
    dispatch_scenario(wrong_device, bridge, seen.append)
    echo = event(time[0], "voice-feedback", scenario)
    echo["data"]["instance"] = "tts"
    dispatch_scenario(echo, bridge, seen.append)
    assert bridge.operation is None and not seen
    dispatch_scenario(event(time[0], "music", scenario), bridge, seen.append)
    assert bridge.operation.status == "no_track" and not seen
    dispatch_scenario(event(time[0], "tv", "Панель ТВ · YouTube"), bridge, seen.append)
    assert len(seen) == 1
    dispatch_scenario(event(time[0], "music", SCENARIO), None, seen.append)
    assert len(seen) == 1

def test_voice_feedback_distinguishes_confirmed_like_from_music_membership(tmp_path):
    async def check():
        station, provider, bridge, time, _ = setup(tmp_path)
        sent = []

        async def speak(entity, phrase):
            sent.append((entity, phrase))

        feedback = bridge.feedback = AliceVoiceFeedback(speak)
        provider.in_music = False
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="one", duration=202)
        bridge.handle(event(time[0]))
        await bridge.task
        await feedback.task
        assert provider.rates == 1
        assert sent == [("media_player.mini", "Лайк подтверждён.")]
        await bridge.close()
        await feedback.close()

    asyncio.run(check())


def test_unconfirmed_speech_never_repeats_confirmed_like(tmp_path):
    async def check():
        station, provider, bridge, time, _ = setup(tmp_path)
        utterances = []

        async def speak(*_):
            raise AssertionError("Uncertain local speech cannot be retried through HA")

        async def local(phrase, allowed):
            assert allowed()
            utterances.append(phrase)
            return False

        feedback = bridge.feedback = AliceVoiceFeedback(speak, local_music_entity=bridge.target, speak_local=local)
        await station.update("playing", CATALOG.title, CATALOG.artist, track_key="one", duration=202)
        bridge.handle(event(time[0]))
        await bridge.task
        await feedback.task
        bridge.handle(event(time[0]))
        assert provider.rates == 1
        assert len(utterances) == 1
        assert bridge.operation.status == "in_music"
        await feedback.close()
        await bridge.close()

    asyncio.run(check())
