"""Shared Station Mini 2 connection and server-side cover retrieval."""

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
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Response
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from .contracts import StationPlayback
from .music_matching import Track
from .station_credentials import StationCredentialFile

GLAGOL_TOKEN_URL = "https://quasar.yandex.net/glagol/token"
MUSIC_TOKEN_URL = "https://oauth.mobile.yandex.net/1/token"
COVER_HOSTS = {"avatars.yandex.net", "avatars.mds.yandex.net"}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
MAX_COVER_BYTES = 512 * 1024
STATE_TIMEOUT_SECONDS = 35
RECONNECT_SECONDS = 2
AUTH_RETRY_SECONDS = 60
CREDENTIAL_CHECK_SECONDS = 3
REPLY_TIMEOUT_SECONDS = 8


class StationAuthRequired(RuntimeError):
    pass


class StationReplyUnavailable(RuntimeError):
    pass


class StationReplies:
    """Correlate explicit requests while the Station collector owns recv()."""

    def __init__(self, ws, token: str):
        self.ws = ws
        self.token = token
        self.request_id: str | None = None
        self.pending: asyncio.Future[dict] | None = None
        self.speech: tuple[str, asyncio.Future[bool]] | None = None

    async def repeat_phrase(self, phrase: str, may_send: Callable[[], bool]) -> bool:
        if self.speech is not None or not may_send():
            return False
        request_id = str(uuid.uuid4())
        pending = asyncio.get_running_loop().create_future()
        self.speech = request_id, pending
        try:
            async with asyncio.timeout(4):
                await self.ws.send(json.dumps({
                    "conversationToken": self.token,
                    "id": request_id,
                    "sentTime": round(time.time() * 1000),
                    "payload": {
                        "command": "serverAction",
                        "serverActionEventPayload": {
                            "type": "server_action", "name": "update_form",
                            "payload": {"form_update": {
                                "name": "personal_assistant.scenarios.quasar.iot.repeat_phrase",
                                "slots": [{"type": "string", "name": "phrase_to_repeat", "value": phrase}],
                            }, "resubmit": True},
                        },
                    },
                }, ensure_ascii=False))
                return await pending
        except (OSError, TimeoutError, WebSocketException):
            return False
        finally:
            pending.cancel()
            self.speech = None

    async def reminder_list(self) -> dict:
        if self.pending is not None:
            raise StationReplyUnavailable
        request_id = str(uuid.uuid4())
        pending = asyncio.get_running_loop().create_future()
        self.request_id, self.pending = request_id, pending
        try:
            async with asyncio.timeout(REPLY_TIMEOUT_SECONDS):
                await self.ws.send(json.dumps({
                    "conversationToken": self.token, "id": request_id,
                    "payload": {"command": "sendText", "text": "Перечисли напоминания"},
                    "sentTime": round(time.time() * 1000),
                }, ensure_ascii=False))
                return await pending
        except TimeoutError as exc:
            raise StationReplyUnavailable from exc
        finally:
            pending.cancel()
            self.request_id, self.pending = None, None

    def receive(self, frame: dict) -> None:
        if self.speech is not None:
            request_id, speech = self.speech
            if frame.get("requestId") == request_id and not speech.done() and "status" in frame:
                speech.set_result(str(frame["status"]).lower() in {"success", "ok", "200"})
        pending = self.pending
        if pending is None or pending.done() or frame.get("requestId") != self.request_id:
            return
        envelope = frame.get("vinsResponse")
        response = envelope.get("response") if isinstance(envelope, dict) else None
        if isinstance(envelope, dict) and isinstance(envelope.get("payload"), dict):
            response = envelope["payload"].get("response") or response
        if isinstance(response, dict) and response and not response.get("is_streaming"):
            pending.set_result(response)
        elif str(frame.get("status", "")).lower() in {"401", "403", "error", "failed", "unauthorized", "forbidden"}:
            pending.set_exception(StationReplyUnavailable())

    def close(self) -> None:
        if self.speech is not None and not self.speech[1].done():
            self.speech[1].set_result(False)
        if self.pending is not None and not self.pending.done():
            self.pending.set_exception(StationReplyUnavailable())


