import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

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
        clock = [datetime(2026, 11, 23, tzinfo=timezone.utc)]
        collector = StationPlaybackCollector(None, clock=lambda: clock[0])
        publisher = SnapshotPublisher(mode="read_only", services_builder=list,
                                      station_playback_builder=lambda: collector.state)
        collector.on_change = publisher.rebuild
        async with publisher.subscribe() as first, publisher.subscribe() as second:
            await collector.update("playing", "A track")
            assert first.get_nowait() == second.get_nowait() == 1
            first_frame = publisher.snapshot
            clock[0] += timedelta(seconds=2)
            await collector.update("playing", "A track")
            assert first.empty() and second.empty()
            assert publisher.snapshot.stationPlayback.observedAt == clock[0].isoformat()
            assert publisher.snapshot.generatedAt == first_frame.generatedAt
            assert (await publisher.rebuild()).revision == 1
            assert (await publisher.rebuild()).stationPlayback.observedAt == clock[0].isoformat()
            await collector.update("paused", "A track")
            assert first.get_nowait() == second.get_nowait() == 2
            clock[0] += timedelta(minutes=1)
            await collector.update("stale")
            assert first.get_nowait() == second.get_nowait() == 3
            assert publisher.snapshot.stationPlayback.title is None
            assert publisher.snapshot.stationPlayback.observedAt == (clock[0] - timedelta(minutes=1)).isoformat()
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


def test_collector_single_socket_reconnects_clears_stale_and_closes(track, monkeypatch):
    import panel_agent.station_playback as module

    monkeypatch.setattr(module, "STATE_TIMEOUT_SECONDS", 0.07)
    monkeypatch.setattr(module, "RECONNECT_SECONDS", 0.002)
    monkeypatch.setattr(module, "AUTH_RETRY_SECONDS", 5)
    cert = b"fixture station certificate"
    settings = StationPlaybackSettings("192.168.0.2", hashlib.sha256(cert).hexdigest(),
                                       "device", "x", "app", "secret")

    async def exercise():
        notifications = asyncio.Queue()
        transports = []
        active = set()
        acquired = []

        class Socket:
            def __init__(self):
                self.queue = asyncio.Queue()
                self.sent = []
                tls = SimpleNamespace(getpeercert=lambda *, binary_form: cert)
                self.transport = SimpleNamespace(get_extra_info=lambda name: tls)
                self.no_state = False

            async def recv(self):
                if self.no_state:
                    await asyncio.sleep(.005)
                    return '{"state":{"playing":true}}'
                value = await self.queue.get()
                if isinstance(value, Exception):
                    raise value
                return json.dumps(value)

            async def send(self, raw):
                self.sent.append(json.loads(raw))

        @asynccontextmanager
        async def connect(url, **options):
            socket = Socket()
            transports.append(socket)
            active.add(socket)
            assert len(active) == 1
            if len(transports) == 1:
                socket.queue.put_nowait({"state": {"playing": True, "playerState": track}})
            elif len(transports) == 2:
                socket.no_state = True
            elif len(transports) == 3:
                socket.queue.put_nowait({"state": {"playing": False, "playerState": None}})
            try:
                yield socket
            finally:
                active.remove(socket)

        async def acquire(_):
            acquired.append("device-token")
            return acquired[-1]

        monkeypatch.setattr(module, "connect", connect)
        monkeypatch.setattr(StationSessionTokens, "acquire", acquire)
        collector = StationPlaybackCollector(settings)
        publisher = SnapshotPublisher(mode="read_only", services_builder=list,
                                      station_playback_builder=lambda: collector.state)

        async def publish():
            await publisher.rebuild()
            notifications.put_nowait(collector.state.status)

        collector.on_change = publish
        async with publisher.subscribe() as tab_one, publisher.subscribe() as tab_two:
            collector.start()
            owned_task = collector.task
            collector.start()
            assert collector.task is owned_task
            try:
                async with asyncio.timeout(2):
                    assert await notifications.get() == "playing"
                    assert len(transports) == 1 and active == {transports[0]}
                    assert tab_one.get_nowait() == tab_two.get_nowait() == 1
                    assert transports[0].sent[0]["payload"] == {"command": "softwareVersion"}
                    transports[0].queue.put_nowait(OSError("fixture disconnect"))
                    assert await notifications.get() == "stale"
                    assert publisher.snapshot.stationPlayback.title is None
                    assert await notifications.get() == "idle"
                    assert len(transports) == 3 and active == {transports[2]}
                    assert len(acquired) == 3
                    transports[2].queue.put_nowait({"status": "unauthorized"})
                    assert await notifications.get() == "auth_required"
                    assert publisher.snapshot.stationPlayback.title is None
            finally:
                await collector.close()
            assert collector.task is None and owned_task.done()
            assert not active and len(transports) == 3

    asyncio.run(exercise())


