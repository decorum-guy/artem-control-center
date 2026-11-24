import asyncio
import json

import pytest
from fastapi import HTTPException

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.music_library import MusicLibrary, PlaySelection
from panel_agent.music_library_types import Continuation, Playlist, ProviderPage, Recording
from panel_agent import youtube_browser_connect
from panel_agent.youtube_library_credentials import browser_headers, capture_headers
from panel_agent.youtube_library import BrowserChannelMismatch, YouTubeLibrary
from panel_agent.youtube_music import MusicAuthRequired, MusicUnavailable

TRACK = Recording("12345", "Studio song", ("Artist",), "Record", 180)


class Source:
    def __init__(self):
        self.epoch = (1,)
        self.sent = []
        self.held = None
        self.entered = asyncio.Event()
        self.search_results = [TRACK]

    def version(self):
        return self.epoch

    def reset(self):
        pass

    async def catalog(self, continuation):
        return ProviderPage((Playlist("likes", "Likes", "liked"),))

    async def tracks(self, source, continuation):
        self.sent.append((source, continuation))
        if self.held:
            self.entered.set()
            await self.held.wait()
        return ProviderPage((TRACK,), Continuation("upstream-private", "tracks") if not continuation else None)

    async def lookup(self, identity):
        return TRACK if identity == TRACK.track_id else None

    async def search(self, _):
        return self.search_results


class Station:
    def __init__(self):
        self.sent = []

    async def play_track(self, track_id, may_send):
        if not may_send():
            return "blocked"
        self.sent.append(track_id)
        return "playing"


def setup(tmp_path):
    source = Source()
    station = Station()
    access = AccessPolicyStore(tmp_path / "access.json")
    access.set_profile("standard")
    library = MusicLibrary(station, source, Source(), access=lambda: access, writes=lambda: True,
                           paired_track=lambda _: None)
    return library, source, station


def test_real_continuation_is_private_and_repeated_positions_survive(tmp_path):
    async def run():
        library, source, station = setup(tmp_path)
        await library.page("yandex", "", None)
        assert source.sent == []
        first = await library.page("yandex", "likes", None)
        cached = await library.page("yandex", "likes", None)
        second = await library.page("yandex", "likes", first["next"])
        assert first is cached and len(source.sent) == 2
        assert first["next"] != "upstream-private" and second["next"] is None
        assert first["items"][0]["trackId"] == second["items"][0]["trackId"]
        assert first["items"][0]["key"] != second["items"][0]["key"]
        result = await library.play("yandex", PlaySelection(generation=first["generation"], source="likes",
                                                           row=second["items"][0]["key"]))
        assert result == {"status": "playing", "stationTrackId": "12345"}
        assert station.sent == ["12345"]

    asyncio.run(run())


def test_old_account_cannot_publish_or_dispatch(tmp_path):
    async def run():
        library, source, station = setup(tmp_path)
        old = await library.page("yandex", "", None)
        source.held = asyncio.Event()
        waiting = asyncio.create_task(library.page("yandex", "likes", None))
        await source.entered.wait()
        source.epoch = (2,)
        assert library.status("yandex")["generation"] != old["generation"]
        source.held.set()
        with pytest.raises(HTTPException) as changed:
            await waiting
        assert changed.value.detail == "account_changed"
        with pytest.raises(HTTPException):
            await library.play("yandex", PlaySelection(generation=old["generation"], source="likes", row="a" * 32))
        assert not station.sent

    asyncio.run(run())


class BrowserSource(Source, YouTubeLibrary):
    def __init__(self):
        super().__init__()
        self.channel = "channelA"
        self.failure = None

    def account_identity(self):
        return self.channel

    async def catalog(self, _):
        if self.failure:
            raise self.failure
        return ProviderPage((Playlist("likes", "Likes", "liked"),))


def test_same_channel_rotation_preserves_cursors_and_rekeys_rows(tmp_path):
    async def run():
        library, _, station = setup(tmp_path)
        source = BrowserSource()
        feed = library.feeds["youtube"]
        feed.provider = source
        await library.page("youtube", "", None)
        first = await library.page("youtube", "likes", None)
        second = await library.page("youtube", "likes", first["next"])
        before = library.status("youtube")
        source.held = asyncio.Event()
        waiting = asyncio.create_task(library.page("youtube", "likes", None, refresh=True))
        await source.entered.wait()
        source.epoch = (2,)
        after = library.status("youtube")
        assert after["generation"] == before["generation"]
        assert after["viewIdentity"] == before["viewIdentity"]
        assert after["sessionRevision"] == before["sessionRevision"] + 1
        source.held.set()
        with pytest.raises(HTTPException) as late:
            await waiting
        assert late.value.detail == "account_changed"
        await library.page("youtube", "", None, refresh=True)
        updated = await library.page("youtube", "likes", first["next"])
        assert updated["sessionRevision"] == after["sessionRevision"]
        assert updated["items"][0]["trackId"] == second["items"][0]["trackId"]
        assert updated["items"][0]["key"] != second["items"][0]["key"]
        with pytest.raises(HTTPException) as expired:
            await library.play("youtube", PlaySelection(generation=before["generation"], source="likes",
                                                        row=second["items"][0]["key"]))
        assert expired.value.detail == "row_expired"
        assert station.sent == []
        source.channel = "channelB"
        status = library.status("youtube")
        assert status["generation"] != before["generation"] and status["viewIdentity"] != before["viewIdentity"]
        assert not feed.sources and not feed.cursors and not feed.pages

    asyncio.run(run())