@dataclass(frozen=True)
class StationPlaybackSettings:
    host: str
    fingerprint: str
    device_id: str
    x_token: str = field(repr=False)
    music_client_id: str = field(default="", repr=False)
    music_client_secret: str = field(default="", repr=False)
    credential_path: Path | None = field(default=None, repr=False)
    stored_music_token: str = field(default="", repr=False)
    music_expires_at: datetime | None = None

    @property
    def has_authorization(self) -> bool:
        if self.stored_music_token:
            return self.music_expires_at is not None and self.music_expires_at > datetime.now(timezone.utc)
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
        path = os.getenv("PANEL_STATION_PLAYBACK_CREDENTIAL_FILE", "").strip()
        return cls(host, fingerprint, device_id, os.getenv("PANEL_STATION_PLAYBACK_X_TOKEN", "").strip(),
                   os.getenv("PANEL_STATION_PLAYBACK_MUSIC_CLIENT_ID", "").strip(),
                   os.getenv("PANEL_STATION_PLAYBACK_MUSIC_CLIENT_SECRET", "").strip(),
                   Path(path) if path else None)


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
        for _ in range(1 if self.settings.stored_music_token else 2):
            if self.music_token is None:
                self.music_token = self.settings.stored_music_token or await self._exchange()
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


def normalize_cover(value: object, *, playlist: bool = False) -> str | None:
    if not isinstance(value, str) or not 1 <= len(value) <= 1024:
        return None
    normalized = value.replace("%%", "200x200")
    if "://" not in normalized:
        normalized = "https://" + normalized
    url = _allowed_https(normalized, COVER_HOSTS)
    prefixes = ("/get-music-content/", "/get-music-user-playlist/") if playlist else ("/get-music-content/",)
    if url and not url.query and url.path.startswith(prefixes):
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
        self._replies: StationReplies | None = None
        self._track_waiter: tuple[str, int, asyncio.Future[bool]] | None = None
        self.track: Track | None = None
        self.previous_track: Track | None = None
        self.generation = 0

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
                     cover: str | None = None, track_key: str | None = None,
                     *, duration: int | None = None, album: str | None = None) -> None:
        self._observe_track(status, title, artist, track_key, duration, album)
        identity = track_key if track_key is not None or title is None else repr((title, artist))
        retention_changed = self.on_state(status, identity) if self.on_state else False
        self.cover_url = cover
        cover_path = ("/api/v1/station-playback/cover/" + hashlib.sha256(cover.encode()).hexdigest()) if cover else None
        content = {
            "status": status, "title": title, "artist": artist, "coverPath": cover_path,
            "trackId": track_key if status in {"playing", "paused"} else None,
        }
        playback_changed = self.state is None or self.state.model_dump(exclude={"observedAt"}) != content
        observed_at = self.state.observedAt if self.state is not None else None
        if status not in {"stale", "auth_required"}:
            observed_at = self._clock().isoformat()
        self.state = StationPlayback.model_validate({**content, "observedAt": observed_at})
        if self.on_change is not None and (playback_changed or retention_changed):
            await self.on_change()

    def _observe_track(
        self, status: str, title: str | None, artist: str | None, key: str | None,
        duration: int | None, album: str | None,
    ) -> None:
        if status != "playing" or not title:
            self.track = self.previous_track = None
            return
        now = self._clock()
        active = self.track
        same = active is not None and (active.generation, active.source_id, active.title, active.artist) == (
            self.generation, key, title, artist
        )
        if same and active is not None:
            self.track = replace(active, observed_at=now, duration=duration or active.duration, album=album or active.album)
        else:
            self.previous_track = active if active is not None and active.generation == self.generation else None
            self.track = Track(key, title, artist, duration, album, self.generation, now, now)

    def capture_tracks(self, now: datetime) -> tuple[Track, ...]:
        current = self.track
        if current is None or (now - current.observed_at).total_seconds() > STATE_TIMEOUT_SECONDS:
            return ()
        previous = self.previous_track
        if (previous is not None and (now - current.started_at).total_seconds() <= 8
                and (current.started_at - previous.observed_at).total_seconds() <= STATE_TIMEOUT_SECONDS):
            return (previous, current)
        return (current,)

    async def _run(self, settings: StationPlaybackSettings) -> None:
        if settings.credential_path is None:
            await self._run_session(settings)
            return

        # Replacing the protected file closes the old session before connecting
        # with the new credential. A rejected or missing file can be corrected live.
        store = StationCredentialFile(settings.credential_path)
        while True:
            version = store.version()
            try:
                credentials = store.read()
            except (OSError, ValueError):
                await self.update("auth_required")
                await asyncio.sleep(CREDENTIAL_CHECK_SECONDS)
                continue
            updated = replace(settings, x_token=credentials.x_token, music_client_id=credentials.music_client_id,
                              music_client_secret=credentials.music_client_secret, stored_music_token=credentials.music_token,
                              music_expires_at=credentials.expires_at)
            if not updated.has_authorization:
                await self.update("auth_required")
                await asyncio.sleep(CREDENTIAL_CHECK_SECONDS)
                continue
            session = asyncio.create_task(self._run_session(updated), name="station-authorized-session")
            try:
                while store.version() == version and updated.has_authorization:
                    done, _ = await asyncio.wait({session}, timeout=CREDENTIAL_CHECK_SECONDS)
                    if done:
                        session.result()
                        await asyncio.sleep(CREDENTIAL_CHECK_SECONDS)
                        break
            finally:
                session.cancel()
                await asyncio.gather(session, return_exceptions=True)
            await self.update("stale")

    async def _run_session(self, settings: StationPlaybackSettings) -> None:
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
            self.generation += 1
            self.track = self.previous_track = None
            replies = StationReplies(ws, token)
            self._replies = replies
            try:
                deadline = time.monotonic() + STATE_TIMEOUT_SECONDS
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0, deadline - time.monotonic()))
                    try:
                        data = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(data, dict):
                        replies.receive(data)
                    normalized = parse_state(data)
                    if normalized is None:
                        if isinstance(data, dict) and data.get("status") in ("unauthorized", "forbidden", 401, 403):
                            raise StationAuthRequired
                        continue
                    deadline = time.monotonic() + STATE_TIMEOUT_SECONDS
                    player = data["state"].get("playerState")
                    duration = player.get("duration") if isinstance(player, dict) else None
                    length = int(duration) if type(duration) in (int, float) and 0 < duration < 14_400 else None
                    await self.update(*normalized, duration=length)
                    pending = self._track_waiter
                    if (pending and not pending[2].done()
                            and pending[1] == self.generation
                            and normalized[0] == "playing" and normalized[4] == pending[0]):
                        pending[2].set_result(True)
            finally:
                pending = self._track_waiter
                if pending and not pending[2].done():
                    pending[2].set_result(False)
                self._replies = None
                replies.close()

    async def play_track(self, track_id: str, may_send: Callable[[], bool]) -> str:
        """Send one exact recording over the existing reader-owned connection."""
        if not re.fullmatch(r"[0-9]{1,20}", track_id):
            raise ValueError("Invalid Station track ID")
        if self._track_waiter is not None:
            return "busy"
        link = self._replies
        if link is None or self.state is None or self.state.status in {"stale", "auth_required"}:
            return "unavailable"
        if not may_send():
            return "blocked"
        track = self.track
        if (self.state.status == "playing" and track and track.source_id == track_id
                and (self._clock() - track.observed_at).total_seconds() <= STATE_TIMEOUT_SECONDS):
            return "already_playing"

        waiter = asyncio.get_running_loop().create_future()
        self._track_waiter = track_id, self.generation, waiter
        try:
            if not may_send():
                return "blocked"
            async with asyncio.timeout(9):
                await link.ws.send(json.dumps({
                    "conversationToken": link.token, "id": str(uuid.uuid4()),
                    "payload": {"command": "playMusic", "type": "track", "id": track_id},
                    "sentTime": round(time.time() * 1000),
                }))
                return "playing" if await waiter else "unconfirmed"
        except (OSError, TimeoutError, WebSocketException):
            return "unconfirmed"
        finally:
            waiter.cancel()
            self._track_waiter = None

    async def repeat_phrase(self, phrase: str, may_send: Callable[[], bool]) -> bool:
        link = self._replies
        if link is None or self.state is None or self.state.status in {"stale", "auth_required"}:
            return False
        return await link.repeat_phrase(phrase, may_send)

    async def request_reminder_list(self) -> dict:
        """Explicit diagnostic request that may speak. No browser route or periodic calls."""
        if self._replies is None:
            raise StationReplyUnavailable
        return await self._replies.reminder_list()

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
