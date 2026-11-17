"""Read-only HSE RUZ timetable. Only the private feed identifier is configured."""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from http.client import HTTPException
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

from .planning import (
    CalendarEventProjection,
    PlanningCalendarIdentity,
    PlanningCalendarSource,
    PlanningCalendarSourceCalendar,
)


SOURCE_ID = "hse-ruz"
CALENDAR_ID = "hse-timetable"
MAX_BYTES = 2 * 1024 * 1024
MAX_EVENTS = 2048
ZONE = ZoneInfo("Europe/Moscow")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _download(feed_id: str) -> bytes:
    # Never put the capability-bearing URL in logs, diagnostics or browser responses.
    key = str(uuid.UUID(feed_id))
    request = Request(f"https://api.hseapp.ru/v3/ruz/cal/{key}", headers={"Accept": "text/calendar"})
    with build_opener(_NoRedirect()).open(request, timeout=6) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("subscription_too_large")
    return raw


def _utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _timed(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=ZONE)


def event_order(event: CalendarEventProjection) -> tuple[bool, str, str]:
    # Same ordering as the upstream Planning repository, including ties.
    return (not event.allDay, event.startDate or event.startAtUtc or "", event.id)


def _read_events(raw: bytes) -> dict[str, CalendarEventProjection]:
    from icalendar import Calendar

    calendar = Calendar.from_ical(raw)
    if calendar.name != "VCALENDAR" or calendar.errors:
        raise ValueError("invalid_calendar")
    components = calendar.walk("VEVENT")
    if len(components) > MAX_EVENTS:
        raise ValueError("subscription_event_limit")
    events = {}
    identity = PlanningCalendarIdentity(providerId=SOURCE_ID, providerLabel="HSE РУЗ",
                                        calendarId=CALENDAR_ID, calendarLabel="HSE")
    for item in components:
        if str(item.get("STATUS", "")).upper() == "CANCELLED":
            continue
        # RUZ publishes one VEVENT per lesson. Refuse a changed feed format
        # atomically rather than dropping occurrences or inventing durations.
        if item.errors or any(key in item for key in ("RRULE", "RDATE", "EXDATE")):
            raise ValueError("unsupported_calendar_event")
        uid = str(item["UID"]).strip()
        if not uid:
            raise ValueError("missing_event_uid")
        occurrence = item["RECURRENCE-ID"].to_ical() if "RECURRENCE-ID" in item else b""
        digest = hashlib.sha256(b"hse-ruz\0" + uid.encode() + b"\0" + occurrence).digest()
        # The existing panel event ID contract requires a UUID with v4 layout.
        event_id = str(uuid.UUID(bytes=digest[:16], version=4))
        if event_id in events:
            raise ValueError("duplicate_event_uid")
        start = item.decoded("DTSTART")
        timed = isinstance(start, datetime)
        if "DTEND" in item:
            end = item.decoded("DTEND")
        elif "DURATION" in item:
            end = start + item.decoded("DURATION")
        elif not timed and isinstance(start, date):
            end = start + timedelta(days=1)
        else:
            raise ValueError("missing_event_end")
        if not isinstance(start, date) or not isinstance(end, date) or timed != isinstance(end, datetime):
            raise ValueError("invalid_event_range")
        stamp = _utc(_timed(item.decoded("DTSTAMP")))
        events[event_id] = CalendarEventProjection(
            id=event_id, version=int(item.get("SEQUENCE", 0)) + 1, source="calendar-provider",
            sourceLabel="HSE РУЗ", calendarIdentity=identity, title=str(item["SUMMARY"]),
            notes=str(item.get("DESCRIPTION", "")) or None, location=str(item.get("LOCATION", "")) or None,
            allDay=not timed, timezone=ZONE.key, syncState="synced", localOnlyMutable=False,
            providerWriteState="read_only", startAtUtc=_utc(_timed(start)) if timed else None,
            endAtUtc=_utc(_timed(end)) if timed else None, startDate=None if timed else start.isoformat(),
            endDateExclusive=None if timed else end.isoformat(), createdAt=_utc(_timed(item.decoded("CREATED"))) if "CREATED" in item else stamp,
            updatedAt=_utc(_timed(item.decoded("LAST-MODIFIED"))) if "LAST-MODIFIED" in item else stamp,
        )
    return events


class HseCalendar:
    def __init__(self, feed_id: str, *, download=_download, clock=time.monotonic):
        self._feed_id = feed_id
        self._download = download
        self._clock = clock
        self._lock = asyncio.Lock()
        self._next_read = 0.0
        self._events: dict[str, CalendarEventProjection] = {}
        self.last_success: str | None = None
        self.last_attempt: str | None = None
        self.error: str | None = None

    async def refresh(self, *, force: bool = False) -> None:
        async with self._lock:
            if not force and self._clock() < self._next_read:
                return
            self.last_attempt = _utc(datetime.now(timezone.utc))
            try:
                raw = await asyncio.wait_for(asyncio.to_thread(self._download, self._feed_id), timeout=10)
                events = await asyncio.to_thread(_read_events, raw)
            except (OSError, URLError, HTTPException, asyncio.TimeoutError):
                self.error = "subscription_read_failed"
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                self.error = "subscription_data_invalid"
            else:
                self._events = events
                self.last_success = self.last_attempt
                self.error = None
            self._next_read = self._clock() + (60 if self.error else 600)

    def status(self) -> PlanningCalendarSource:
        state = "current"
        if self.error or not self.last_success:
            state = "stale" if self.last_success else "error"
        evidence = dict(status=state, errorCode=self.error, lastSyncedAt=self.last_success, observedAt=self.last_attempt)
        return PlanningCalendarSource(id=SOURCE_ID, kind="external", provider="hse", label="HSE РУЗ",
            configured=True, calendars=[PlanningCalendarSourceCalendar(id=CALENDAR_ID, label="HSE",
                color="#3677af", enabled=True, **evidence)], **evidence)

    def event(self, event_id: str) -> CalendarEventProjection | None:
        event = self._events.get(event_id)
        if event is not None and self.error:
            return event.model_copy(update={"syncState": "stale"})
        return event

    def events(self) -> list[CalendarEventProjection]:
        if self.error:
            return [event.model_copy(update={"syncState": "stale"}) for event in self._events.values()]
        return list(self._events.values())