def test_only_explicit_sign_out_starts_recovery_and_keeps_last_catalog(tmp_path):
    async def run():
        library, _, _ = setup(tmp_path)
        source = BrowserSource()
        feed = library.feeds["youtube"]
        feed.provider = source
        recoveries = []
        library.browser = type("Browser", (), {
            "recover": lambda self: recoveries.append(True), "confirm_read": lambda self, version: None,
        })()
        old = await library.page("youtube", "", None)
        for error, status in ((MusicUnavailable(), 503), (BrowserChannelMismatch(), 401), (MusicAuthRequired(), 401)):
            source.failure = error
            with pytest.raises(HTTPException) as failed:
                await library.page("youtube", "", None, refresh=True)
            assert failed.value.status_code == status
            assert feed.pages["", None] == old
        assert recoveries == [True]

    asyncio.run(run())


def test_normal_provider_read_allows_the_next_independent_recovery(tmp_path, monkeypatch):
    async def run():
        library, _, _ = setup(tmp_path)
        source = BrowserSource()
        library.feeds["youtube"].provider = source
        source.path = tmp_path / "station-credentials" / "test.dpapi"
        source.path.parent.mkdir()
        source.credential_revision = source.version
        source.official_account = lambda: "test-channel"
        source.proxy = "http://127.0.0.1:10809"
        writes = []
        launches = []
        release = asyncio.Event()

        def write(path, candidate):
            assert path == source.path and candidate == b"verified"
            writes.append(candidate)
            source.epoch = (len(writes) + 1,)

        async def browse(profile, manual, approve, report):
            assert not manual
            launches.append(source.version())
            await release.wait()
            assert await approve(b"verified")

        monkeypatch.setattr(youtube_browser_connect, "write_protected", write)
        connector = youtube_browser_connect.MusicBrowserConnector(source, lambda: True, browser=browse)
        connector.profile.mkdir()
        connector._validate = lambda payload, account: None
        library.browser = connector

        async def signed_out():
            with pytest.raises(HTTPException) as failure:
                await library.page("youtube", "", None, refresh=True)
            assert failure.value.status_code == 401

        source.failure = MusicAuthRequired()
        await asyncio.gather(signed_out(), signed_out(), signed_out())
        assert launches == [(1,)]
        release.set()
        await connector.task
        assert source.version() == (2,) and len(writes) == 1
        await signed_out()
        assert launches == [(1,)]

        source.failure = None
        assert (await library.page("youtube", "", None, refresh=True))["items"]
        source.failure = MusicAuthRequired()
        await signed_out()
        await connector.task
        assert launches == [(1,), (2,)]
        assert source.version() == (3,) and len(writes) == 2
        await connector.close()

    asyncio.run(run())


def test_youtube_match_keeps_versions_for_explicit_selection(tmp_path):
    async def run():
        library, source, _ = setup(tmp_path)
        entry = Recording("ABCDEFGHIJK", TRACK.title, TRACK.artists, TRACK.album, TRACK.duration)
        result, choices = await library._find(entry)
        assert result == TRACK.track_id and not choices
        source.search_results = [TRACK, Recording("23456", "Studio song (Live)", ("Artist",), "Concert", 200)]
        result, choices = await library._find(entry)
        assert result is None and len(choices) == 2
        source.search_results = [Recording("34567", "Studio song", ("Different Artist",), "Record", 180)]
        assert await library._find(entry) == (None, [])

    asyncio.run(run())


def test_browser_capture_accepts_only_the_music_origin_and_required_headers():
    body = b'''fetch("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false", {
        "headers": {"authorization":"SAPISIDHASH 123_abc","cookie":"SAPISID=fixture; ignored=1","x-goog-authuser":"0",
        "content-length":"fake"}, "method":"POST"});'''
    parsed = capture_headers(body)
    assert b"content-length" not in parsed
    visitor = "fixture" * 84
    with_visitor = body.replace(b'"content-length":"fake"', b'"x-goog-visitor-id":' + json.dumps(visitor).encode())
    assert browser_headers(capture_headers(with_visitor))["x-goog-visitor-id"] == visitor
    request_body = json.dumps({"context": {"client": {"visitorData": "body-fixture"}}})
    body_visitor = body.replace(b'"method":"POST"', b'"body":' + json.dumps(request_body).encode())
    assert browser_headers(capture_headers(body_visitor))["x-goog-visitor-id"] == "body-fixture"
    with pytest.raises(ValueError):
        capture_headers(body.replace(b"music.youtube.com", b"www.youtube.com"))


