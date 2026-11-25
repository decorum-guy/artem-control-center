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
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass, field
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
from .yandex_library import PLAYLIST_ID, PlaylistIndex, YandexLibrary, YandexPageExpired
from .youtube_browser_connect import MusicBrowserConnector
from .youtube_library import BrowserChannelMismatch, YouTubeLibrary
from .youtube_music import MusicAuthRequired, MusicProxyUnavailable, MusicUnavailable, YOUTUBE_PROXY

Provider = Literal["yandex", "youtube"]
PLAY_CAPABILITY = "media.station.play_library"
LIKE_CAPABILITY = "media.alice.like"
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
SEARCH_PAGES_PER_CYCLE = 10
SEARCH_SECONDS_PER_CYCLE = 20
SEARCH_ROWS = 500
SEARCH_TTL_SECONDS = 900


def keep(mapping: OrderedDict, key, value, size: int) -> None:
    mapping[key] = value
    mapping.move_to_end(key)
    if len(mapping) > size:
        mapping.popitem(last=False)


class Feed:
    def __init__(self, provider: YandexLibrary | YouTubeLibrary | None):
        self.provider = provider
        self.version = None
        self.account = None
        self.generation = uuid4().hex
        self.session_revision = 0
        self.needs_session_probe = False
        self.row_signing_key = secrets.token_bytes(32)
        self.status = "auth_required" if provider else "not_configured"
        self.catalog_failed = False
        self.last_read = 0.0
        self.connection_issue: str | None = None
        self.lock = asyncio.Lock()
        self.waiters = 0
        self.pages: OrderedDict[tuple[str, str | None], dict] = OrderedDict()
        self.sources: OrderedDict[str, Playlist] = OrderedDict()
        self.cursors: OrderedDict[str, tuple[str, Continuation]] = OrderedDict()

    def invalidate(self, status: str) -> None:
        self.generation = uuid4().hex
        self.session_revision = 0
        self.needs_session_probe = False
        self.row_signing_key = secrets.token_bytes(32)
        self.status = status
        self.catalog_failed = False
        self.last_read = 0.0
        self.connection_issue: str | None = None
        self.pages.clear()
        self.sources.clear()
        self.cursors.clear()
        if self.provider:
            self.provider.reset()

    def sync(self) -> str:
        version = self.provider.version() if self.provider else None
        account = self.provider.account_identity() if isinstance(self.provider, YouTubeLibrary) else None
        if version != self.version or account != self.account:
            same_account = account is not None and account == self.account
            self.version = version
            self.account = account
            status = "connecting" if version else "auth_required"
            if same_account:
                self.rotate_session(status)
            else:
                self.invalidate(status)
        return self.generation

    def stamp(self) -> tuple[str, int]:
        return self.sync(), self.session_revision

    def rotate_session(self, status: str) -> None:
        self.session_revision += 1
        self.row_signing_key = secrets.token_bytes(32)
        self.status = status
        self.last_read = 0.0
        self.connection_issue = None
        self.needs_session_probe = True
        assert self.provider is not None
        self.provider.reset()
        # Keep the provider order and server-owned cursors. Existing row
        # permissions expire, including those held by requests in flight.
        for key, page in self.pages.items():
            source, _ = key
            rows = [{**row, "key": self.sign(row["key"].split(".", 1)[0].encode())}
                    for row in page["items"]] if source else page["items"]
            self.pages[key] = {**page, "items": rows, "sessionRevision": self.session_revision}

    def row_key(self, source: str, row: Recording) -> str:
        # Each position stays distinct, including repeated tracks in a playlist.
        fields = (uuid4().hex, source, row.track_id, row.title, row.artists, row.album,
                  row.duration, row.playable, row.explicit)
        payload = base64.urlsafe_b64encode(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).rstrip(b"=")
        return self.sign(payload)

    def sign(self, payload: bytes) -> str:
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


class SearchSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    searchId: str = Field(pattern=r"^[a-f0-9]{32}$")
    generation: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=148, pattern=r"^[a-zA-Z0-9_-]+$")
    query: str = Field(min_length=1, max_length=90)


def search_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


@dataclass
class PlaylistSearch:
    id: str
    stamp: tuple[str, int]
    source: str
    query: str
    cursor: Continuation | None = None
    index: PlaylistIndex | None = None
    seen_cursors: set[bytes] = field(default_factory=set)
    matches: list[dict] = field(default_factory=list)
    checked: int = 0
    status: str = "working"
    updated_at: float = field(default_factory=time.monotonic)

    def projection(self) -> dict:
        return {"searchId": self.id, "items": self.matches.copy(), "checked": self.checked,
                "status": self.status}


class PlaylistSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=148, pattern=r"^[a-zA-Z0-9_-]+$")


class PlaylistCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    action: Literal["skip", "stop", "choose"]
    choice: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


@dataclass
class PlaylistQueue:
    id: str
    provider: Provider
    source: str
    stamp: tuple[str, int]
    yandex_generation: str
    station_generation: int
    records: list[Recording] = field(default_factory=list)
    seen: set[Continuation] = field(default_factory=set)
    cursor: Continuation | None = None
    index: PlaylistIndex | None = None
    complete: bool = False
    position: int = 0
    target: str | None = None
    status: str = "working"
    expected_end: float | None = None
    pause_requested: bool = False
    previous_progress: float | None = None
    options: dict[str, Recording] = field(default_factory=dict)


class LikeSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trackId: str = Field(pattern=r"^[0-9]{1,20}$")


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
    def __init__(self, station: StationPlaybackCollector | None, yandex: YandexLibrary | None,
                 youtube: YouTubeLibrary | None, *, access: Callable[[], AccessPolicyStore],
                 writes: Callable[[], bool], paired_track: Callable[[str], str | None],
                 browser: MusicBrowserConnector | None = None):
        self.station, self.yandex = station, yandex
        self.feeds: dict[Provider, Feed] = {"yandex": Feed(yandex), "youtube": Feed(youtube)}
        self.access, self.writes = access, writes
        self.paired_track = paired_track
        self.browser = browser
        self.art = Artwork()
        self.play_lock = asyncio.Lock()
        self.choices: OrderedDict[str, Options] = OrderedDict()
        self.matches: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self.liked_revision = 0
        self.yandex_liked_revision = 0
        self.like_lock = asyncio.Lock()
        self.searches: dict[Provider, PlaylistSearch] = {}
        self.search_locks = {provider: asyncio.Lock() for provider in self.feeds}
        self.playlist_queue: PlaylistQueue | None = None
        self.playlist_task: asyncio.Task | None = None
        if station is not None:
            station.on_playback_progress = self._observe_playlist
        self.uncertain_likes: OrderedDict[tuple[str, str], None] = OrderedDict()

    def invalidate_youtube_likes(self) -> None:
        self.liked_revision += 1
        self.feeds["youtube"].pages.pop(("LM", None), None)
        self.invalidate_search("youtube", "LM")

    def invalidate_search(self, provider: Provider, source: str) -> None:
        job = self.searches.get(provider)
        if job and job.source == source:
            job.status = "playlist_changed"

    def cancel_search(self, provider: Provider, identity: str) -> None:
        job = self.searches.get(provider)
        if job and job.id == identity:
            del self.searches[provider]

    async def search_playlist(self, provider: Provider, body: SearchSelection) -> dict:
        feed = self.feeds[provider]
        stamp = feed.stamp()
        term = search_text(body.query)
        if not term:
            raise HTTPException(422, "empty_query")
        if stamp[0] != body.generation:
            raise HTTPException(409, "account_changed")
        if feed.provider is None or feed.version is None or body.source not in feed.sources:
            raise HTTPException(404, "unknown_playlist")
        lock = self.search_locks[provider]
        if lock.locked():
            raise HTTPException(429, "busy")
        async with lock:
            job = self.searches.get(provider)
            if job is None or job.id != body.searchId:
                job = PlaylistSearch(body.searchId, stamp, body.source, term)
                self.searches[provider] = job
            elif (job.stamp, job.source, job.query) != (stamp, body.source, term):
                raise HTTPException(409, "account_changed")
            if time.monotonic() - job.updated_at > SEARCH_TTL_SECONDS:
                job.status = "page_expired"
            if job.status in {"complete", "limit", "page_expired", "playlist_changed"}:
                return job.projection()
            job.status = "working"
            deadline = time.monotonic() + SEARCH_SECONDS_PER_CYCLE
            try:
                for _ in range(SEARCH_PAGES_PER_CYCLE):
                    if time.monotonic() >= deadline:
                        break
                    async with feed.lock:
                        if self.searches.get(provider) is not job or job.status != "working":
                            break
                        if feed.stamp() != stamp:
                            raise HTTPException(409, "account_changed")
                        if isinstance(feed.provider, YandexLibrary):
                            page, index = await feed.provider.scan_tracks(job.source, job.cursor, job.index)
                        else:
                            page, index = await feed.provider.tracks(job.source, job.cursor), None
                        if feed.stamp() != stamp:
                            raise HTTPException(409, "account_changed")
                        if self.searches.get(provider) is not job or job.status != "working":
                            break
                        next_page = page.continuation
                        cursor_id = hashlib.sha256(repr(next_page).encode()).digest() if next_page else None
                        if len(page.rows) > 220 or (cursor_id is not None and cursor_id in job.seen_cursors):
                            job.status = "page_expired"
                            break
                        for row in page.rows:
                            if not isinstance(row, Recording):
                                raise MusicUnavailable
                            if term in search_text(" ".join((row.title, *row.artists, row.album or ""))):
                                if len(job.matches) == SEARCH_ROWS:
                                    job.status = "limit"
                                    break
                                job.matches.append(self._project(provider, feed, job.source, row))
                            job.checked += 1
                        if job.status == "limit":
                            break
                        job.index, job.cursor = index, next_page
                        if next_page is None:
                            job.status = "complete"
                            break
                        assert cursor_id is not None
                        job.seen_cursors.add(cursor_id)
                        if len(job.seen_cursors) >= 2000:
                            job.status = "limit"
                            break
            except YandexPageExpired:
                job.status = "page_expired"
            except MusicAuthRequired:
                job.status = "auth_required"
            except MusicUnavailable:
                job.status = "source_unavailable"
            if self.searches.get(provider) is not job:
                raise HTTPException(409, "search_cancelled")
            if job.status == "working":
                job.status = "more"
            job.updated_at = time.monotonic()
            return job.projection()

    async def like_current(self, track_id: str) -> dict:
        self.access().require(LIKE_CAPABILITY, gate_enabled=self.writes())
        if self.station.displayed_track(track_id, datetime.now(timezone.utc)) is None:
            raise HTTPException(409, "track_changed")
        yandex = self.yandex
        if yandex is None:
            raise HTTPException(409, "not_configured")
        if self.like_lock.locked():
            raise HTTPException(409, "busy")
        async with self.like_lock:
            version = yandex.version()
            key = None
            try:
                uid = await yandex._account()
                key = (uid, track_id)
                if track_id in await yandex.liked_track_ids(uid):
                    self.uncertain_likes.pop(key, None)
                    return {"status": "already_liked"}
                if key in self.uncertain_likes:
                    return {"status": "unconfirmed"}

                def may_send() -> bool:
                    allowed = yandex.version() == version and self.access().authorize(
                        LIKE_CAPABILITY, gate_enabled=self.writes()).allowed
                    if allowed:
                        keep(self.uncertain_likes, key, None, 128)
                    return allowed

                try:
                    if not await yandex.like_track(uid, track_id, may_send):
                        return {"status": "blocked"}
                except (MusicAuthRequired, MusicUnavailable):
                    if key not in self.uncertain_likes:
                        raise
                if yandex.version() != version or track_id not in await yandex.liked_track_ids(uid):
                    return {"status": "unconfirmed"}
                self.uncertain_likes.pop(key, None)
                self.feeds["yandex"].pages.pop(("likes", None), None)
                self.invalidate_search("yandex", "likes")
                self.yandex_liked_revision += 1
                self.access().audit_capability(LIKE_CAPABILITY, result="confirmed")
                return {"status": "liked"}
            except (MusicAuthRequired, MusicUnavailable) as exc:
                if key in self.uncertain_likes:
                    return {"status": "unconfirmed"}
                raise HTTPException(503, "source_unavailable") from exc

    def can_play(self) -> bool:
        return self.station is not None and self.access().authorize(
            PLAY_CAPABILITY, gate_enabled=self.writes()).allowed

    def status(self, provider: Provider) -> dict:
        feed = self.feeds[provider]
        return {"generation": feed.sync(), "status": feed.status, "canPlay": self.can_play(),
                "sessionRevision": feed.session_revision,
                "viewIdentity": hashlib.sha256(("music-view:" + feed.account).encode()).hexdigest() if feed.account else None,
                "likedRevision": self.liked_revision if provider == "youtube" else self.yandex_liked_revision,
                "yandexGeneration": self.feeds["yandex"].sync()}

    def youtube_connection_status(self) -> str:
        feed = self.feeds["youtube"]
        feed.sync()
        if self.browser and self.browser.projection()["active"]:
            return "recovering"
        if feed.connection_issue:
            return feed.connection_issue
        if feed.provider is None:
            return "not_configured"
        if feed.version is None:
            return "auth_required"
        if not feed.last_read or time.monotonic() - feed.last_read > 660:
            return "unchecked"
        return "ready"

    async def probe_youtube(self) -> None:
        feed = self.feeds["youtube"]
        stamp = feed.stamp()
        if (feed.provider is None or feed.version is None or feed.lock.locked()
                or self.browser and self.browser.projection()["active"]):
            return
        async with feed.lock:
            try:
                await feed.provider.catalog(None)
            except BrowserChannelMismatch:
                issue = "wrong_channel"
            except MusicAuthRequired:
                issue = "auth_required"
            except MusicProxyUnavailable:
                issue = "proxy_unavailable"
            except MusicUnavailable:
                issue = "unavailable"
            else:
                issue = None
            if feed.stamp() == stamp:
                feed.connection_issue = issue
                if issue is None:
                    feed.last_read = time.monotonic()
                    if self.browser:
                        self.browser.confirm_read(feed.version)

    async def page(self, provider: Provider, source: str, cursor: str | None, refresh: bool = False) -> dict:
        feed = self.feeds[provider]
        epoch, revision = stamp = feed.stamp()
        if feed.provider is None:
            raise HTTPException(404, "not_configured")
        if feed.version is None:
            raise HTTPException(401, "auth_required")
        if feed.waiters >= 7:
            raise HTTPException(429, "busy")
        feed.waiters += 1
        try:
            async with feed.lock:
                if feed.stamp() != stamp:
                    raise HTTPException(409, "account_changed")
                if cursor and (cursor not in feed.cursors or feed.cursors[cursor][0] != source):
                    raise HTTPException(409, "page_expired")
                if source and source not in feed.sources:
                    raise HTTPException(404, "unknown_playlist")
                key = (source, cursor)
                cached = feed.pages.get(key)
                if cached and not refresh and not feed.needs_session_probe and feed.status != "auth_required":
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
                except YandexPageExpired as exc:
                    if feed.stamp() != stamp:
                        raise HTTPException(409, "account_changed") from exc
                    feed.discard_pages(source)
                    raise HTTPException(409, "page_expired") from exc
                except MusicAuthRequired as exc:
                    if feed.stamp() != stamp:
                        raise HTTPException(409, "account_changed") from exc
                    if provider == "youtube":
                        feed.status = "auth_required"
                        feed.connection_issue = "wrong_channel" if isinstance(exc, BrowserChannelMismatch) else "auth_required"
                        feed.needs_session_probe = True
                        if self.browser and not isinstance(exc, BrowserChannelMismatch):
                            self.browser.recover()
                    elif feed.status != "auth_required":
                        feed.invalidate("auth_required")
                    raise HTTPException(401, "auth_required") from exc
                except MusicUnavailable as exc:
                    if feed.stamp() != stamp:
                        raise HTTPException(409, "account_changed") from exc
                    if not source:
                        feed.catalog_failed = True
                    feed.status = "unavailable"
                    feed.connection_issue = "proxy_unavailable" if isinstance(exc, MusicProxyUnavailable) else "unavailable"
                    raise HTTPException(503, "source_unavailable") from exc
                if feed.stamp() != stamp:
                    raise HTTPException(409, "account_changed")
                limit = CATALOG_LIMIT if refresh and not source else 220
                if len(page.rows) > limit or (continuation is not None and page.continuation == continuation):
                    raise HTTPException(503, "invalid_page")
                if refresh:
                    self.invalidate_search(provider, source)
                    feed.discard_pages(source)
                    if not source:
                        refreshed = {row.key for row in page.rows if isinstance(row, Playlist)}
                        for removed in feed.sources.keys() - refreshed:
                            self.invalidate_search(provider, removed)
                            feed.discard_pages(removed)
                        feed.sources.clear()
                items = [self._project(provider, feed, source, row) for row in page.rows]
                next_page = uuid4().hex if page.continuation else None
                if next_page:
                    keep(feed.cursors, next_page, (source, page.continuation), CURSOR_CACHE)
                result = {"items": items, "next": next_page, "generation": epoch,
                          "sessionRevision": revision,
                          "observedAt": datetime.now(timezone.utc).isoformat()}
                keep(feed.pages, key, result, PAGE_CACHE)
                if not source:
                    feed.catalog_failed = False
                if not feed.catalog_failed:
                    feed.last_read = time.monotonic()
                    feed.connection_issue = None
                feed.needs_session_probe = False
                feed.status = "unavailable" if feed.catalog_failed else "ready"
                if provider == "youtube" and self.browser:
                    self.browser.confirm_read(feed.version)
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
        stamp = feed.stamp()
        if stamp[0] != request.generation:
            raise HTTPException(409, "account_changed")
        if feed.status in {"auth_required", "connecting"}:
            return {"status": feed.status if feed.status == "auth_required" else "unavailable"}
        row = feed.resolve_row(request.source, request.row)
        if not row.track_id or not row.playable or self.yandex is None:
            return {"status": "unavailable"}
        ya_feed = self.feeds["yandex"]
        ya_epoch = ya_feed.sync()
        def permitted():
            return (self.can_play() and feed.stamp() == stamp and feed.status not in {"auth_required", "connecting"}
                    and request.source in feed.sources
                    and ya_feed.sync() == ya_epoch)

        try:
            async with self.play_lock:
                self.playlist_queue = None
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

    def playlist_status(self) -> dict | None:
        queue = self.playlist_queue
        if queue is None:
            return None
        return {"id": queue.id, "provider": queue.provider, "source": queue.source, "status": queue.status,
                "position": queue.position + 1,
                "title": queue.records[queue.position].title if queue.position < len(queue.records) else None,
                "options": [self._track_dict(record, key) for key, record in queue.options.items()]}

    def _playlist_allowed(self, queue: PlaylistQueue) -> bool:
        return (self.playlist_queue is queue and self.can_play()
                and self.feeds[queue.provider].stamp() == queue.stamp
                and queue.source in self.feeds[queue.provider].sources
                and self.feeds["yandex"].sync() == queue.yandex_generation
                and self.station.generation == queue.station_generation)

    async def start_playlist(self, provider: Provider, selection: PlaylistSelection) -> dict:
        if not self.can_play():
            raise HTTPException(403, "play_blocked")
        if self.play_lock.locked() or self.station.media_busy:
            return {"status": "busy"}
        feed = self.feeds[provider]
        stamp = feed.stamp()
        if stamp[0] != selection.generation:
            raise HTTPException(409, "account_changed")
        if selection.source not in feed.sources or feed.provider is None:
            raise HTTPException(404, "unknown_playlist")
        if feed.status in {"auth_required", "connecting"}:
            return {"status": "auth_required" if feed.status == "auth_required" else "unavailable"}
        async with self.play_lock:
            self.playlist_queue = None
            if provider == "youtube" or selection.source == "likes":
                queue = self.playlist_queue = PlaylistQueue(
                    uuid4().hex, provider, selection.source, stamp, self.feeds["yandex"].sync(), self.station.generation,
                )
                return await self._play_playlist_position(queue, 0)
            if self.yandex is None:
                return {"status": "unavailable"}
            try:
                if identity := PLAYLIST_ID.fullmatch(selection.source):
                    owner, kind = identity.groups()
                else:
                    return {"status": "unavailable"}
                status = await self.station.play_playlist(owner, kind, lambda:
                    self.can_play() and feed.stamp() == stamp and selection.source in feed.sources)
                self.access().audit_capability(PLAY_CAPABILITY, result=status)
                return {"status": status}
            except MusicAuthRequired:
                return {"status": "auth_required"}
            except MusicUnavailable:
                return {"status": "unavailable"}

    async def _play_playlist_position(self, queue: PlaylistQueue, position: int,
                                      choice: Recording | None = None,
                                      extra_gate: Callable[[], bool] = lambda: True) -> dict:
        def permitted() -> bool:
            return extra_gate() and self._playlist_allowed(queue)

        if not permitted():
            queue.status = "blocked"
            return {"status": queue.status}
        feed = self.feeds[queue.provider]
        queue.status, queue.target, queue.expected_end = "working", None, None
        queue.position, queue.previous_progress, queue.pause_requested = position, None, False
        queue.options.clear()
        try:
            if position >= len(queue.records) and not queue.complete:
                assert feed.provider is not None
                async with feed.lock:
                    if not permitted():
                        raise MusicAuthRequired
                    if isinstance(feed.provider, YandexLibrary):
                        page, index = await feed.provider.scan_tracks(queue.source, queue.cursor, queue.index)
                    else:
                        page, index = await feed.provider.tracks(queue.source, queue.cursor), None
                if not permitted():
                    raise MusicAuthRequired
                if page.continuation in queue.seen or len(queue.records) + len(page.rows) > 2400:
                    queue.status = "limit"
                    return self.playlist_status() or {"status": queue.status}
                if any(not isinstance(row, Recording) for row in page.rows):
                    raise MusicUnavailable
                queue.records.extend(row for row in page.rows if isinstance(row, Recording))
                queue.index, queue.cursor, queue.complete = index, page.continuation, page.continuation is None
                if queue.cursor:
                    queue.seen.add(queue.cursor)
            if position >= len(queue.records):
                queue.status = "complete" if queue.complete else "unavailable"
                return self.playlist_status() or {"status": queue.status}

            row = queue.records[position]
            if choice is not None:
                target, options = choice.track_id, []
            elif row.track_id is not None and row.playable:
                target, options = (row.track_id, []) if queue.provider == "yandex" else await self._find(row)
            else:
                target, options = None, []
            if not permitted():
                queue.status = "blocked"
            elif options:
                queue.options = {uuid4().hex: record for record in options}
                queue.status = "choose"
            elif target is None:
                queue.status = "no_match"
            else:
                outcome = await self.station.play_track(target, permitted, restart=True)
                if self.playlist_queue is queue:
                    queue.status = "playing" if outcome in {"playing", "already_playing"} else outcome
                    queue.target = target if queue.status == "playing" else None
                    self.access().audit_capability(PLAY_CAPABILITY, result=queue.status)
        except MusicAuthRequired:
            queue.status = "auth_required"
        except (MusicUnavailable, YandexPageExpired):
            queue.status = "unavailable"
        return self.playlist_status() or {"status": queue.status}

    async def playlist_command(self, command: PlaylistCommand) -> dict:
        queue = self.playlist_queue
        if queue is None or queue.id != command.id:
            raise HTTPException(409, "playlist_changed")
        if not self.can_play():
            raise HTTPException(403, "play_blocked")
        if self.play_lock.locked():
            raise HTTPException(409, "busy")
        async with self.play_lock:
            if command.action == "stop":
                self.playlist_queue = None
                def may_pause() -> bool:
                    return bool(self.can_play() and queue.target and self.station.state
                                and self.station.state.trackId == queue.target)

                if may_pause() and await self.station.control("pause", may_pause) != "confirmed":
                    return {"status": "stopped_unconfirmed"}
                return {"status": "stopped"}
            if command.action == "choose":
                choice = queue.options.get(command.choice or "")
                if choice is None or queue.status != "choose":
                    raise HTTPException(409, "choice_expired")
                return await self._play_playlist_position(queue, queue.position, choice)
            if queue.status not in {"choose", "no_match"}:
                raise HTTPException(409, "playlist_changed")
            return await self._play_playlist_position(queue, queue.position + 1)

    async def navigate_playlist(self, direction: str, may_send: Callable[[], bool]) -> str | None:
        queue = self.playlist_queue
        if queue is None or queue.status not in {"playing", "choose", "no_match"}:
            return None
        if direction in {"pause", "play"} and queue.status == "playing":
            if not may_send():
                return "blocked"
            queue.pause_requested = direction == "pause"
            queue.expected_end = None
            return None
        if direction not in {"next", "previous"}:
            return None
        if self.play_lock.locked():
            return "busy"
        if not may_send():
            return "blocked"
        async with self.play_lock:
            position = max(0, queue.position + (1 if direction == "next" else -1))
            result = await self._play_playlist_position(queue, position, extra_gate=may_send)
            return "confirmed" if result["status"] in {"playing", "choose", "no_match", "complete"} else result["status"]

    def _observe_playlist(self, status: str, track_id: str | None,
                          progress: float | None, duration: float | None) -> None:
        queue = self.playlist_queue
        if queue is None or queue.status != "playing":
            return
        if self.station.generation != queue.station_generation or status in {"stale", "auth_required"}:
            queue.status = "unavailable"
            return
        rolled_over = (track_id == queue.target and progress is not None
                       and queue.previous_progress is not None and progress + 3 < queue.previous_progress)
        if track_id == queue.target and not rolled_over:
            if status == "paused" or queue.pause_requested:
                queue.expected_end = None
            elif progress is not None and duration is not None:
                remaining = duration - progress
                queue.expected_end = time.monotonic() + remaining if 0 <= remaining <= 2 else None
                queue.previous_progress = progress
            return
        natural_end = queue.expected_end is not None and -0.3 <= time.monotonic() - queue.expected_end <= 3
        if not natural_end or self.play_lock.locked():
            queue.status = "stopped"
            return
        if not self._playlist_allowed(queue):
            queue.status = "blocked"
            return
        queue.status = "working"
        self.playlist_task = asyncio.create_task(self._continue_playlist(queue, track_id), name="station-playlist")

    async def _continue_playlist(self, queue: PlaylistQueue, active_track: str | None) -> None:
        async with self.play_lock:
            if not self._playlist_allowed(queue):
                queue.status = "blocked"
                return
            try:
                async with asyncio.timeout(2.2):
                    while self.station.media_busy:
                        await asyncio.sleep(0.05)
            except TimeoutError:
                queue.status = "busy"
                return
            state = self.station.state
            if state and state.status == "playing" and state.trackId != active_track:
                queue.status = "stopped"
                return
            if state and state.status == "playing" and state.trackId == active_track:
                def may_pause() -> bool:
                    return bool(self._playlist_allowed(queue) and self.station.state
                                and self.station.state.trackId == active_track)

                await self.station.control("pause", may_pause)
            await self._play_playlist_position(queue, queue.position + 1)

    async def close(self) -> None:
        self.playlist_queue = None
        if self.playlist_task is not None:
            self.playlist_task.cancel()
            await asyncio.gather(self.playlist_task, return_exceptions=True)

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


