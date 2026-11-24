"""Save the Station track selected at receipt of a known Alice scenario."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Callable, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore, parse_datetime
from .music_matching import Candidate, Track, match
from .station_playback import StationPlaybackCollector
from .youtube_music import MusicAuthRequired, MusicSession, MusicUnavailable, YouTubeMusic

LOGGER = logging.getLogger(__name__)
CAPABILITY = "media.youtube.save_current"
SCENARIO = "Панель · Сохранить песню в YouTube Music"
SCENARIOS = frozenset({
    SCENARIO,
    "Панель · Добавить трек в YouTube Music",
    "Панель · Лайк в YouTube Music",
    "Панель · Сохранить трек в YouTube Music",
})
CHOICE_SECONDS = 90


def _music_scenario(data: object) -> bool:
    name = data.get("scenario_name") if isinstance(data, dict) else None
    return isinstance(name, str) and name in SCENARIOS


@dataclass
class Operation:
    id: str = field(default_factory=lambda: uuid4().hex)
    status: str = "working"
    title: str | None = None
    source_options: tuple[Track, ...] = ()
    versions: list[Candidate] = field(default_factory=list)
    track: Track | None = None
    session: MusicSession | None = None
    changed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class MusicSave:
    def __init__(self, station: StationPlaybackCollector, provider: YouTubeMusic | None, *, target: str,
                 access: Callable[[], AccessPolicyStore], writes: Callable[[], bool],
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
        self.station, self.provider, self.target = station, provider, target
        self.access, self.writes, self.clock = access, writes, clock
        self.session: MusicSession | None = None
        self.operation: Operation | None = None
        self.task: asyncio.Task | None = None
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.saved: OrderedDict[tuple[bytes, str], Candidate] = OrderedDict()
        self.closed = False
        self.connection = "auth_required" if provider is not None else "not_configured"
        self.busy_events = 0

    def allowed(self) -> bool:
        return not self.closed and self.access().authorize(CAPABILITY, gate_enabled=self.writes()).allowed

    def _state(self, op: Operation, status: str) -> None:
        op.status, op.changed_at = status, self.clock()

    def _prune(self) -> None:
        if self.session is not None and self.provider is not None and not self.provider.is_current(self.session):
            self.connection = "auth_required"
            self.session = None
            self.operation = None
            self.saved.clear()
        op = self.operation
        if op and op.status in {"choose_source", "choose_version"} and (self.clock() - op.changed_at).total_seconds() > CHOICE_SECONDS:
            self.operation = None

    def projection(self) -> dict:
        self._prune()
        op = self.operation
        result = None
        if op is not None:
            options = (
                [{"id": str(idx), "title": item.title, "artist": item.artist, "duration": item.duration, "album": item.album}
                 for idx, item in enumerate(op.source_options)] if op.status == "choose_source" else
                [{**asdict(item), "id": item.video_id, "artist": item.artist} for item in op.versions] if op.status == "choose_version" else []
            )
            result = {"id": op.id, "status": op.status, "title": op.title, "options": options}
        return {"connection": self.connection, "channel": self.session.handle if self.session else None,
                "destination": "Понравившаяся музыка", "operation": result, "busyEvents": self.busy_events,
                "canChoose": self.allowed() and self.session is not None}

    def handle(self, event: dict) -> None:
        data, context = event.get("data"), event.get("context")
        if (self.closed or event.get("event_type") != "yandex_scenario" or event.get("origin") != "LOCAL"
                or not _music_scenario(data) or not isinstance(context, dict)
                or data.get("entity_id") != self.target
                or data.get("instance") != "text_action" or data.get("value") != "ничего не делай"):
            return
        event_id, fired = context.get("id"), parse_datetime(event.get("time_fired"))
        now = self.clock()
        if (not isinstance(event_id, str) or not 0 < len(event_id) <= 80 or event_id in self.seen
                or fired is None or not -2 <= (now - fired).total_seconds() <= 12):
            return
        self.seen[event_id] = None
        if len(self.seen) > 256:
            self.seen.popitem(last=False)
        self._prune()
        if (self.task is not None and not self.task.done()
                or self.operation is not None and self.operation.status.startswith("choose_")):
            self.busy_events = min(self.busy_events + 1, 9999)
            return
        # Snapshot context synchronously before authorization and any network await.
        tracks = self.station.capture_tracks(now)
        op = self.operation = Operation(source_options=tracks, changed_at=now)
        if not self.allowed():
            self._state(op, "blocked")
        elif not tracks:
            self._state(op, "no_track")
        else:
            self.task = asyncio.create_task(self._run(op), name="music-save")

    async def _run(self, op: Operation, choice: Candidate | None = None) -> None:
        try:
            if self.provider is None:
                raise MusicAuthRequired
            if self.session is None:
                self.session = await self.provider.sign_in()
            else:
                session = await self.provider.sign_in()
                if session.generation != self.session.generation:
                    raise MusicAuthRequired
                self.session = session
            if op.session is not None and op.session.generation != self.session.generation:
                raise MusicAuthRequired
            op.session = self.session
            if op.track is None and len(op.source_options) > 1:
                self._state(op, "choose_source")
                return
            op.track = op.track or op.source_options[0]
            op.title = op.track.title
            if choice is None:
                key = (op.session.generation, op.track.source_id)
                choice = self.saved.get(key) if op.track.source_id else None
            if choice is None:
                candidate, choices = match(op.track, await self.provider.search(op.session, op.track))
                self.provider.require_current(op.session)
                self.connection = "connected"
                if choices:
                    op.versions = choices
                    self._state(op, "choose_version")
                    return
                if candidate is None:
                    self._state(op, "no_match")
                    return
                choice = candidate
            await self._save(op, choice, op.session)
        except MusicAuthRequired:
            self.session = None
            self.saved.clear()
            self.connection = "auth_required" if self.provider else "not_configured"
            self._state(op, "auth_required")
        except MusicUnavailable:
            self.connection = "unavailable"
            self._state(op, "unavailable")
        except Exception:
            self._state(op, "unavailable")
            LOGGER.warning("Music save failed")

    async def _save(self, op: Operation, candidate: Candidate, session: MusicSession) -> None:
        assert self.provider is not None and op.track is not None
        if not await self.provider.verify_song(session, candidate.video_id):
            self._state(op, "no_match")
            return
        already_liked = await self.provider.rating(session, candidate) == "like"
        if not already_liked:
            self.provider.require_current(session)
            if not self.allowed():
                self._state(op, "blocked")
                return
            try:
                await self.provider.rate(session, candidate)
            except MusicUnavailable:
                pass  # A timed-out write may have committed. Never send it again.
            try:
                if await self.provider.rating(session, candidate) != "like":
                    self._state(op, "unconfirmed")
                    return
            except MusicUnavailable:
                self._state(op, "unconfirmed")
                return
        try:
            in_music = await self.provider.liked(session, candidate.video_id)
        except (MusicUnavailable, MusicAuthRequired):
            in_music = False
        self.provider.require_current(session)
        state = "already_in_music" if already_liked and in_music else "in_music" if in_music else "youtube_like"
        self._state(op, state)
        self.access().audit_capability(CAPABILITY, result=state)
        if op.track.source_id:
            key = (session.generation, op.track.source_id)
            self.saved[key] = candidate
            self.saved.move_to_end(key)
            if len(self.saved) > 128:
                self.saved.popitem(last=False)

    def choose(self, identity: str, stage: str, choice_id: str) -> None:
        self._prune()
        op = self.operation
        if not self.allowed():
            raise HTTPException(403, "music_write_blocked")
        if op is None or op.id != identity or op.status != stage:
            raise HTTPException(409, "music_choice_expired")
        choice = None
        if stage == "choose_source":
            if choice_id not in {"0", "1"} or int(choice_id) >= len(op.source_options):
                raise HTTPException(422, "invalid_music_choice")
            op.track = op.source_options[int(choice_id)]
        else:
            choice = next((item for item in op.versions if item.video_id == choice_id), None)
            if choice is None:
                raise HTTPException(422, "invalid_music_choice")
        self._state(op, "working")
        self.task = asyncio.create_task(self._run(op, choice), name="music-save-choice")

    async def verify(self) -> None:
        self._prune()
        if self.task is not None and not self.task.done():
            raise HTTPException(409, "music_busy")
        if self.provider is None:
            return
        self.task = asyncio.create_task(self._verify(), name="music-save-account")
        await self.task

    async def _verify(self) -> None:
        assert self.provider is not None
        try:
            session = await self.provider.sign_in()
            self.session, self.connection = session, "connected"
        except MusicAuthRequired:
            self.connection, self.session = "auth_required", None
        except MusicUnavailable:
            self.connection, self.session = "unavailable", None

    async def close(self) -> None:
        self.closed = True
        if self.task is not None:
            # Provider calls are bounded. Wait for any dispatched write to be
            # checked and disallow the next write even if a search finishes.
            await self.task


class MusicChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operationId: str = Field(pattern=r"^[a-f0-9]{32}$")
    stage: Literal["choose_source", "choose_version"]
    choiceId: str = Field(min_length=1, max_length=11)


def dispatch_scenario(event: dict, music: MusicSave | None, tv: Callable[[dict], None] | None) -> None:
    data = event.get("data")
    if _music_scenario(data):
        if music is not None:
            music.handle(event)
    elif tv is not None:
        tv(event)


def build_music_save_router(service: MusicSave | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/station/music-save")

    def ready(request: Request) -> MusicSave:
        if service is None:
            raise HTTPException(404)
        try:
            origin = urlsplit(request.headers.get("origin", ""))
        except ValueError as exc:
            raise HTTPException(403, "local_panel_required") from exc
        if (request.headers.get("x-panel-intent") != "music-save"
                or request.headers.get("sec-fetch-site") == "cross-site"
                or origin.scheme not in {"http", "https"}
                or origin.hostname not in {"127.0.0.1", "localhost", "::1"}
                or origin.netloc != request.headers.get("host")):
            raise HTTPException(403, "local_panel_required")
        return service

    @router.get("")
    async def read(response: Response):
        if service is None:
            raise HTTPException(404)
        response.headers["Cache-Control"] = "no-store"
        return service.projection()

    @router.post("/verify")
    async def verify(request: Request):
        target = ready(request)
        await target.verify()
        return target.projection()

    @router.post("/choose")
    async def choose(payload: MusicChoice, request: Request):
        target = ready(request)
        target.choose(payload.operationId, payload.stage, payload.choiceId)
        return target.projection()

    return router
