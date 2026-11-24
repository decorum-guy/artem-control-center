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
from .youtube_music import GoogleCredential, MusicAuthRequired, MusicReadDiagnostics, MusicUnavailable, music_http

ACCOUNT_MENU = ["actions", 0, "openPopupAction", "popup", "multiPageMenuRenderer"]
ACCOUNT_TTL_SECONDS = 120
PLAYLIST_KEY = re.compile(r"[A-Za-z0-9_-]{2,147}")
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
    if not isinstance(key, str) or not PLAYLIST_KEY.fullmatch(key) or not title:
        return None
    raw = row.get("count")
    count = int(raw) if type(raw) in (int, str) and re.fullmatch(r"[0-9]{1,7}", str(raw)) else None
    return Playlist(key, "Понравившаяся музыка" if key == "LM" else title,
                    "liked" if key == "LM" else "playlist", thumbnail(row.get("thumbnails")), count)


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
        diagnostics = MusicReadDiagnostics()
        phase = ("catalog" if key is None else "tracks") + ("_continuation" if continuation else "_first")
        with music_http(self.proxy, json.dumps(auth), request_limit=4, byte_limit=10_485_760,
                        diagnostics=diagnostics) as client:
            if self.validated is None or self.validated[0] != version or self.validated[1] <= time.monotonic():
                with diagnostics.step("account_menu"):
                    verify_browser_account(client, account, diagnostics)
                self.validated = version, time.monotonic() + ACCOUNT_TTL_SECONDS
            with diagnostics.step(phase):
                page = read_page(client, key, continuation, diagnostics)
        if self.version() != version:
            raise MusicAuthRequired
        return page


def _assert_signed_response(body: object, diagnostics: MusicReadDiagnostics | None) -> dict:
    from ytmusicapi.navigation import nav

    if not isinstance(body, dict):
        raise MusicUnavailable
    # This explicit provider marker was present in the Samsung guest menu and browse response.
    tracking = nav(body, ["responseContext", "serviceTrackingParams"], True)
    for service in tracking if isinstance(tracking, list) else ():
        if not isinstance(service, dict) or service.get("service") != "GFEEDBACK":
            continue
        params = service.get("params")
        if isinstance(params, list) and any(
            isinstance(param, dict) and param.get("key") == "logged_in" and param.get("value") == "0"
            for param in params
        ):
            if diagnostics is not None:
                diagnostics.schema("explicit_signed_out")
            raise MusicAuthRequired
    if body.get("error") or body.get("alerts"):
        if diagnostics is not None:
            diagnostics.schema("upstream_error_or_alert")
        raise MusicUnavailable
    return body


def verify_browser_account(client, account: GoogleCredential, diagnostics: MusicReadDiagnostics) -> None:
    from ytmusicapi.navigation import nav

    response = _assert_signed_response(client._send_request("account/account_menu", {}), diagnostics)
    header = nav(response, ACCOUNT_MENU + ["header", "activeAccountHeaderRenderer"], True)
    if not isinstance(header, dict):
        diagnostics.schema("account_header_missing")
        raise MusicUnavailable
    active = nav(header, ["channelHandle", "runs", 0, "text"], True)
    if not isinstance(active, str) or not active.startswith("@") or not 2 <= len(active) <= 128:
        diagnostics.schema("account_handle_missing")
        raise MusicUnavailable
    matches = active.casefold() == account.channel_handle.casefold()
    diagnostics.schema("activeAccountHeaderRenderer", account_match=matches)
    if not matches:
        raise MusicAuthRequired


def _catalog_rows(entries: list, diagnostics: MusicReadDiagnostics | None) -> tuple[Playlist, ...]:
    from ytmusicapi.navigation import MTRIR, NAVIGATION_BROWSE, PAGE_TYPE, TITLE, nav
    from ytmusicapi.parsers.browsing import parse_playlist

    rows = []
    for item in entries:
        if not isinstance(item, dict):
            raise MusicUnavailable
        if isinstance(item.get("continuationItemRenderer"), dict):
            continue
        tile = item.get(MTRIR)
        if isinstance(tile, dict):
            browse = nav(tile, TITLE + NAVIGATION_BROWSE, True)
            if isinstance(browse, dict):
                browse_id = browse.get("browseId")
                key = browse_id[2:] if isinstance(browse_id, str) and browse_id.startswith("VL") else ""
                # The playlist page type also covers opaque IDs seen in live grid continuations.
                typed_playlist = nav(browse, PAGE_TYPE, True) == "MUSIC_PAGE_TYPE_PLAYLIST"
                accepted = PLAYLIST_KEY.fullmatch(key) and (PLAYLIST_ID.fullmatch(key) or typed_playlist)
                if accepted and (row := playlist(parse_playlist(tile))):
                    rows.append(row)
                    continue
            # The create action is a service tile, never a personal playlist.
            if any(isinstance(nav(tile, path, True), dict) for path in (
                ["navigationEndpoint", "createPlaylistEndpoint"],
                TITLE + ["navigationEndpoint", "createPlaylistEndpoint"],
            )):
                continue
        if diagnostics is not None:
            diagnostics.schema("unknown_catalog_item", count=len(entries))
        raise MusicUnavailable
    return tuple(rows)


