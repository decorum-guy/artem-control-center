"""On-demand account-scoped playlist pages and one managed Station play action."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore
from .music_library_types import Continuation, Playlist, ProviderPage, Recording
from .music_matching import Candidate, Track, match
from .station_playback import StationPlaybackCollector
from .yandex_library import YandexLibrary
from .youtube_library import YouTubeLibrary
from .youtube_music import MusicAuthRequired, MusicUnavailable, YOUTUBE_PROXY

Provider = Literal["yandex", "youtube"]
PLAY_CAPABILITY = "media.station.play_library"
ARTWORK_HOSTS = {
    "youtube": {"i.ytimg.com", "i9.ytimg.com", "lh3.googleusercontent.com", "lh3.ggpht.com",
                "yt3.ggpht.com", "yt3.googleusercontent.com"},
    "yandex": {"avatars.yandex.net", "avatars.mds.yandex.net"},
}
PAGE_CACHE = 112
CURSOR_CACHE = 220
CATALOG_LIMIT = 500
CATALOG_PAGES = 16
MAX_ROW_KEY = 18_000


def keep(mapping: OrderedDict, key, value, size: int) -> None:
    mapping[key] = value
    mapping.move_to_end(key)
    if len(mapping) > size:
        mapping.popitem(last=False)


class Feed:
    def __init__(self, provider: YandexLibrary | YouTubeLibrary | None):
        self.provider = provider
        self.version = None
        self.generation = uuid4().hex
        self.row_signing_key = secrets.token_bytes(32)
        self.status = "auth_required" if provider else "not_configured"
        self.lock = asyncio.Lock()
        self.waiters = 0
        self.pages: OrderedDict[tuple[str, str | None], dict] = OrderedDict()
        self.sources: OrderedDict[str, Playlist] = OrderedDict()
        self.cursors: OrderedDict[str, tuple[str, Continuation]] = OrderedDict()

    def invalidate(self, status: str) -> None:
        self.generation = uuid4().hex
        self.row_signing_key = secrets.token_bytes(32)
        self.status = status
        self.pages.clear()
        self.sources.clear()
        self.cursors.clear()
        if self.provider:
            self.provider.reset()

    def sync(self) -> str:
        version = self.provider.version() if self.provider else None
        if version != self.version:
            self.version = version
            self.invalidate("connecting" if version else "auth_required")
        return self.generation

    def row_key(self, source: str, row: Recording) -> str:
        # Each position stays distinct, including repeated tracks in a playlist.
        fields = (uuid4().hex, source, row.track_id, row.title, row.artists, row.album,
                  row.duration, row.playable, row.explicit)
        payload = base64.urlsafe_b64encode(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).rstrip(b"=")
        proof = hmac.new(self.row_signing_key, payload, "sha256").hexdigest()
        return f"{payload.decode()}.{proof}"

    def resolve_row(self, source: str, key: str) -> Recording:
        payload, _, proof = key.encode().partition(b".")
        expected = hmac.new(self.row_signing_key, payload, "sha256").hexdigest().encode()
        if not hmac.compare_digest(expected, proof) or source not in self.sources:
            raise HTTPException(409, "row_expired")
        _, issued_source, track, title, artists, album, duration, playable, explicit = json.loads(
            base64.urlsafe_b64decode(payload + b"=" * (-len(payload) % 4))
        )
        if issued_source != source:
            raise HTTPException(409, "row_expired")
        return Recording(track, title, tuple(artists), album, duration, playable=playable, explicit=explicit)

    def discard_pages(self, source: str) -> None:
        for key in tuple(self.pages):
            if key[0] == source:
                del self.pages[key]
        for key, entry in tuple(self.cursors.items()):
            if entry[0] == source:
                del self.cursors[key]


class Artwork:
    def __init__(self):
        self.links: OrderedDict[str, tuple[Provider, str, str]] = OrderedDict()
        self.files: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
        self.slots = asyncio.Semaphore(3)
        self.pending = 0

    def register(self, provider: Provider, generation: str, url: str | None) -> str | None:
        if url is None:
            return None
        try:
            address = urlsplit(url)
        except ValueError:
            return None
        if (address.scheme != "https" or address.netloc not in ARTWORK_HOSTS[provider]
                or address.fragment or len(url) > 1024):
            return None
        key = hashlib.sha256(f"{generation}:{url}".encode()).hexdigest()
        keep(self.links, key, (provider, generation, url), 3800)
        return f"/api/v1/music/artwork/{key}"

    async def get(self, key: str, feeds: dict[Provider, Feed]) -> Response:
        handle = self.links.get(key)
        if handle is None:
            raise HTTPException(404)
        provider, generation, url = handle
        if feeds[provider].sync() != generation:
            raise HTTPException(404)
        cached = self.files.get(key)
        if cached:
            self.files.move_to_end(key)
            body, content_type = cached
        else:
            if self.pending >= 15:
                raise HTTPException(503)
            self.pending += 1
            try:
                async with asyncio.timeout(7), self.slots, httpx.AsyncClient(
                    proxy=YOUTUBE_PROXY if provider == "youtube" else None,
                    timeout=5, trust_env=False, follow_redirects=False,
                ) as client:
                    async with client.stream("GET", url) as upstream:
                        content_type = upstream.headers.get("Content-Type", "").split(";")[0]
                        if upstream.status_code != 200 or content_type not in {"image/jpeg", "image/png", "image/webp"}:
                            raise HTTPException(404)
                        data = bytearray()
                        async for chunk in upstream.aiter_bytes():
                            if len(data) + len(chunk) > 370_000:
                                raise HTTPException(404)
                            data.extend(chunk)
                        body = bytes(data)
                if feeds[provider].sync() != generation:
                    raise HTTPException(404)
                keep(self.files, key, (body, content_type), 48)
            except (httpx.HTTPError, TimeoutError) as exc:
                raise HTTPException(503) from exc
            finally:
                self.pending -= 1
        return Response(body, media_type=content_type, headers={"Cache-Control": "private, max-age=120"})


class PlaySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    generation: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=148, pattern=r"^[a-zA-Z0-9_-]+$")
    row: str = Field(min_length=32, max_length=MAX_ROW_KEY, pattern=r"^[a-zA-Z0-9_.-]+$")
    choice: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


@dataclass
class Options:
    source_generation: str
    yandex_generation: str
    records: dict[str, str]
    expires: float


class MusicLibrary:
    def __init__(self, station: StationPlaybackCollector, yandex: YandexLibrary | None,
                 youtube: YouTubeLibrary | None, *, access: Callable[[], AccessPolicyStore],
                 writes: Callable[[], bool], paired_track: Callable[[str], str | None]):
        self.station, self.yandex = station, yandex
        self.feeds: dict[Provider, Feed] = {"yandex": Feed(yandex), "youtube": Feed(youtube)}
        self.access, self.writes = access, writes
        self.paired_track = paired_track
        self.art = Artwork()
        self.play_lock = asyncio.Lock()
        self.choices: OrderedDict[str, Options] = OrderedDict()
        self.matches: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self.liked_revision = 0

    def invalidate_youtube_likes(self) -> None:
        self.liked_revision += 1
        self.feeds["youtube"].pages.pop(("LM", None), None)

    def can_play(self) -> bool:
        return self.access().authorize(PLAY_CAPABILITY, gate_enabled=self.writes()).allowed

    def status(self, provider: Provider) -> dict:
        feed = self.feeds[provider]
        return {"generation": feed.sync(), "status": feed.status, "canPlay": self.can_play(),
                "likedRevision": self.liked_revision if provider == "youtube" else 0,
                "yandexGeneration": self.feeds["yandex"].sync()}

    async def page(self, provider: Provider, source: str, cursor: str | None, refresh: bool = False) -> dict:
        feed = self.feeds[provider]
        epoch = feed.sync()
        if feed.provider is None:
            raise HTTPException(404, "not_configured")
        if feed.version is None:
            raise HTTPException(401, "auth_required")
        if feed.waiters >= 7:
            raise HTTPException(429, "busy")
        feed.waiters += 1
        try:
            async with feed.lock:
                if feed.sync() != epoch:
                    raise HTTPException(409, "account_changed")
                if cursor and (cursor not in feed.cursors or feed.cursors[cursor][0] != source):
                    raise HTTPException(409, "page_expired")
                if source and source not in feed.sources:
                    raise HTTPException(404, "unknown_playlist")
                key = (source, cursor)
                cached = feed.pages.get(key)
                if cached and not refresh:
                    feed.pages.move_to_end(key)
                    return cached
                continuation = feed.cursors[cursor][1] if cursor else None
                try:
                    if source:
                        page = await feed.provider.tracks(source, continuation)
                    elif refresh:
                        page = await self._refresh_catalog(feed.provider)
                    else:
                        page = await feed.provider.catalog(continuation)
                except MusicAuthRequired as exc:
                    if feed.sync() == epoch and feed.status != "auth_required":
                        feed.invalidate("auth_required")
                    raise HTTPException(401, "auth_required") from exc
                except MusicUnavailable as exc:
                    feed.status = "unavailable"
                    raise HTTPException(503, "source_unavailable") from exc
                if feed.sync() != epoch:
                    raise HTTPException(409, "account_changed")
                limit = CATALOG_LIMIT if refresh and not source else 220
                if len(page.rows) > limit or (continuation is not None and page.continuation == continuation):
                    raise HTTPException(503, "invalid_page")
                if refresh:
                    feed.discard_pages(source)
                    if not source:
                        refreshed = {row.key for row in page.rows if isinstance(row, Playlist)}
                        for removed in feed.sources.keys() - refreshed:
                            feed.discard_pages(removed)
                        feed.sources.clear()
                items = [self._project(provider, feed, source, row) for row in page.rows]
                next_page = uuid4().hex if page.continuation else None
                if next_page:
                    keep(feed.cursors, next_page, (source, page.continuation), CURSOR_CACHE)
                result = {"items": items, "next": next_page, "generation": epoch,
                          "observedAt": datetime.now(timezone.utc).isoformat()}
                keep(feed.pages, key, result, PAGE_CACHE)
                feed.status = "ready"
                return result
        finally:
            feed.waiters -= 1

    @staticmethod
    async def _refresh_catalog(provider: YandexLibrary | YouTubeLibrary) -> ProviderPage:
        playlists: dict[str, Playlist] = {}
        continuation = None
        seen: set[Continuation] = set()
        try:
            async with asyncio.timeout(20):
                for _ in range(CATALOG_PAGES):
                    page = await provider.catalog(continuation)
                    for row in page.rows:
                        if isinstance(row, Playlist):
                            playlists[row.key] = row
                    if len(playlists) > CATALOG_LIMIT:
                        break
                    continuation = page.continuation
                    if continuation is None:
                        return ProviderPage(tuple(playlists.values()))
                    if continuation in seen:
                        break
                    seen.add(continuation)
        except TimeoutError as exc:
            raise MusicUnavailable from exc
        # Only a complete catalogue may replace known sources.
        raise MusicUnavailable

    def _project(self, provider: Provider, feed: Feed, source: str, row: Playlist | Recording) -> dict:
        artwork = self.art.register(provider, feed.generation, row.artwork)
        if isinstance(row, Playlist):
            keep(feed.sources, row.key, row, CATALOG_LIMIT)
            return {"key": row.key, "title": row.title, "kind": row.kind, "cover": artwork, "count": row.count}
        key = feed.row_key(source, row)
        if len(key) > MAX_ROW_KEY:
            return {**self._track_dict(row, uuid4().hex, artwork), "playable": False}
        return self._track_dict(row, key, artwork)

    @staticmethod
    def _track_dict(row: Recording, key: str, artwork: str | None = None) -> dict:
        return {"key": key, "trackId": row.track_id, "title": row.title, "artist": ", ".join(row.artists),
                "album": row.album, "duration": row.duration, "cover": artwork, "playable": row.playable}

    async def play(self, provider: Provider, request: PlaySelection) -> dict:
        if not self.can_play():
            raise HTTPException(403, "play_blocked")
        if self.play_lock.locked():
            return {"status": "busy"}
        feed = self.feeds[provider]
        if feed.sync() != request.generation:
            raise HTTPException(409, "account_changed")
        row = feed.resolve_row(request.source, request.row)
        if not row.track_id or not row.playable or self.yandex is None:
            return {"status": "unavailable"}
        ya_feed = self.feeds["yandex"]
        ya_epoch = ya_feed.sync()
        def permitted():
            return (self.can_play() and feed.sync() == request.generation and request.source in feed.sources
                    and ya_feed.sync() == ya_epoch)

        try:
            async with self.play_lock:
                match_key = (request.generation, ya_epoch, row.track_id)
                if provider == "yandex":
                    if request.choice:
                        raise HTTPException(422, "invalid_selection")
                    target = row.track_id
                elif request.choice:
                    options = self.choices.pop(request.row, None)
                    if (options is None or options.source_generation != request.generation
                            or options.yandex_generation != ya_epoch or options.expires < time.monotonic()
                            or request.choice not in options.records):
                        raise HTTPException(409, "choice_expired")
                    target = options.records[request.choice]
                else:
                    target = self.matches.get(match_key)
                    if target is None:
                        target, options = await self._find(row)
                        if not permitted():
                            return {"status": "blocked"}
                        if options:
                            public = [self._track_dict(record, uuid4().hex) for record in options]
                            keep(self.choices, request.row, Options(
                                request.generation, ya_epoch, {x["key"]: x["trackId"] for x in public},
                                time.monotonic() + 90,
                            ), 16)
                            return {"status": "choose", "options": public}
                    if target is None:
                        return {"status": "no_match"}
                outcome = await self.station.play_track(target, permitted)
                if provider == "youtube" and outcome in {"playing", "already_playing"} and permitted():
                    keep(self.matches, match_key, target, 128)
                self.access().audit_capability(PLAY_CAPABILITY, result=outcome)
                result = {"status": outcome, "stationTrackId": target if outcome in {"playing", "already_playing"} else None}
                if provider == "youtube":
                    result["yandexGeneration"] = ya_epoch
                return result
        except MusicAuthRequired:
            return {"status": "auth_required"}
        except MusicUnavailable:
            return {"status": "unavailable"}

    async def _find(self, row: Recording) -> tuple[str | None, list[Recording]]:
        assert self.yandex is not None and row.track_id is not None
        # The same provider lock owns Yandex metadata requests and its credentials.
        async with self.feeds["yandex"].lock:
            pair = self.paired_track(row.track_id)
            if pair:
                known = await self.yandex.lookup(pair)
                if known and known.playable:
                    return pair, []
            records = await self.yandex.search(row)
        usable = {item.track_id: item for item in records if item.track_id and item.playable
                  and (row.explicit is None or item.explicit is None or row.explicit == item.explicit)}
        if not usable:
            return None, []
        now = datetime.now(timezone.utc)
        source = Track(row.track_id, row.title, ", ".join(row.artists), row.duration, row.album, 0, now, now)
        candidate, choices = match(source, [Candidate(key, item.title, item.artists, item.album, item.duration)
                                            for key, item in usable.items()])
        return (candidate.video_id, []) if candidate else (None, [usable[item.video_id] for item in choices])


def build_music_library_router(library: MusicLibrary | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/music")

    @router.get("/{provider}/status")
    async def status(provider: Provider, response: Response):
        response.headers["Cache-Control"] = "no-store"
        if library is None:
            return {"generation": None, "status": "not_configured", "canPlay": False,
                    "likedRevision": 0, "yandexGeneration": None}
        return library.status(provider)

    if library is None:
        return router

    @router.get("/artwork/{key}")
    async def artwork(key: str):
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise HTTPException(404)
        return await library.art.get(key, library.feeds)

    @router.get("/{provider}/catalog")
    async def catalog(provider: Provider, response: Response, cursor: str | None = None,
                      refresh: bool = False):
        response.headers["Cache-Control"] = "no-store"
        return await library.page(provider, "", cursor, refresh and cursor is None)

    @router.get("/{provider}/tracks/{source}")
    async def tracks(provider: Provider, response: Response, source: str, cursor: str | None = None,
                     refresh: bool = False):
        response.headers["Cache-Control"] = "no-store"
        return await library.page(provider, source, cursor, refresh and cursor is None)

    @router.post("/{provider}/play")
    async def play(provider: Provider, request: Request, body: PlaySelection):
        try:
            origin = urlsplit(request.headers.get("origin", ""))
        except ValueError as exc:
            raise HTTPException(403, "local_panel_required") from exc
        if (request.headers.get("x-panel-intent") != "music-library"
                or request.headers.get("sec-fetch-site") == "cross-site"
                or origin.scheme not in {"http", "https"} or origin.hostname not in {"127.0.0.1", "localhost", "::1"}
                or origin.netloc != request.headers.get("host")):
            raise HTTPException(403, "local_panel_required")
        return await library.play(provider, body)

    return router
