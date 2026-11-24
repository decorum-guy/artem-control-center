"""Read Alice reminders through the account's calendar notes, without speaking."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal
from urllib.parse import urlsplit
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from icalendar import Event
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .access_policy import AccessPolicyStore
from .station_credentials import MAX_CREDENTIAL_BYTES, dpapi

NOTES_BASE = "https://rpc.alice.yandex.ru/gproxy/"
NOTES_URL = NOTES_BASE + "get_calendar_notes"
CREATE_CAPABILITY = "planning.reminders.create"
EDIT_CAPABILITY = "planning.reminders.edit"
CLIENT_APP = "ru.yandex.webstandalone.desktop"
MOSCOW_ZONE = "Europe/Moscow"
REFRESH_SECONDS = 30
MAX_RESPONSE_BYTES = 512 * 1024
MAX_NOTES = 200
MAX_PAGES = 8
PAGE_DIRECTIONS = ("forward", "backward")
COOKIE_NAMES = {"Session_id", "sessionid2"}
COOKIE_VALUE = re.compile(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}")


class StationReminder(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    title: str
    dueAt: str | None
    timezone: str
    repeats: bool
    version: str | None = None


class StationReminderList(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["not_configured", "loading", "fresh", "partial", "stale", "auth_required"] = "loading"
    observedAt: str | None = None
    items: tuple[StationReminder, ...] = ()
    canCreate: bool = False
    canReschedule: bool = False


class ReminderAuthRequired(Exception):
    pass


def reminder_session(content: bytes) -> tuple[str, dict[str, str]]:
    data = json.loads(content)
    if not isinstance(data, dict) or set(data) != {"client_uuid", "cookies"}:
        raise ValueError("Invalid reminder session")
    identity, cookies = data["client_uuid"], data["cookies"]
    if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{32}", identity):
        raise ValueError("Invalid reminder client identifier")
    if not isinstance(cookies, dict) or "Session_id" not in cookies or set(cookies) - COOKIE_NAMES:
        raise ValueError("Invalid reminder session cookies")
    if not all(isinstance(value, str) and COOKIE_VALUE.fullmatch(value) for value in cookies.values()):
        raise ValueError("Invalid reminder session cookies")
    return identity, cookies


def reminder_request_headers(identity: str, cookies: dict[str, str]) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "X-Ya-App-Type": "other",
        "X-Ya-App-Id": CLIENT_APP,
        "X-Ya-Language": "ru",
        "X-Ya-Uuid": identity,
        "X-Ya-Application": json.dumps({
            "app_id": CLIENT_APP,
            "uuid": identity,
            "lang": "ru",
            "timezone": MOSCOW_ZONE,
        }),
        "Cookie": "; ".join(f"{key}={value}" for key, value in cookies.items()),
    }


def _time_of(note: dict) -> tuple[datetime | None, str, bool]:
    schedule = note.get("schedule")
    if not isinstance(schedule, str) or not 0 < len(schedule) <= 4096:
        raise ValueError("Missing reminder schedule")
    event = Event.from_ical(f"BEGIN:VEVENT\r\n{schedule.strip()}\r\nEND:VEVENT\r\n")
    start = event.decoded("DTSTART")
    if not isinstance(start, datetime) or start.utcoffset() is None:
        raise ValueError("Missing reminder timezone")
    zone = getattr(start.tzinfo, "key", None) or start.tzname()
    if not zone:
        raise ValueError("Unknown reminder timezone")
    repeats = bool(event.get("RRULE") or event.get("RDATE"))
    deadline = note.get("deadline")
    if repeats:
        if not isinstance(deadline, str) or not deadline:
            return None, zone, repeats
        try:
            current = datetime.fromisoformat(deadline)
        except ValueError:
            return None, zone, repeats
        start = current if current.utcoffset() is not None else current.replace(tzinfo=start.tzinfo)
    return start, zone, repeats


def _version(note: dict) -> str | None:
    note_id = note.get("note_id")
    if not isinstance(note_id, str) or not 0 < len(note_id) <= 128 or len(note["reminders"]) != 1:
        return None
    if note.get("status") != "INCOMPLETE":
        return None
    raw = [note.get(key) for key in ("note_id", "note_hash", "title", "schedule", "reminders", "updated_date_time")]
    return hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()


def normalize_reminder_list(payload: object) -> tuple[tuple[StationReminder, ...], bool]:
    if not isinstance(payload, dict) or payload.get("error") or not isinstance(payload.get("notes"), list):
        raise ValueError("Invalid Calendar Notes payload")
    undated = payload.get("undated_notes", [])
    if not isinstance(undated, list):
        raise ValueError("Invalid Calendar Notes payload")
    notes = [*payload["notes"], *undated]
    total = _note_count(payload)
    if len(notes) > MAX_NOTES or (total is not None and total < len(notes)):
        raise ValueError("Invalid Calendar Notes size")
    complete = (
        total == len(notes)
        and payload.get("_partial") is not True
        and not any(payload.get(key) for key in ("continuation_token", "forward_continuation_token", "backward_continuation_token"))
        and payload.get("run_out_of_forward_notes") is not False
        and payload.get("run_out_of_backward_notes") is not False
    )
    result = {}
    for note in notes:
        if not isinstance(note, dict) or not isinstance(note.get("reminders"), list):
            complete = False
            continue
        if not note["reminders"]:
            continue
        title = note.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 512:
            complete = False
            continue
        try:
            due, zone, repeats = _time_of(note)
        except (KeyError, ValueError, TypeError, OverflowError):
            complete = False
            continue
        for reminder in note["reminders"]:
            if not isinstance(reminder, dict):
                complete = False
                continue
            provider_id = reminder.get("reminder_id")
            offset = reminder.get("offset_seconds")
            # Calendar Notes confirms the scheduled time for zero offset.
            # Unknown relative offsets cannot be presented as actual due times.
            if not isinstance(provider_id, str) or not 0 < len(provider_id) <= 128 or type(offset) not in (str, int) or offset not in ("0", 0):
                complete = False
                continue
            identity = hashlib.sha256(provider_id.encode()).hexdigest()
            item = StationReminder(
                id=identity, title=title.strip(), dueAt=due.isoformat() if due else None, timezone=zone,
                repeats=repeats, version=None if repeats else _version(note),
            )
            if identity in result and result[identity] != item:
                complete = False
                continue
            result[identity] = item
    items = tuple(sorted(result.values(), key=lambda item: (item.dueAt is None, datetime.fromisoformat(item.dueAt) if item.dueAt else None, item.id)))
    return items, complete


def _note_count(payload: dict) -> int | None:
    total = payload.get("total_notes_count")
    if isinstance(total, str) and re.fullmatch(r"[0-9]{1,10}", total):
        return int(total)
    return total if type(total) is int and total >= 0 else None


@dataclass(frozen=True)
class _ReminderSession:
    generation: int
    headers: dict[str, str] = field(repr=False)


@dataclass
class _ResponseBudget:
    remaining: int = MAX_RESPONSE_BYTES

    def consume(self, amount: int) -> None:
        self.remaining -= amount
        if self.remaining < 0:
            raise ValueError("Oversized Calendar Notes response")


class _CalendarPages:
    """Merge Calendar Notes pages conservatively while the provider list can change."""

    def __init__(self) -> None:
        self.notes: dict[str, dict] = {}
        self.total: int | None = None
        self.partial = False

    def add(self, page: object) -> dict:
        if not isinstance(page, dict) or page.get("error") or not isinstance(page.get("notes"), list):
            raise ValueError("Invalid Calendar Notes page")
        undated = page.get("undated_notes", [])
        if not isinstance(undated, list):
            raise ValueError("Invalid Calendar Notes page")
        total = _note_count(page)
        if total is not None:
            if self.total is not None and self.total != total:
                self.partial = True
            self.total = total
        for note in [*page["notes"], *undated]:
            if not isinstance(note, dict) or not isinstance(note.get("note_id"), str) or not note["note_id"]:
                self.partial = True
                continue
            identity = note["note_id"]
            if identity in self.notes and self.notes[identity] != note:
                self.partial = True
            if identity not in self.notes and len(self.notes) >= MAX_NOTES:
                self.partial = True
                break
            self.notes.setdefault(identity, note)
        # The browser uses directional cursors for Calendar Notes. An unknown
        # generic cursor is evidence that this result is incomplete.
        self.partial |= bool(page.get("continuation_token"))
        return page

    def result(self) -> dict:
        notes = list(self.notes.values())
        return {
            "notes": notes,
            "total_notes_count": self.total if self.total is not None and self.total >= len(notes) else None,
            "_partial": self.partial,
        }


class StationRemindersCollector:
    def __init__(self, credential_path: Path) -> None:
        self.credential_path = credential_path
        self.state = StationReminderList()
        self._task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.writer: StationRemindersWriter | None = None
        self._credential_stamp: bytes | None = None
        self._generation = 0
        self._session: _ReminderSession | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="station-reminders")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def _current_session(self) -> _ReminderSession:
        try:
            with self.credential_path.open("rb") as file:
                data = file.read(MAX_CREDENTIAL_BYTES + 1)
            if not data or len(data) > MAX_CREDENTIAL_BYTES:
                raise ValueError("Invalid protected reminder credential")
            stamp = hashlib.sha256(data).digest()
            if self._session is not None and stamp == self._credential_stamp:
                return self._session
            self._generation += 1
            self.state = StationReminderList()
            self._session = _ReminderSession(
                self._generation, reminder_request_headers(*reminder_session(dpapi(data, decrypt=True))),
            )
            self._credential_stamp = stamp
            return self._session
        except (OSError, ValueError) as exc:
            self._credential_stamp = None
            self._session = None
            self.state = StationReminderList(status="auth_required")
            raise ReminderAuthRequired from exc

    def _headers(self) -> dict[str, str]:
        return self._current_session().headers

    def is_current(self, session: _ReminderSession) -> bool:
        try:
            return self._current_session().generation == session.generation
        except ReminderAuthRequired:
            return False

    async def _read(self, client: httpx.AsyncClient, headers: dict[str, str] | None = None) -> dict:
        return await asyncio.wait_for(self._read_pages(client, headers or self._headers()), timeout=10)

    async def _read_pages(self, client: httpx.AsyncClient, headers: dict[str, str]) -> dict:
        pages = _CalendarPages()
        budget = _ResponseBudget()
        payload = {"hide_completed": True}
        first = pages.add(await self._request_json(client, NOTES_URL, headers, payload, budget))
        count = 1
        for direction in PAGE_DIRECTIONS:
            cursor_key = f"{direction}_continuation_token"
            end_key = f"run_out_of_{direction}_notes"
            page = first
            seen: set[str] = set()
            while page.get(cursor_key) or page.get(end_key) is False:
                cursor = page.get(cursor_key)
                if not isinstance(cursor, str) or not 0 < len(cursor) <= 4096 or cursor in seen or count >= MAX_PAGES:
                    pages.partial = True
                    break
                seen.add(cursor)
                count += 1
                page = pages.add(await self._request_json(
                    client, NOTES_URL, headers, {**payload, cursor_key: cursor}, budget,
                ))
        return pages.result()

    async def _request_json(
        self, client: httpx.AsyncClient, url: str, headers: dict[str, str], payload: dict,
        budget: _ResponseBudget | None = None,
    ) -> object:
        limit = budget if budget is not None else _ResponseBudget()
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code in (401, 403):
                raise ReminderAuthRequired
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                limit.consume(len(chunk))
                body.extend(chunk)
            return json.loads(body)

    async def refresh(self, client: httpx.AsyncClient) -> None:
        async with self.lock:
            await self._refresh(client)

    async def _refresh(self, client: httpx.AsyncClient) -> None:
        try:
            session = self._current_session()
        except ReminderAuthRequired:
            return
        try:
            items, complete = normalize_reminder_list(await self._read(client, session.headers))
        except ReminderAuthRequired:
            if self.is_current(session):
                self.state = StationReminderList(status="auth_required")
        except (OSError, ValueError, httpx.HTTPError, asyncio.TimeoutError):
            if self.is_current(session):
                self.state = self.state.model_copy(update={"status": "stale"})
        else:
            if not self.is_current(session):
                return
            if complete:
                self.confirm(items)
            else:
                self.state = self.state.model_copy(update={
                    "status": "partial",
                    "items": self.state.items if self.state.observedAt else items,
                })

    def confirm(self, items: tuple[StationReminder, ...]) -> None:
        self.state = StationReminderList(status="fresh", observedAt=datetime.now(timezone.utc).isoformat(), items=items)

    def projection(self) -> StationReminderList:
        try:
            self._current_session()
        except ReminderAuthRequired:
            return self.state
        if self.writer is None or self.state.status != "fresh":
            return self.state
        return self.state.model_copy(update={
            "canCreate": self.writer.allowed(CREATE_CAPABILITY),
            "canReschedule": self.writer.allowed(EDIT_CAPABILITY),
        })

    async def _run(self) -> None:
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=7) as client:
            while True:
                await self.refresh(client)
                await asyncio.sleep(REFRESH_SECONDS)


class ReminderChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attemptId: UUID
    dueLocal: str = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$")

    def due_time(self) -> datetime:
        zone = ZoneInfo(MOSCOW_ZONE)
        try:
            value = datetime.fromisoformat(self.dueLocal).replace(tzinfo=zone)
        except ValueError as exc:
            raise HTTPException(422, "invalid_time") from exc
        if value <= datetime.now(zone):
            raise HTTPException(422, "time_must_be_future")
        return value


class CreateReminder(ReminderChange):
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        title = value.strip()
        if not title or any(ord(char) < 32 for char in title):
            raise ValueError("Invalid reminder title")
        return title


class RescheduleReminder(ReminderChange):
    expectedVersion: str = Field(pattern=r"^[a-f0-9]{64}$")


def _local_intent(request: Request) -> bool:
    if request.headers.get("x-panel-intent") != "station-reminders":
        return False
    try:
        origin = urlsplit(request.headers.get("origin", ""))
        return (
            origin.scheme in {"http", "https"}
            and origin.hostname in {"localhost", "127.0.0.1", "::1"}
            and origin.netloc == request.headers.get("host")
            and request.headers.get("sec-fetch-site") != "cross-site"
        )
    except ValueError:
        return False


def _note_for(payload: dict, reminder_id: str) -> dict | None:
    for note in payload["notes"] + payload.get("undated_notes", []):
        for reminder in note.get("reminders", []):
            if hashlib.sha256(reminder["reminder_id"].encode()).hexdigest() == reminder_id:
                return note
    return None


class StationRemindersWriter:
    def __init__(
        self, collector: StationRemindersCollector, *, access: Callable[[], AccessPolicyStore],
        write_enabled: Callable[[], bool],
    ) -> None:
        self.collector = collector
        self.access = access
        self.write_enabled = write_enabled
        self._attempts: deque[UUID] = deque(maxlen=128)
        self._busy = asyncio.Lock()

    def allowed(self, capability: str) -> bool:
        return self.access().authorize(capability, gate_enabled=self.write_enabled()).allowed

    async def submit(self, request: Request, change: CreateReminder | RescheduleReminder, identity: str | None = None) -> StationReminderList:
        capability = EDIT_CAPABILITY if isinstance(change, RescheduleReminder) else CREATE_CAPABILITY
        result = "rejected"
        try:
            if not _local_intent(request):
                raise HTTPException(403, "local_panel_required")
            self.access().require(capability, gate_enabled=self.write_enabled())
            if self._busy.locked():
                raise HTTPException(409, "busy")
            async with self._busy, self.collector.lock:
                if change.attemptId in self._attempts:
                    raise HTTPException(409, "already_submitted")
                target = change.due_time()
                async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=7) as client:
                    try:
                        session = self.collector._current_session()
                        before = await self.collector._read(client, session.headers)
                        _, complete = normalize_reminder_list(before)
                    except ReminderAuthRequired as exc:
                        raise HTTPException(503, "auth_required") from exc
                    except (ValueError, httpx.HTTPError, OSError, asyncio.TimeoutError) as exc:
                        raise HTTPException(503, "source_unavailable") from exc
                    if not complete:
                        raise HTTPException(409, "incomplete_source")
                    schedule = "DTSTART;TZID=Europe/Moscow:" + target.strftime("%Y%m%dT%H%M%S")
                    if isinstance(change, RescheduleReminder):
                        original = _note_for(before, identity or "")
                        if original is None or _version(original) != change.expectedVersion:
                            raise HTTPException(409, "reminder_changed")
                        if _time_of(original)[2]:
                            raise HTTPException(409, "recurring_reminder")
                        source_note_id = original["note_id"]
                        path = "update_note"
                        note = {"note_id": source_note_id, "status": "INCOMPLETE", "schedule": schedule}
                    else:
                        path = "create_note"
                        note = {"title": change.title, "doable": True, "status": "INCOMPLETE",
                                "schedule": schedule, "reminders": [{"offset_seconds": "0"}]}
                    self.access().require(capability, gate_enabled=self.write_enabled())
                    if not self.collector.is_current(session):
                        raise HTTPException(409, "auth_required")
                    self._attempts.append(change.attemptId)
                    result = "unconfirmed"
                    await self._mutate(client, path, session, note, target)
                    result = "confirmed"
                    return self.collector.projection()
        finally:
            self.access().audit_capability(capability, result=result, correlation_id=str(change.attemptId))

    async def _mutate(
        self, client: httpx.AsyncClient, path: str, session: _ReminderSession, note: dict, target: datetime,
    ) -> None:
        headers = session.headers
        try:
            envelope = await asyncio.wait_for(
                self.collector._request_json(client, NOTES_BASE + path, headers, {"note": note}),
                timeout=9,
            )
            saved = envelope.get("note") if isinstance(envelope, dict) and not envelope.get("error") else None
            note_id = saved.get("note_id") if isinstance(saved, dict) else None
        except ReminderAuthRequired as exc:
            raise HTTPException(503, "auth_required") from exc
        except (ValueError, httpx.HTTPError, OSError, asyncio.TimeoutError) as exc:
            raise HTTPException(502, "unconfirmed") from exc
        if not isinstance(note_id, str) or (path == "update_note" and note_id != note["note_id"]):
            raise HTTPException(502, "unconfirmed")
        for delay in (0, 0.4, 1):
            await asyncio.sleep(delay)
            try:
                after = await asyncio.wait_for(self.collector._read(client, headers), timeout=8)
                items, complete = normalize_reminder_list(after)
            except (ValueError, httpx.HTTPError, OSError, asyncio.TimeoutError, ReminderAuthRequired):
                continue
            if complete and self.collector.is_current(session):
                self.collector.confirm(items)
                latest = next((item for item in after["notes"] if item.get("note_id") == note_id), None)
                if latest and latest.get("reminders") and _time_of(latest)[0] == target:
                    return
        raise HTTPException(502, "unconfirmed")


def build_station_reminders_router(collector: StationRemindersCollector | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/station/reminders")

    @router.get("", response_model=StationReminderList)
    async def reminders(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return collector.projection() if collector is not None else StationReminderList(status="not_configured")

    def writer() -> StationRemindersWriter:
        if collector is None or collector.writer is None:
            raise HTTPException(405, "alice_writes_disabled")
        return collector.writer

    @router.post("", response_model=StationReminderList)
    async def create(change: CreateReminder, request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await writer().submit(request, change)

    @router.patch("/{identity}", response_model=StationReminderList)
    async def reschedule(identity: str, change: RescheduleReminder, request: Request, response: Response):
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise HTTPException(404, "reminder_not_found")
        response.headers["Cache-Control"] = "no-store"
        return await writer().submit(request, change, identity)

    return router