def test_protected_credential_replaces_running_session(tmp_path, monkeypatch):
    import json

    from panel_agent import station_credentials, station_playback

    monkeypatch.setattr(station_playback, "CREDENTIAL_CHECK_SECONDS", 0.01)
    monkeypatch.setattr(station_credentials, "dpapi", lambda data, decrypt: data)
    path = tmp_path / "oauth.dpapi"
    starts: list[str] = []
    stopped: list[str] = []

    async def scenario():
        collector = station_playback.StationPlaybackCollector(station_playback.StationPlaybackSettings(
            "192.168.0.99", "1" * 64, "device", "", credential_path=path,
        ))

        async def fake_session(settings):
            starts.append(settings.x_token)
            try:
                await asyncio.Future()
            finally:
                stopped.append(settings.x_token)

        def write(token):
            staged = path.with_suffix(".pending")
            staged.write_text(json.dumps(dict(x_token=token, music_client_id="id", music_client_secret="test")))
            staged.replace(path)

        async def wait_for(predicate):
            async with asyncio.timeout(1):
                while not predicate():
                    await asyncio.sleep(0.005)

        monkeypatch.setattr(collector, "_run_session", fake_session)
        collector.start()
        try:
            await wait_for(lambda: collector.state is not None)
            assert collector.state.status == "auth_required"
            write("test1")
            await wait_for(lambda: starts == ["test1"])
            write("test2")
            await wait_for(lambda: starts == ["test1", "test2"])
            assert stopped == ["test1"]
            path.unlink()
            await wait_for(lambda: collector.state.status == "auth_required")
            assert stopped == ["test1", "test2"]
        finally:
            await collector.close()

    asyncio.run(scenario())


def test_station_reply_is_armed_before_send_and_keeps_all_cards():
    import json

    from panel_agent.station_playback import StationReplies

    async def scenario():
        cards = [{"item": 1}, {"item": 2}]

        class Socket:
            async def send(self, body):
                request = json.loads(body)
                assert request["payload"]["command"] == "sendText"
                replies.receive({"requestId": "different", "vinsResponse": {"response": {"wrong": True}}})
                replies.receive({"requestId": request["id"], "vinsResponse": {"response": {"is_streaming": True}}})
                replies.receive({"requestId": request["id"], "vinsResponse": {"payload": {
                    "response": {"cards": cards},
                }}})

        replies = StationReplies(Socket(), "test")
        assert await replies.reminder_list() == {"cards": cards}
        assert replies.pending is None

    asyncio.run(scenario())


def test_station_reply_clears_waiter_on_disconnect(monkeypatch):
    from panel_agent import station_playback

    async def scenario():
        sent = asyncio.Event()

        class Socket:
            async def send(self, _body):
                sent.set()

        replies = station_playback.StationReplies(Socket(), "test")
        requested = asyncio.create_task(replies.reminder_list())
        await sent.wait()
        replies.close()
        with pytest.raises(station_playback.StationReplyUnavailable):
            await requested
        assert replies.pending is None
        monkeypatch.setattr(station_playback, "REPLY_TIMEOUT_SECONDS", 0.01)
        with pytest.raises(station_playback.StationReplyUnavailable):
            await replies.reminder_list()
        assert replies.pending is None

    asyncio.run(scenario())


def test_music_vault_renews_glagol_lease_without_account_token():
    from dataclasses import replace

    from panel_agent.station_credentials import StationCredentials

    expires = datetime.now(timezone.utc) + timedelta(days=1)
    protected = StationCredentials.parse(json.dumps({
        "music_token": "fixture-music", "expires_at": expires.isoformat(),
    }).encode())
    settings = StationPlaybackSettings("192.168.0.2", "0" * 64, "fixture", "",
                                       stored_music_token=protected.music_token,
                                       music_expires_at=protected.expires_at)

    async def verify():
        attempts = []

        def respond(request):
            assert request.method == "GET"
            assert request.url.host == "quasar.yandex.net"
            assert request.headers.get("authorization") == "OAuth fixture-music"
            attempts.append(request)
            if len(attempts) == 3:
                return httpx.Response(403)
            return httpx.Response(200, json={"status": "ok", "token": "device-lease"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            tokens = StationSessionTokens(client, settings)
            assert await tokens.acquire() == "device-lease"
            assert await tokens.acquire() == "device-lease"
            with pytest.raises(StationAuthRequired):
                await tokens.acquire()
            expired = replace(settings, music_expires_at=expires - timedelta(days=2))
            with pytest.raises(StationAuthRequired):
                await StationSessionTokens(client, expired).acquire()
            assert len(attempts) == 3

    asyncio.run(verify())
    assert "fixture-music" not in repr(protected)
    with pytest.raises(ValueError):
        StationCredentials.parse(b'{"music_token":"x","expires_at":"2027-01-01"}')