def _continuation_after(entries: list, kind: str) -> Continuation | None:
    from ytmusicapi.continuations import get_continuation_token

    slots = [index for index, item in enumerate(entries)
             if isinstance(item, dict) and "continuationItemRenderer" in item]
    if not slots:
        return None
    if slots != [len(entries) - 1]:
        raise MusicUnavailable
    token = get_continuation_token(entries)
    if token is None:
        raise MusicUnavailable
    return _cursor(token, kind)


def read_page(client, key: str | None, cursor: Continuation | None,
              diagnostics: MusicReadDiagnostics | None = None) -> ProviderPage:
    from ytmusicapi.continuations import CONTINUATION_ITEMS, get_continuation_string
    from ytmusicapi.navigation import GRID, MRLIR, SECTION, TWO_COLUMN_RENDERER, nav
    from ytmusicapi.parsers.library import get_library_contents
    from ytmusicapi.parsers.playlists import parse_playlist_item

    def browse(body: dict, params: str = "") -> dict:
        result = client._send_request("browse", body, params) if params else client._send_request("browse", body)
        return _assert_signed_response(result, diagnostics)

    if key is None:
        body = {"browseId": "FEmusic_liked_playlists"}
        container = None
        if cursor is None:
            response = browse(body)
            container = get_library_contents(response, GRID)
            shape = "gridRenderer"
        elif cursor.kind == "grid":
            response = browse(body, get_continuation_string(str(cursor.value)))
            container = nav(response, ["continuationContents", "gridContinuation"], True)
            shape = "gridContinuation"
        elif cursor.kind == "append":
            response = browse({"continuation": cursor.value})
            shape = "appendContinuationItemsAction"
        else:
            raise MusicUnavailable
        entries = (nav(response, CONTINUATION_ITEMS, True) if shape == "appendContinuationItemsAction"
                   else container.get("items") if isinstance(container, dict) else None)
        if not isinstance(entries, list):
            if diagnostics is not None:
                diagnostics.schema("catalog_container_missing")
            raise MusicUnavailable
        if diagnostics is not None:
            diagnostics.schema(shape, count=len(entries))
        rows = _catalog_rows(entries, diagnostics)
        next_page = _continuation_after(entries, "append")
        legacy = nav(container, ["continuations", 0, "nextContinuationData", "continuation"], True) if container else None
        if isinstance(container, dict) and container.get("continuations") and legacy is None:
            raise MusicUnavailable
        if legacy is not None:
            if next_page is not None:
                raise MusicUnavailable
            next_page = _cursor(legacy, "grid")
        if cursor is None and all(row.key != "LM" for row in rows):
            rows = (Playlist("LM", "Понравившаяся музыка", "liked"), *rows)
        return ProviderPage(rows, next_page)

    # Only keys issued by the verified catalogue reach this provider via MusicLibrary.
    if not PLAYLIST_KEY.fullmatch(key):
        raise MusicUnavailable
    if cursor is None:
        response = browse({"browseId": key if key.startswith("VL") else "VL" + key})
        section = nav(response, TWO_COLUMN_RENDERER + ["secondaryContents"] + SECTION + ["contents"], True)
        shelf = next((row.get("musicPlaylistShelfRenderer") for row in section
                      if isinstance(row, dict) and "musicPlaylistShelfRenderer" in row), None) if isinstance(section, list) else None
        entries = shelf.get("contents") if isinstance(shelf, dict) else None
        shape = "musicPlaylistShelfRenderer"
    else:
        if cursor.kind != "tracks":
            raise MusicUnavailable
        response = browse({"continuation": cursor.value})
        entries = nav(response, CONTINUATION_ITEMS, True)
        shape = "appendContinuationItemsAction"
    if not isinstance(entries, list):
        if diagnostics is not None:
            diagnostics.schema("tracks_container_missing")
        raise MusicUnavailable
    if diagnostics is not None:
        diagnostics.schema(shape, count=len(entries))
    rows = []
    for item in entries:
        if not isinstance(item, dict):
            raise MusicUnavailable
        if isinstance(item.get("continuationItemRenderer"), dict):
            continue
        if not isinstance(item.get(MRLIR), dict):
            if diagnostics is not None:
                diagnostics.schema("unknown_track_item", count=len(entries))
            raise MusicUnavailable
        try:
            parsed = parse_playlist_item(item[MRLIR])
        except (KeyError, IndexError, TypeError, ValueError):
            parsed = None
        rows.append(recording(parsed))
    rows = tuple(rows)
    return ProviderPage(rows, _continuation_after(entries, "tracks"))


def _cursor(value: object, kind: str) -> Continuation | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 0 < len(value) <= 8192 or not re.fullmatch(r"[A-Za-z0-9_%+=/.-]+", value):
        raise MusicUnavailable
    return Continuation(value, kind)