class LargeSource(Source):
    async def catalog(self, continuation):
        return ProviderPage(tuple(Playlist(key, key, "playlist") for key in ("A", "B", "C", "D")))

    async def tracks(self, source, continuation):
        count = 2400 if source == "A" else 2200
        start = int(continuation.value) if continuation else 0
        end = min(start + 100, count)
        return ProviderPage(
            tuple(Recording(str(index + 1), f"Track {index}", ("Artist",)) for index in range(start, end)),
            Continuation(end, "tracks") if end < count else None,
        )


def test_playing_a_visible_row_survives_repeated_page_and_row_eviction(tmp_path, monkeypatch):
    monkeypatch.setattr("panel_agent.music_library.PAGE_CACHE", 22)
    async def run():
        library, _, station = setup(tmp_path)
        library.feeds["yandex"].provider = LargeSource()

        async def collect(source):
            page = first = await library.page("yandex", source, None)
            while page["next"]:
                page = await library.page("yandex", source, page["next"])
            return first

        await library.page("yandex", "", None)
        first = await collect("A")
        row = first["items"][0]["key"]
        selection = PlaySelection(generation=first["generation"], source="A", row=row)
        for other in ("B", "C", "D"):
            await collect(other)
            assert ("A", None) not in library.feeds["yandex"].pages
            again = await library.page("yandex", "A", None)
            assert (await library.play("yandex", selection))["stationTrackId"] == "1"
            assert (await library.play("yandex", selection.model_copy(update={"row": again["items"][0]["key"]})))["stationTrackId"] == "1"
        for denied in (selection.model_copy(update={"source": "B"}),
                       selection.model_copy(update={"row": row[:-1] + ("0" if row[-1] != "0" else "1")})):
            with pytest.raises(HTTPException, match="row_expired"):
                await library.play("yandex", denied)
        assert station.sent == ["1"] * 6

    asyncio.run(run())


def test_catalog_refresh_replaces_names_and_invalidates_old_continuations(tmp_path):
    async def run():
        library, source, _ = setup(tmp_path)
        source.catalog = original_catalog

        first = await library.page("yandex", "", None)
        assert first["next"]
        await library.page("yandex", "", first["next"])
        source.catalog = interrupted_catalog
        with pytest.raises(HTTPException, match="source_unavailable"):
            await library.page("yandex", "", None, refresh=True)
        assert (await library.page("yandex", "", None)) is first

        source.catalog = changed_catalog
        fresh = await library.page("yandex", "", None, refresh=True)
        assert [(row["key"], row["title"]) for row in fresh["items"]] == [
            ("A", "Renamed"), ("C", "Created"), ("D", "Second page"),
        ]
        assert fresh["next"] is None
        with pytest.raises(HTTPException, match="page_expired"):
            await library.page("yandex", "", first["next"])
        with pytest.raises(HTTPException, match="unknown_playlist"):
            await library.page("yandex", "B", None)

    async def original_catalog(continuation):
        return (ProviderPage((Playlist("B", "Removed", "playlist"),)) if continuation
                else ProviderPage((Playlist("A", "Original", "playlist"),), Continuation("old", "catalog")))

    async def interrupted_catalog(continuation):
        if continuation:
            raise MusicUnavailable
        return ProviderPage((Playlist("C", "Partial", "playlist"),), Continuation("new", "catalog"))

    async def changed_catalog(continuation):
        return (ProviderPage((Playlist("D", "Second page", "playlist"),)) if continuation
                else ProviderPage((Playlist("A", "Renamed", "playlist"), Playlist("C", "Created", "playlist")),
                                  Continuation("new", "catalog")))

    asyncio.run(run())


def test_disabled_music_reports_inactive_reads_without_enabling_actions():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from panel_agent.music_library import build_music_library_router
    from panel_agent.music_save import build_music_save_router

    app = FastAPI()
    app.include_router(build_music_library_router(None))
    app.include_router(build_music_save_router(None))
    with TestClient(app) as client:
        result = client.get("/api/v1/music/youtube/status")
        assert result.status_code == 200
        assert result.json()["status"] == "not_configured"
        assert not result.json()["canPlay"]
        assert client.post("/api/v1/music/youtube/play", json={}).status_code == 404
        connection = client.get("/api/v1/music/youtube/connection")
        assert connection.status_code == 200
        assert connection.json() is None
        assert connection.headers["Cache-Control"] == "no-store"
        assert client.post("/api/v1/music/youtube/connection/connect").status_code == 404

        result = client.get("/api/v1/station/music-save")
        assert result.status_code == 200
        assert result.json() is None
        assert result.headers["Cache-Control"] == "no-store"
        assert client.post("/api/v1/station/music-save/verify").status_code == 404