def require_music_origin(request: Request, intent: str) -> None:
    try:
        origin = urlsplit(request.headers.get("origin", ""))
    except ValueError as exc:
        raise HTTPException(403, "local_panel_required") from exc
    if (request.headers.get("x-panel-intent") != intent
            or request.headers.get("sec-fetch-site") == "cross-site"
            or origin.scheme not in {"http", "https"} or origin.hostname not in {"127.0.0.1", "localhost", "::1"}
            or origin.netloc != request.headers.get("host")):
        raise HTTPException(403, "local_panel_required")


def build_music_library_router(library: MusicLibrary | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/music")

    @router.get("/{provider}/status")
    async def status(provider: Provider, response: Response):
        response.headers["Cache-Control"] = "no-store"
        if library is None:
            return {"generation": None, "status": "not_configured", "canPlay": False,
                    "likedRevision": 0, "yandexGeneration": None}
        return library.status(provider)

    @router.get("/youtube/connection")
    async def connection(response: Response):
        response.headers["Cache-Control"] = "no-store"
        if library is None or library.browser is None:
            return None
        return {**library.browser.projection(), "libraryStatus": library.status("youtube")["status"]}

    if library is None:
        return router

    @router.post("/youtube/connection/{action}")
    async def change_connection(action: Literal["connect", "cancel", "focus"], request: Request, response: Response):
        browser = library.browser
        if browser is None:
            raise HTTPException(404, "not_configured")
        require_music_origin(request, "youtube-connect")
        # Cancellation remains available if access was restricted after launch.
        if action == "cancel":
            await browser.cancel()
        elif not browser.allowed():
            raise HTTPException(403, "connect_blocked")
        elif action == "focus":
            if not await browser.focus():
                raise HTTPException(409, "window_unavailable")
        elif not browser.start(manual=True):
            raise HTTPException(409, "busy")
        return await connection(response)

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

    @router.post("/{provider}/search")
    async def search(provider: Provider, request: Request, response: Response, body: SearchSelection):
        require_music_origin(request, "music-library")
        response.headers["Cache-Control"] = "no-store"
        return await library.search_playlist(provider, body)

    @router.delete("/{provider}/search/{identity}", status_code=204)
    async def cancel_search(provider: Provider, request: Request, identity: str):
        require_music_origin(request, "music-library")
        library.cancel_search(provider, identity)
        return Response(status_code=204)

    @router.post("/{provider}/play-playlist")
    async def play_playlist(provider: Provider, request: Request, body: PlaylistSelection):
        require_music_origin(request, "music-library")
        return await library.start_playlist(provider, body)

    @router.post("/yandex/like-current")
    async def like_current(request: Request, body: LikeSelection):
        require_music_origin(request, "music-library")
        return await library.like_current(body.trackId)

    @router.post("/{provider}/play")
    async def play(provider: Provider, request: Request, body: PlaySelection):
        require_music_origin(request, "music-library")
        return await library.play(provider, body)

    return router



def build_station_playlist_router(library: MusicLibrary | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/station/playlist")
    if library is None:
        return router

    @router.get("")
    async def playlist_status(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return library.playlist_status()

    @router.post("")
    async def playlist_command(request: Request, body: PlaylistCommand):
        require_music_origin(request, "music-library")
        return await library.playlist_command(body)

    return router
