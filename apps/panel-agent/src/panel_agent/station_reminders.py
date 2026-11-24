"""Read Alice reminders through the account's calendar notes, without speaking."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Response
from icalendar import Event
from pydantic import BaseModel, ConfigDict

from .station_credentials import MAX_CREDENTIAL_BYTES, dpapi

NOTES_URL = "https://rpc.alice.yandex.ru/gproxy/get_calendar_notes"
CLIENT_APP = "ru.yandex.webstandalone.desktop"
MOSCOW_ZONE = "Europe/Moscow"
REFRESH_SECONDS = 30
MAX_RESPONSE_BYTES = 512 * 1024
MAX_NOTES = 200
COOKIE_NAMES = {"Session_id", "sessionid2"}
COOKIE_VALUE = re.compile(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}")


class StationReminder(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    title: str
    dueAt: str
    timezone: str
    repeats: bool


class StationReminderList(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["loading", "fresh", "partial", "stale", "auth_required"] = "loading"
    observedAt: str | None = None
    items: tuple[StationReminder, ...] = ()


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


def _time_of(note: dict) -> tuple[datetime, str, bool]:
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
    if repeats and isinstance(deadline, str) and deadline:
        # Calendar Notes returns the active deadline separately from a series' anchor.
        current = datetime.fromisoformat(deadline)
        start = current if current.utcoffset() is not None else current.replace(tzinfo=start.tzinfo)
    return start, zone, repeats


def normalize_reminder_list(payload: object) -> tuple[tuple[StationReminder, ...], bool]:
    if not isinstance(payload, dict) or payload.get("error") or not isinstance(payload.get("notes"), list):
        raise ValueError("Invalid Calendar Notes payload")
    notes = payload["notes"]
    total = payload.get("total_notes_count")
    if len(notes) > MAX_NOTES or (
        total is not None and (type(total) is not int or total < len(notes))
    ):
        raise ValueError("Invalid Calendar Notes size")
    complete = not payload.get("continuation_token") and total in (None, len(notes))
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
            # The native reminder tests verified delivery at the scheduled time.
            # Unknown relative offsets cannot be presented as actual due times.
            if not isinstance(provider_id, str) or not 0 < len(provider_id) <= 128 or offset not in ("0", 0):
                complete = False
                continue
            identity = hashlib.sha256(provider_id.encode()).hexdigest()
            item = StationReminder(id=identity, title=title.strip(), dueAt=due.isoformat(), timezone=zone, repeats=repeats)
            if identity in result and result[identity] != item:
                complete = False
                continue
            result[identity] = item
    items = tuple(sorted(result.values(), key=lambda item: (datetime.fromisoformat(item.dueAt), item.id)))
    return items, complete


class StationRemindersCollector:
    def __init__(self, credential_path: Path) -> None:
        self.credential_path = credential_path
        self.state = StationReminderList()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="station-reminders")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def _headers(self) -> dict[str, str]:
        try:
            with self.credential_path.open("rb") as file:
                data = file.read(MAX_CREDENTIAL_BYTES + 1)
            if not data or len(data) > MAX_CREDENTIAL_BYTES:
                raise ValueError("Invalid protected reminder credential")
            return reminder_request_headers(*reminder_session(dpapi(data, decrypt=True)))
        except (OSError, ValueError) as exc:
            raise ReminderAuthRequired from exc

    async def _read(self, client: httpx.AsyncClient) -> object:
        async with client.stream(
            "POST", NOTES_URL, headers=self._headers(), json={"hide_completed": True},
        ) as response:
            if response.status_code in (401, 403):
                raise ReminderAuthRequired
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError("Oversized Calendar Notes response")
            return json.loads(body)

    async def refresh(self, client: httpx.AsyncClient) -> None:
        try:
            items, complete = normalize_reminder_list(await asyncio.wait_for(self._read(client), timeout=10))
        except ReminderAuthRequired:
            # A replacement login could belong to another account.
            self.state = StationReminderList(status="auth_required")
        except (OSError, ValueError, httpx.HTTPError, asyncio.TimeoutError):
            self.state = self.state.model_copy(update={"status": "stale"})
        else:
            if complete:
                self.state = StationReminderList(status="fresh", observedAt=datetime.now(timezone.utc).isoformat(), items=items)
            else:
                self.state = self.state.model_copy(update={
                    "status": "partial",
                    "items": self.state.items if self.state.observedAt else items,
                })

    async def _run(self) -> None:
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=7) as client:
            while True:
                await self.refresh(client)
                await asyncio.sleep(REFRESH_SECONDS)


def build_station_reminders_router(collector: StationRemindersCollector | None) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v1/station/reminders", response_model=StationReminderList | None)
    async def reminders(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return collector.state if collector is not None else None

    return router
