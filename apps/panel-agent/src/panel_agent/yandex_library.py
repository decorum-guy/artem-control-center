"""Read the signed-in Yandex Music library without requesting Station audio."""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timezone

import httpx

from .music_library_types import Continuation, Playlist, ProviderPage, Recording, text
from .station_credentials import StationCredentialFile
from .station_playback import StationAuthRequired, StationPlaybackSettings, StationSessionTokens, normalize_cover
from .youtube_music import MusicAuthRequired, MusicUnavailable

API_URL = "https://api.music.yandex.net"
BATCH_SIZE = 40  # Verified against the account's live index on Samsung.
TRACK_ID = re.compile(r"[0-9]{1,20}")


def identity(value: object) -> str | None:
    candidate = str(value) if type(value) in (int, str) else ""
    return candidate if TRACK_ID.fullmatch(candidate) else None


def recording(row: dict, *, track_id: str | None = None, album_id: str | None = None) -> Recording:
    artists = tuple(name for artist in (row.get("artists") or []) if isinstance(artist, dict)
                    if (name := text(artist.get("name"))))
    albums = [album for album in (row.get("albums") or []) if isinstance(album, dict)]
    album = next((album for album in albums if identity(album.get("id")) == album_id),
                 albums[0] if albums else {})
    title = text(row.get("title"))
    version = text(row.get("version"))
    if title and version and version.casefold() not in title.casefold():
        title = f"{title} ({version})"
    length_ms = row.get("durationMs")
    return Recording(
        track_id or identity(row.get("id")), title or "Запись недоступна", artists,
        text(album.get("title")) or None,
        round(length_ms / 1000) if type(length_ms) is int and 0 < length_ms < 14_400_000 else None,
        normalize_cover(row.get("coverUri") or album.get("coverUri")),
        bool(title and row.get("available") is True),
        album_id=album_id, explicit=row.get("explicit") if isinstance(row.get("explicit"), bool) else None,
    )


class YandexLibrary:
    def __init__(self, file: StationCredentialFile):
        self.file = file
        self.context: tuple | None = None
        self.token: str | None = None
        self.uid: str | None = None
        self.index: tuple[tuple[str | None, str | None], ...] | None = None
        self.expires = 0.0

    def version(self) -> tuple | None:
        return self.file.version()

    def reset(self) -> None:
        self.context = self.token = self.uid = self.index = None
        self.expires = 0

    async def _authorize(self) -> None:
        version = self.version()
        if version is None:
            self.reset()
            raise MusicAuthRequired
        if self.context == version and time.monotonic() < self.expires and self.token:
            return
        if self.context != version:
            self.reset()
        try:
            cfg = self.file.read()
            if cfg.music_token:
                if cfg.expires_at is None or cfg.expires_at <= datetime.now(timezone.utc):
                    raise MusicAuthRequired
                token = cfg.music_token
            else:
                settings = StationPlaybackSettings("", "", "", cfg.x_token, cfg.music_client_id, cfg.music_client_secret)
                async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                    token = await asyncio.wait_for(StationSessionTokens(client, settings)._exchange(), 7)
        except (OSError, ValueError, StationAuthRequired) as exc:
            raise MusicAuthRequired from exc
        except (httpx.HTTPError, TimeoutError) as exc:
            raise MusicUnavailable from exc
        self.context, self.token = version, token
        self.expires = time.monotonic() + 900

    async def _request(self, method: str, path: str, *, limit: int = 786_432, **kwargs):
        await self._authorize()
        try:
            async with asyncio.timeout(8), httpx.AsyncClient(
                base_url=API_URL, headers={"Authorization": f"OAuth {self.token}"},
                timeout=5, trust_env=False, follow_redirects=False,
            ) as client:
                async with client.stream(method, path, **kwargs) as result:
                    if result.status_code in (401, 403):
                        self.reset()
                        raise MusicAuthRequired
                    result.raise_for_status()
                    raw = bytearray()
                    async for chunk in result.aiter_bytes():
                        if len(raw) + len(chunk) > limit:
                            raise MusicUnavailable
                        raw.extend(chunk)
                    if self.context != self.version():
                        self.reset()
                        raise MusicAuthRequired
                    return json.loads(raw)["result"]
        except (httpx.HTTPError, ValueError, KeyError, TypeError, TimeoutError) as exc:
            raise MusicUnavailable from exc

    async def _account(self) -> str:
        await self._authorize()
        if self.uid is None:
            row = await self._request("GET", "/account/status")
            self.uid = identity(row.get("account", {}).get("uid"))
            if self.uid is None:
                raise MusicAuthRequired
        return self.uid

    async def catalog(self, _continuation: Continuation | None) -> ProviderPage:
        await self._account()
        return ProviderPage((Playlist("likes", "Мне нравится", "liked"),))

    async def tracks(self, playlist: str, continuation: Continuation | None) -> ProviderPage:
        if playlist != "likes":
            raise MusicUnavailable
        uid = await self._account()
        if self.index is None or continuation is None:
            response = await self._request("GET", f"/users/{uid}/likes/tracks", limit=6_291_456,
                                           params={"if-modified-since-revision": 0})
            rows = response.get("library", {}).get("tracks")
            if not isinstance(rows, list):
                raise MusicUnavailable
            self.index = tuple((identity(row.get("id")), identity(row.get("albumId")))
                               if isinstance(row, dict) else (None, None) for row in rows)
        start = int(continuation.value) if continuation else 0
        positions = self.index[start:start + BATCH_SIZE]
        ids = [f"{track}:{album}" if album else track for track, album in positions if track]
        records = await self._request("POST", "/tracks", data={"track-ids": ",".join(ids), "with-positions": "False"}) if ids else []
        if not isinstance(records, list):
            raise MusicUnavailable
        by_id = {str(item.get("id")): item for item in records if isinstance(item, dict)}
        next_index = start + len(positions)
        return ProviderPage(tuple(recording(by_id.get(track, {}), track_id=track, album_id=album)
                                  for track, album in positions),
                            Continuation(next_index, "offset") if next_index < len(self.index) else None)

    async def lookup(self, track_id: str) -> Recording | None:
        if identity(track_id) is None:
            return None
        records = await self._request("POST", "/tracks", data={"track-ids": track_id, "with-positions": "False"})
        return next((recording(row) for row in records
                     if isinstance(row, dict) and identity(row.get("id")) == track_id), None)

    async def search(self, track: Recording) -> list[Recording]:
        response = await self._request("GET", "/search", params={
            "text": f"{track.title} {' '.join(track.artists)}", "type": "track", "page": 0, "nocorrect": "true",
        })
        return [recording(row) for row in response.get("tracks", {}).get("results", [])[:20] if isinstance(row, dict)]
