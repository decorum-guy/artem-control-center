"""One real continuation at a time, pinned to the ytmusicapi 1.12.4 shapes."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re
import time

from .music_library_types import Continuation, Playlist, ProviderPage, Recording, text
from .music_matching import VIDEO_ID
from .station_credentials import MAX_CREDENTIAL_BYTES, StationCredentialFile, dpapi
from .youtube_library_credentials import browser_headers
from .youtube_music import GoogleCredential, MusicAuthRequired, MusicUnavailable, YOUTUBE_PROXY, music_http

PLAYLIST_ID = re.compile(r"(?:PL|RD|OLA|VL|FL|LL|LM)[a-zA-Z0-9_-]{0,145}")


def thumbnail(value: object) -> str | None:
    if not isinstance(value, list):
        return None
    images = [row for row in value if isinstance(row, dict)
              and isinstance(row.get("url"), str) and 0 < len(row["url"]) <= 1024]
    if not images:
        return None
    return min(images, key=lambda row: abs((row["width"] if type(row.get("width")) is int else 320) - 180))["url"]


def playlist(row: dict) -> Playlist | None:
    key, title = row.get("playlistId"), text(row.get("title"))
    if not isinstance(key, str) or key == "LM" or not PLAYLIST_ID.fullmatch(key) or not title:
        return None
    raw = row.get("count")
    count = int(raw) if type(raw) in (int, str) and re.fullmatch(r"[0-9]{1,7}", str(raw)) else None
    return Playlist(key, title, "playlist", thumbnail(row.get("thumbnails")), count)


def recording(row: dict | None) -> Recording:
    if row is None:
        return Recording(None, "Запись недоступна", (), playable=False)
    raw_id = row.get("videoId")
    track_id = raw_id if isinstance(raw_id, str) and VIDEO_ID.fullmatch(raw_id) else None
    title = text(row.get("title"))
    artists = tuple(name for artist in (row.get("artists") or []) if isinstance(artist, dict)
                    if (name := text(artist.get("name"))))
    album = row.get("album")
    duration = row.get("duration_seconds")
    position = row.get("setVideoId")
    return Recording(
        track_id, title or "Запись недоступна", artists, text(album.get("name")) if isinstance(album, dict) else None,
        duration if type(duration) is int and 0 < duration < 14_400 else None,
        thumbnail(row.get("thumbnails")), bool(track_id and title and row.get("isAvailable") is not False),
        position if isinstance(position, str) and 0 < len(position) <= 180 else None,
        explicit=row.get("isExplicit") if isinstance(row.get("isExplicit"), bool) else None,
    )


def read_browser_vault(path: Path) -> bytes:
    try:
        with path.open("rb") as file:
            content = file.read(MAX_CREDENTIAL_BYTES + 1)
        if not content or len(content) > MAX_CREDENTIAL_BYTES:
            raise ValueError("Invalid vault length")
        return dpapi(content, decrypt=True)
    except (OSError, ValueError) as exc:
        raise MusicAuthRequired from exc


class YouTubeLibrary:
    def __init__(self, path: Path, official_path: Path, proxy: str):
        self.path = path
        self.official_path = official_path
        self.proxy = proxy
        self.validated: tuple[tuple, float] | None = None

    def version(self) -> tuple | None:
        browser = StationCredentialFile(self.path).version()
        official = StationCredentialFile(self.official_path).version()
        return (browser, official) if browser and official else None

    def reset(self) -> None:
        self.validated = None

    async def catalog(self, continuation: Continuation | None) -> ProviderPage:
        return await asyncio.to_thread(self._read, None, continuation)

    async def tracks(self, key: str, continuation: Continuation | None) -> ProviderPage:
        return await asyncio.to_thread(self._read, key, continuation)

    def _read(self, key: str | None, continuation: Continuation | None) -> ProviderPage:
        version = self.version()
        if version is None:
            raise MusicAuthRequired
        try:
            auth = browser_headers(read_browser_vault(self.path))
            account = GoogleCredential.parse(read_browser_vault(self.official_path))
        except ValueError as exc:
            raise MusicAuthRequired from exc
        with music_http(self.proxy, json.dumps(auth)) as client:
            if self.validated is None or self.validated[0] != version or self.validated[1] < time.monotonic():
                active = client.get_account_info().get("channelHandle")
                if not isinstance(active, str) or active.casefold() != account.channel_handle.casefold():
                    raise MusicAuthRequired
                self.validated = version, time.monotonic() + 120
            page = read_page(client, key, continuation)
        if self.version() != version:
            raise MusicAuthRequired
        return page


def read_page(client, key: str | None, cursor: Continuation | None) -> ProviderPage:
    from ytmusicapi.continuations import CONTINUATION_ITEMS, get_continuation_string, get_continuation_token
    from ytmusicapi.navigation import GRID, MRLIR, SECTION, TWO_COLUMN_RENDERER, nav
    from ytmusicapi.parsers.browsing import parse_content_list, parse_playlist
    from ytmusicapi.parsers.library import get_library_contents
    from ytmusicapi.parsers.playlists import parse_playlist_item

    if key is None:
        body = {"browseId": "FEmusic_liked_playlists"}
        if cursor is None:
            response = client._send_request("browse", body)
            container = get_library_contents(response, GRID)
            if container is None:
                # An explicit empty shelf is different from a changed contract.
                if not _has_empty_message(response):
                    raise MusicUnavailable
                container = {"items": []}
            entries = container["items"]
        elif cursor.kind == "grid":
            response = client._send_request("browse", body, get_continuation_string(str(cursor.value)))
            container = response["continuationContents"]["gridContinuation"]
            entries = container["items"]
        else:
            response = client._send_request("browse", {"continuation": cursor.value})
            entries = nav(response, CONTINUATION_ITEMS)
            container = {}
        if not isinstance(entries, list):
            raise MusicUnavailable
        tiles = [item for item in entries if "musicTwoRowItemRenderer" in item]
        rows = tuple(parsed for item in parse_content_list(tiles, parse_playlist) if (parsed := playlist(item)))
        legacy = nav(container, ["continuations", 0, "nextContinuationData", "continuation"], True)
        next_page = _cursor(legacy, "grid") if legacy else _cursor(get_continuation_token(entries) if entries else None, "append")
        return ProviderPage(((Playlist("LM", "Понравившаяся музыка", "liked"),) if cursor is None else ()) + rows, next_page)

    if not PLAYLIST_ID.fullmatch(key):
        raise MusicUnavailable
    if cursor is None:
        response = client._send_request("browse", {"browseId": key if key.startswith("VL") else "VL" + key})
        section = nav(response, TWO_COLUMN_RENDERER + ["secondaryContents"] + SECTION + ["contents"])
        shelf = next((row["musicPlaylistShelfRenderer"] for row in section if "musicPlaylistShelfRenderer" in row), None)
        if shelf is None:
            if not _has_empty_message(section):
                raise MusicUnavailable
            shelf = {"contents": []}
        entries = shelf["contents"]
    else:
        if cursor.kind != "tracks":
            raise MusicUnavailable
        response = client._send_request("browse", {"continuation": cursor.value})
        entries = nav(response, CONTINUATION_ITEMS)
    if not isinstance(entries, list):
        raise MusicUnavailable
    rows = tuple(recording(parse_playlist_item(item[MRLIR])) for item in entries if MRLIR in item)
    return ProviderPage(rows, _cursor(get_continuation_token(entries) if entries else None, "tracks"))


def _cursor(value: object, kind: str) -> Continuation | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 0 < len(value) <= 8192 or not re.fullmatch(r"[A-Za-z0-9_%+=/.-]+", value):
        raise MusicUnavailable
    return Continuation(value, kind)


def _has_empty_message(data: object) -> bool:
    # Known empty renderer is used only for recognizing an explicit empty result.
    pending = [data]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if "musicShelfRenderer" in value and value["musicShelfRenderer"].get("contents") == []:
                return True
            if "messageRenderer" in value or "musicTastebuilderShelfRenderer" in value:
                return True
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return False
