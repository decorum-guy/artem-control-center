import asyncio
from types import SimpleNamespace

import httpx
import pytest

from panel_agent.contracts import StationPlayback
from panel_agent.snapshot import SnapshotPublisher
from panel_agent.station_playback import (
    StationAuthRequired,
    StationPlaybackCollector,
    StationPlaybackSettings,
    normalize_cover,
    parse_state,
    StationSessionTokens,
)
from panel_agent.station_retention import StationRetentionRecorder


@pytest.fixture
def track():
    return {"type": "Track", "id": "fixture-1", "title": " A   track ", "subtitle": "Artist",
            "extra": {"coverURI": "avatars.yandex.net/get-music-content/example/%%"}}


def test_normalization_ignores_non_media_and_handles_idle_and_partial(track):
    assert parse_state({"state": {"playing": True, "playerState": track}}) == (
        "playing", "A track", "Artist", "https://avatars.yandex.net/get-music-content/example/200x200", "fixture-1"
    )
    assert parse_state({"state": {"playing": False, "playerState": track}})[0] == "paused"
    assert parse_state({"state": {"playing": False, "playerState": None}}) == ("idle", None, None, None, None)
    assert parse_state({"state": {"playing": False}}) is None
    assert parse_state({"state": {"playing": True, "playerState": {"type": "Track"}}}) is None
    assert parse_state({"state": {"playing": True, "playerState": None}}) is None
    assert parse_state({"state": {"playing": True, "playerState": {"type": "FmRadio"}}})[-1] == "other-media"
    track.pop("subtitle")
    assert parse_state({"state": {"playing": False, "playerState": track}})[2] is None


@pytest.mark.parametrize("url", [
    "https://example.com/get-music-content/abc",
    "https://avatars.yandex.net@127.0.0.1/get-music-content/abc",
    "https://avatars.yandex.net/other/abc",
    "http://avatars.yandex.net/get-music-content/abc",
    "https://[not-a-host",
])
def test_cover_rejects_untrusted_inputs(url):
    assert normalize_cover(url) is None


def test_one_snapshot_event_per_semantic_change_and_stale_clears_track():
    async def exercise():
        collector = StationPlaybackCollector(None)
        publisher = SnapshotPublisher(mode="read_only", services_builder=list,
                                      station_playback_builder=lambda: collector.state)
        collector.on_change = publisher.rebuild
        async with publisher.subscribe() as first, publisher.subscribe() as second:
            await collector.update("playing", "A track")
            assert first.get_nowait() == second.get_nowait() == 1
            await collector.update("playing", "A track")
            assert first.empty() and second.empty()
            await collector.update("paused", "A track")
            assert first.get_nowait() == second.get_nowait() == 2
            await collector.update("stale")
            assert first.get_nowait() == second.get_nowait() == 3
            assert publisher.snapshot.stationPlayback.title is None
    asyncio.run(exercise())


def test_token_refresh_reacquires_device_token_and_handles_expired_account():
    async def exercise():
        exchanges = 0
        connections = 0

        def handler(request):
            nonlocal exchanges, connections
            if request.url.host == "oauth.mobile.yandex.net":
                exchanges += 1
                assert request.method == "POST"
                assert b"grant_type=x-token" in request.content
                return httpx.Response(200, json={"access_token": f"music-fixture-{exchanges}"})
            assert request.url.host == "quasar.yandex.net"
            connections += 1
            assert request.headers["authorization"] == f"OAuth music-fixture-{exchanges}"
            if connections == 2:
                return httpx.Response(403)
            return httpx.Response(200, json={"status": "ok", "token": f"conversation-{connections}"})

        settings = StationPlaybackSettings("192.168.0.2", "0" * 64, "fixture", "fixture", "app", "app-secret")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            tokens = StationSessionTokens(client, settings)
            assert await tokens.acquire() == "conversation-1"
            assert await tokens.acquire() == "conversation-3"
        assert (exchanges, connections) == (2, 3)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(401))) as client:
            with pytest.raises(StationAuthRequired):
                await StationSessionTokens(client, settings).acquire()
    asyncio.run(exercise())


def test_retention_excludes_replacement_resume_disconnect_and_stores_no_track(tmp_path, monkeypatch):
    now = [100]
    monkeypatch.setattr("panel_agent.station_retention.time", SimpleNamespace(monotonic=lambda: now[0]))
    path = tmp_path / "retention.json"
    recorder = StationRetentionRecorder(path)
    for status, identity, outcome in (
        ("idle", None, "cleared"),
        ("paused", "synthetic replacement", "new_media"),
        ("playing", "private source", "resumed"),
        ("stale", None, "signal_lost"),
    ):
        recorder.observe("playing", "private source")
        recorder.observe("paused", "private source")
        assert recorder.snapshot().activeSince is not None
        now[0] += 20
        recorder.observe("paused", "private source")
        recorder.observe(status, identity)
        assert recorder.snapshot().samples[0].outcome == outcome
        assert recorder.snapshot().samples[0].seconds == 20
        assert recorder.snapshot().activeSince is None
    assert "private source" not in path.read_text(encoding="utf-8")
    assert len(StationRetentionRecorder(path).snapshot().samples) == 4
