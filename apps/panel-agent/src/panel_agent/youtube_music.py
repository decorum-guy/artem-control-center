"""Protected Google access with bounded YouTube Music reads and verified ratings."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .music_matching import Candidate, Track, VIDEO_ID
from .station_credentials import MAX_CREDENTIAL_BYTES, dpapi

TOKEN_URL = "https://oauth2.googleapis.com/token"
DATA_API = "https://www.googleapis.com/youtube/v3/"
SCOPE = "https://www.googleapis.com/auth/youtube"
YOUTUBE_PROXY = "http://127.0.0.1:10809"
CHANNEL_ID = re.compile(r"UC[A-Za-z0-9_-]{22}")


class MusicAuthRequired(Exception):
    pass


class MusicUnavailable(Exception):
    pass


@dataclass(frozen=True)
class GoogleCredential:
    client_id: str = field(repr=False)
    client_secret: str = field(repr=False)
    refresh_token: str = field(repr=False)
    channel_id: str
    channel_handle: str

    @classmethod
    def parse(cls, data: bytes) -> GoogleCredential:
        values = json.loads(data)
        if (not isinstance(values, dict) or values.keys() != cls.__dataclass_fields__.keys()
                or not all(isinstance(v, str) and 0 < len(v) < 4096 and not any(c.isspace() for c in v)
                           for v in values.values())):
            raise ValueError("Invalid Music credential")
        if not CHANNEL_ID.fullmatch(values["channel_id"]) or not values["channel_handle"].startswith("@"):
            raise ValueError("Invalid Music channel")
        return cls(**values)


@dataclass(frozen=True)
class MusicSession:
    generation: bytes = field(repr=False)
    token: str = field(repr=False)
    channel_id: str
    handle: str
    expires: float


def _clean(value: object) -> str:
    return " ".join(value.split())[:240] if isinstance(value, str) else ""


def _candidate(row: object) -> Candidate | None:
    if not isinstance(row, dict) or row.get("resultType") != "song":
        return None
    identity, title = row.get("videoId"), _clean(row.get("title"))
    names = tuple(_clean(a.get("name")) for a in row.get("artists") or () if isinstance(a, dict))
    if not isinstance(identity, str) or not VIDEO_ID.fullmatch(identity) or not title or not any(names):
        return None
    album = row["album"] if isinstance(row.get("album"), dict) else {}
    seconds = row.get("duration_seconds")
    return Candidate(identity, title, tuple(n for n in names if n), _clean(album.get("name")) or None,
                     seconds if type(seconds) is int and 0 < seconds < 14_400 else None)


class YouTubeMusic:
    def __init__(self, credential_path: Path, proxy: str = "") -> None:
        self.path = credential_path
        self.proxy = YOUTUBE_PROXY if proxy in {"", YOUTUBE_PROXY} else None
        self._cached: MusicSession | None = None

    def _encrypted(self) -> bytes:
        try:
            with self.path.open("rb") as file:
                data = file.read(MAX_CREDENTIAL_BYTES + 1)
            if not 0 < len(data) <= MAX_CREDENTIAL_BYTES:
                raise ValueError("Invalid vault length")
            return data
        except (OSError, ValueError) as exc:
            raise MusicAuthRequired from exc

    def is_current(self, session: MusicSession) -> bool:
        try:
            return hashlib.sha256(self._encrypted()).digest() == session.generation
        except MusicAuthRequired:
            return False

    def require_current(self, session: MusicSession) -> None:
        if not self.is_current(session):
            raise MusicAuthRequired

    async def sign_in(self) -> MusicSession:
        encrypted = self._encrypted()
        generation = hashlib.sha256(encrypted).digest()
        if self._cached and self._cached.generation == generation and self._cached.expires > time.monotonic() + 45:
            return self._cached
        try:
            cfg = GoogleCredential.parse(dpapi(encrypted, decrypt=True))
            payload = await self._google("POST", TOKEN_URL, data={
                "client_id": cfg.client_id, "client_secret": cfg.client_secret,
                "refresh_token": cfg.refresh_token, "grant_type": "refresh_token",
            })
            token = payload.get("access_token")
            expires = payload.get("expires_in")
            if not isinstance(token, str) or not isinstance(expires, int) or payload.get("token_type", "").lower() != "bearer":
                raise MusicAuthRequired
            session = MusicSession(generation, token, cfg.channel_id, cfg.channel_handle, time.monotonic() + expires)
            found = await self._data(session, "GET", "channels", {"part": "snippet", "mine": "true", "maxResults": "5"})
            rows = found.get("items")
            if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("id") != session.channel_id:
                raise MusicAuthRequired
            self.require_current(session)
            self._cached = session
            return session
        except (OSError, ValueError, TypeError) as exc:
            raise MusicAuthRequired from exc

    async def search(self, session: MusicSession, track: Track) -> list[Candidate]:
        return await asyncio.to_thread(self._music_read, session, "search", f"{track.title} {track.artist or ''}")

    async def verify_song(self, session: MusicSession, video_id: str) -> bool:
        if await asyncio.to_thread(self._music_read, session, "song", video_id):
            return True
        # The public player may answer LOGIN_REQUIRED on a music catalog row.
        # Verify the exact ID and the Music category before authorizing a rating.
        result = await self._data(session, "GET", "videos", {"part": "snippet", "id": video_id})
        rows = result.get("items", [])
        return any(row.get("id") == video_id and row.get("snippet", {}).get("categoryId") == "10" for row in rows)

    async def liked(self, session: MusicSession, video_id: str) -> bool:
        return await asyncio.to_thread(self._music_read, session, "liked", video_id)

    async def rating(self, session: MusicSession, candidate: Candidate) -> str:
        result = await self._data(session, "GET", "videos/getRating", {"id": candidate.video_id})
        rows = result.get("items", [])
        ratings = [x.get("rating") for x in rows if x.get("videoId") == candidate.video_id]
        if len(ratings) != 1 or ratings[0] not in {"like", "dislike", "none"}:
            raise MusicUnavailable
        return ratings[0]

    async def rate(self, session: MusicSession, candidate: Candidate) -> None:
        await self._data(session, "POST", "videos/rate", {"id": candidate.video_id, "rating": "like"})

    async def _data(self, session: MusicSession, method: str, name: str, params: dict) -> dict:
        self.require_current(session)
        try:
            result = await self._google(method, DATA_API + name, params=params,
                                        headers={"Authorization": f"Bearer {session.token}"})
        except MusicAuthRequired:
            self._cached = None
            raise
        self.require_current(session)
        return result

    async def _google(self, method: str, url: str, **kwargs) -> dict:
        if self.proxy is None:
            raise MusicUnavailable
        try:
            return await asyncio.wait_for(self._google_request(method, url, **kwargs), timeout=9)
        except (httpx.HTTPError, ValueError, asyncio.TimeoutError) as exc:
            raise MusicUnavailable from exc

    async def _google_request(self, method: str, url: str, **kwargs) -> dict:
        async with httpx.AsyncClient(proxy=self.proxy, trust_env=False, follow_redirects=False, timeout=5) as client:
            async with client.stream(method, url, **kwargs) as response:
                if response.status_code in (401, 403) or (url == TOKEN_URL and response.status_code == 400):
                    raise MusicAuthRequired
                if response.status_code == 204:
                    return {}
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 524_288:
                        raise MusicUnavailable
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise MusicUnavailable
                return value

    def _music_read(self, session: MusicSession, operation: str, value: str):
        auth = json.dumps({"Authorization": f"Bearer {session.token}", "Content-Type": "application/json"}) if operation == "liked" else None
        with music_http(self.proxy, auth, request_limit=8) as client:
            if auth is not None:
                profile = client.get_account_info()
                if (profile.get("channelHandle") or "").casefold() != session.handle.casefold():
                    raise MusicAuthRequired
            if operation == "search":
                records = client.search(value, filter="songs", limit=8, ignore_spelling=True)
                return [match for result in records[:16] if (match := _candidate(result)) is not None]
            if operation == "song":
                payload = client.get_song(value)
                return (payload.get("playabilityStatus", {}).get("status") == "OK"
                        and payload.get("videoDetails", {}).get("videoId") == value)
            return any(row.get("videoId") == value for row in client.get_liked_songs(limit=100).get("tracks", []))


class MusicReadDiagnostics:
    """Record fixed phases and response metadata without logging provider content."""

    logger = logging.getLogger("panel_agent.youtube_music.read")

    def __init__(self) -> None:
        self.phase = "client_init"

    @contextmanager
    def step(self, phase: str):
        self.phase = phase
        started = time.monotonic()
        try:
            yield
        except Exception as exc:
            self.logger.warning("phase=%s result=error class=%s ms=%d",
                                phase, type(exc).__name__, (time.monotonic() - started) * 1000)
            raise
        else:
            self.logger.info("phase=%s result=ok ms=%d", phase, (time.monotonic() - started) * 1000)

    def schema(self, container: str, *, count: int | None = None, account_match: bool | None = None) -> None:
        self.logger.info("phase=%s container=%s count=%s account_match=%s",
                         self.phase, container, count, account_match)

    def http(self, *, code: str, status: int | None, media: str | None, milliseconds: int, size: int) -> None:
        self.logger.log(logging.INFO if code == "ok" else logging.WARNING,
                        "phase=%s code=%s status=%s media=%s ms=%d bytes=%d",
                        self.phase, code, status, media, milliseconds, size)


@contextmanager
def music_http(proxy: str | None, auth: str | None, *, request_limit: int = 2, byte_limit: int = 2_097_152,
               diagnostics: MusicReadDiagnostics | None = None):
    """Pin every InnerTube request to the approved HTTPS host and local proxy."""
    if proxy != YOUTUBE_PROXY:
        raise MusicUnavailable
    try:
        import requests
        from ytmusicapi import YTMusic
        from ytmusicapi.exceptions import YTMusicError
    except ImportError as exc:
        raise MusicUnavailable from exc

    class BudgetedSession(requests.Session):
        remaining = request_limit
        bytes_left = byte_limit
        deadline = time.monotonic() + 12

        def request(self, method, url, **kwargs):
            started = time.monotonic()
            self.remaining -= 1
            elapsed = self.deadline - started
            target = urlsplit(url)
            status, media, body = None, None, bytearray()
            code = "transport"
            try:
                if (self.remaining < 0 or elapsed <= 0 or target.scheme != "https"
                        or target.netloc != "music.youtube.com"):
                    code = "request_budget_or_host"
                    raise MusicUnavailable
                kwargs.update(timeout=min(elapsed, 4), allow_redirects=False, stream=True,
                              proxies={"https": proxy})
                with super().request(method, url, **kwargs) as response:
                    status = response.status_code
                    content_type = response.headers.get("Content-Type", "").partition(";")[0].strip().lower()
                    media = content_type if content_type in {"application/json", "text/html", "text/plain"} else "other"
                    if status in (401, 403):
                        code = "auth_http"
                        raise MusicAuthRequired
                    if status >= 300:
                        redirect_host = urlsplit(response.headers.get("Location", "")).hostname if response.is_redirect else None
                        if redirect_host in {"consent.youtube.com", "consent.google.com"}:
                            code = "consent_redirect"
                        elif redirect_host == "accounts.google.com":
                            code = "sign_in_redirect"
                            if diagnostics is not None:
                                raise MusicAuthRequired
                        else:
                            code = "redirect" if response.is_redirect else "upstream_http"
                        raise MusicUnavailable
                    for chunk in response.iter_content(65536):
                        self.bytes_left -= len(chunk)
                        if self.bytes_left < 0 or time.monotonic() > self.deadline:
                            code = "response_budget"
                            raise MusicUnavailable
                        body.extend(chunk)
                    response._content = bytes(body)
                    code = "ok"
                    return response
            finally:
                if diagnostics is not None:
                    diagnostics.http(code=code, status=status, media=media,
                                     milliseconds=round((time.monotonic() - started) * 1000), size=len(body))

    try:
        with BudgetedSession() as http:
            http.trust_env = False
            with diagnostics.step("client_init") if diagnostics else nullcontext():
                client = YTMusic(auth, requests_session=http, proxies={"https": proxy})
            yield client
    except (requests.RequestException, YTMusicError, KeyError, IndexError, TypeError, ValueError):
        # ytmusicapi may put the response or request URL in its exception text.
        raise MusicUnavailable from None
