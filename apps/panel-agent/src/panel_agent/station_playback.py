"""Read-only Station Mini 2 connection, with server-side cover retrieval."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import ssl
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Response
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from .contracts import StationPlayback

GLAGOL_TOKEN_URL = "https://quasar.yandex.net/glagol/token"
MUSIC_TOKEN_URL = "https://oauth.mobile.yandex.net/1/token"
COVER_HOSTS = {"avatars.yandex.net", "avatars.mds.yandex.net"}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
MAX_COVER_BYTES = 512 * 1024
STATE_TIMEOUT_SECONDS = 35
RECONNECT_SECONDS = 2
AUTH_RETRY_SECONDS = 60


class StationAuthRequired(RuntimeError):
    pass


@dataclass(frozen=True)
class StationPlaybackSettings:
    host: str
    fingerprint: str
    device_id: str
    x_token: str = field(repr=False)
    music_client_id: str = field(default="", repr=False)
    music_client_secret: str = field(default="", repr=False)

    @property
    def has_authorization(self) -> bool:
        return bool(self.x_token and self.music_client_id and self.music_client_secret)

    @classmethod
    def from_environment(cls) -> StationPlaybackSettings | None:
        host = os.getenv("PANEL_STATION_PLAYBACK_HOST", "").strip()
        if not host:
            return None
        fingerprint = os.getenv("PANEL_STATION_PLAYBACK_CERT_SHA256", "").strip().lower()
        device_id = os.getenv("PANEL_STATION_PLAYBACK_DEVICE_ID", "").strip()
        try:
            address = ipaddress.IPv4Address(host)
        except ValueError:
            return None
        if (not any(address in network for network in PRIVATE_NETWORKS)
                or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,96}", device_id)):
            return None
        return cls(host, fingerprint, device_id, os.getenv("PANEL_STATION_PLAYBACK_X_TOKEN", "").strip(),
                   os.getenv("PANEL_STATION_PLAYBACK_MUSIC_CLIENT_ID", "").strip(),
                   os.getenv("PANEL_STATION_PLAYBACK_MUSIC_CLIENT_SECRET", "").strip())


def _allowed_https(value: str, hosts: set[str]):
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    if url.scheme != "https" or url.netloc not in hosts or url.fragment:
        return None
    return url


class StationSessionTokens:
    """Keep OAuth credentials in memory and reacquire the device token on each connection."""

    def __init__(self, client: httpx.AsyncClient, settings: StationPlaybackSettings) -> None:
        self.client = client
        self.settings = settings
        self.music_token: str | None = None

    async def acquire(self) -> str:
        if not self.settings.has_authorization:
            raise StationAuthRequired
        # v3.22.3 obtains a Music OAuth token using the authorized X-token.
        # The Glagol endpoint expects this token rather than Passport cookies.
        for _ in range(2):
            if self.music_token is None:
                self.music_token = await self._exchange()
            response = await self.client.get(
                GLAGOL_TOKEN_URL,
                params={"device_id": self.settings.device_id, "platform": "yandexmini_2"},
                headers={"Authorization": f"OAuth {self.music_token}"},
            )
            if response.status_code in (401, 403):
                self.music_token = None
                continue
            response.raise_for_status()
            body = response.json()
            token = body.get("token") if isinstance(body, dict) and body.get("status") == "ok" else None
            if isinstance(token, str) and 1 <= len(token) <= 4096:
                return token
            self.music_token = None
        raise StationAuthRequired

    async def _exchange(self) -> str:
        response = await self.client.post(MUSIC_TOKEN_URL, data={
            "client_id": self.settings.music_client_id,
            "client_secret": self.settings.music_client_secret,
            "grant_type": "x-token",
            "access_token": self.settings.x_token,
        })
        if response.status_code in (400, 401, 403):
            raise StationAuthRequired
        response.raise_for_status()
        body = response.json()
        token = body.get("access_token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not 1 <= len(token) <= 4096:
            raise StationAuthRequired
        return token


def normalize_cover(value: object) -> str | None:
    if not isinstance(value, str) or not 1 <= len(value) <= 1024:
        return None
    normalized = value.replace("%%", "200x200")
    if "://" not in normalized:
        normalized = "https://" + normalized
    url = _allowed_https(normalized, COVER_HOSTS)
    if url and not url.query and url.path.startswith("/get-music-content/"):
        return url.geturl()
    return None


def _text(value: object) -> str | None:
    return (" ".join(value.split())[:240] or None) if isinstance(value, str) else None


def parse_state(data: object) -> tuple[str, str | None, str | None, str | None, str | None] | None:
    if not isinstance(data, dict):
        return None
    state = data.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("playing"), bool) or "playerState" not in state:
        return None
    player = state["playerState"]
    if player is None or player == {}:
        return ("idle", None, None, None, None) if not state["playing"] else None
    if not isinstance(player, dict) or not isinstance(player.get("type"), str):
        return None
    if player["type"] != "Track":
        return "idle", None, None, None, "other-media"
    title = _text(player.get("title"))
    if title is None:
        return None
    extra = player.get("extra")
    cover = normalize_cover(extra.get("coverURI")) if isinstance(extra, dict) else None
    identifier = player.get("id")
    track_key = _text(identifier) if isinstance(identifier, str) else str(identifier) if type(identifier) is int else None
    return ("playing" if state["playing"] else "paused"), title, _text(player.get("subtitle")), cover, track_key


class StationPlaybackCollector:
    def __init__(self, settings: StationPlaybackSettings | None,
                 on_change: Callable[[], Awaitable[object]] | None = None,
                 on_state: Callable[[str, str | None], bool] | None = None,
                 *, clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
        self.settings = settings
        self.on_change = on_change
        self.on_state = on_state
        self._clock = clock
        self.state: StationPlayback | None = None
        self.task: asyncio.Task | None = None
        self.cover_url: str | None = None
        self.covers: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
        self.cover_lock: asyncio.Lock | None = None

    def start(self) -> None:
        if self.settings is not None and self.task is None:
            self.task = asyncio.create_task(self._run(self.settings), name="station-playback")

    async def close(self) -> None:
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
            if self.on_state:
                self.on_state("stale", None)

    async def update(self, status: str, title: str | None = None, artist: str | None = None,
                     cover: str | None = None, track_key: str | None = None) -> None:
        identity = track_key if track_key is not None or title is None else repr((title, artist))
        retention_changed = self.on_state(status, identity) if self.on_state else False
        self.cover_url = cover
        cover_path = ("/api/v1/station-playback/cover/" + hashlib.sha256(cover.encode()).hexdigest()) if cover else None
        content = {"status": status, "title": title, "artist": artist, "coverPath": cover_path}
        playback_changed = self.state is None or self.state.model_dump(exclude={"observedAt"}) != content
        observed_at = self.state.observedAt if self.state is not None else None
        if status not in {"stale", "auth_required"}:
            observed_at = self._clock().isoformat()
        self.state = StationPlayback.model_validate({**content, "observedAt": observed_at})
        if self.on_change is not None and (playback_changed or retention_changed):
            await self.on_change()

    async def _run(self, settings: StationPlaybackSettings) -> None:
        if not settings.has_authorization:
            await self.update("auth_required")
            return
        delay = RECONNECT_SECONDS
        async with httpx.AsyncClient(timeout=7, trust_env=False) as client:
            tokens = StationSessionTokens(client, settings)
            while True:
                started = time.monotonic()
                try:
                    await self._listen(settings, await tokens.acquire())
                except StationAuthRequired:
                    tokens.music_token = None
                    await self.update("auth_required")
                    await asyncio.sleep(AUTH_RETRY_SECONDS)
                except (OSError, TimeoutError, WebSocketException, httpx.HTTPError, ValueError):
                    await self.update("stale")
                    if time.monotonic() - started >= STATE_TIMEOUT_SECONDS:
                        delay = RECONNECT_SECONDS
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 60)

    async def _listen(self, settings: StationPlaybackSettings, token: str) -> None:
        # This self-signed endpoint is pinned to the certificate observed for
        # the owner-confirmed Station before any authorization is sent.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        async with connect(f"wss://{settings.host}:1961", ssl=context, proxy=None, open_timeout=6, close_timeout=2,
                           ping_interval=25, ping_timeout=10, max_size=512 * 1024) as ws:
            peer = ws.transport.get_extra_info("ssl_object").getpeercert(binary_form=True)
            if hashlib.sha256(peer).hexdigest() != settings.fingerprint:
                raise OSError("Station certificate changed")
            await ws.send(json.dumps({"conversationToken": token, "id": str(uuid.uuid4()),
                                      "payload": {"command": "softwareVersion"},
                                      "sentTime": round(time.time() * 1000)}))
            deadline = time.monotonic() + STATE_TIMEOUT_SECONDS
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0, deadline - time.monotonic()))
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                normalized = parse_state(data)
                if normalized is None:
                    if isinstance(data, dict) and data.get("status") in ("unauthorized", "forbidden", 401, 403):
                        raise StationAuthRequired
                    continue
                deadline = time.monotonic() + STATE_TIMEOUT_SECONDS
                await self.update(*normalized)

    async def cover(self, cover_id: str) -> tuple[bytes, str] | None:
        if self.cover_lock is None:
            self.cover_lock = asyncio.Lock()
        async with self.cover_lock:
            if cover_id in self.covers:
                self.covers.move_to_end(cover_id)
                return self.covers[cover_id]
            url = self.cover_url
            if not url or hashlib.sha256(url.encode()).hexdigest() != cover_id:
                return None
            try:
                async with asyncio.timeout(6), httpx.AsyncClient(timeout=5, trust_env=False) as client:
                    async with client.stream("GET", url) as response:
                        media = response.headers.get("content-type", "").split(";", 1)[0]
                        if response.status_code != 200 or media not in {"image/jpeg", "image/png", "image/webp"}:
                            return None
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data) > MAX_COVER_BYTES:
                                return None
            except (httpx.HTTPError, TimeoutError):
                return None
            if not data:
                return None
            self.covers[cover_id] = (bytes(data), media)
            if len(self.covers) > 6:
                self.covers.popitem(last=False)
            return self.covers[cover_id]


def build_station_playback_router(collector: StationPlaybackCollector) -> APIRouter:
    router = APIRouter(prefix="/api/v1/station-playback", tags=["station-playback"])

    @router.get("/cover/{cover_id}")
    async def cover(cover_id: str) -> Response:
        result = await collector.cover(cover_id) if re.fullmatch(r"[a-f0-9]{64}", cover_id) else None
        if result is None:
            raise HTTPException(status_code=404, detail="cover_unavailable")
        return Response(result[0], media_type=result[1], headers={"Cache-Control": "private, max-age=3600"})

    return router
