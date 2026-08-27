"""Read-only Panel Agent adapter for AliceTG_Bot Planning v1."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, time as local_time, timedelta, timezone
from typing import Any, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from pydantic import ValidationError

from .planning import (
    CalendarEventProjection,
    EventListEnvelope,
    EventObjectEnvelope,
    PlanningCalendarIdentity,
    PlanningCalendarSource,
    PlanningCalendarSourceCalendar,
    PlanningCalendarSourcesRefresh,
    PlanningConflict,
    PlanningEventObjectEnvelope,
    PlanningCapabilities,
    PlanningObjectEnvelope,
    PlanningTaskObjectEnvelope,
    PlanningParsePreview,
    PlanningProjection,
    PlanningReadEnvelope,
    PlanningListEnvelope,
    PlanningSourceStatus,
    PlanningStatusProjection,
    ProjectListEnvelope,
    ProjectProjection,
    ReminderObjectEnvelope,
    ReminderListEnvelope,
    ReminderProjection,
    StatusEnvelope,
    TaskObjectEnvelope,
    TaskListEnvelope,
    TaskProjection,
    UpstreamCalendarEvent,
    UpstreamPlanningSource,
    UpstreamProject,
    UpstreamReminder,
    UpstreamTask,
    empty_planning_projection,
    source_label,
    status_projection,
    timestamp_datetime,
    validate_date,
    validate_uuid4,
    validate_utc_timestamp,
)
from .planning_cache import PlanningProjectionCache
from .settings import IntegrationSettings


LOGGER = logging.getLogger(__name__)

PLANNING_ROUTES: Mapping[str, str] = {
    "reminders": "/internal/planning/v1/reminders",
    "parse": "/internal/planning/v1/parse",
    "tasks": "/internal/planning/v1/tasks",
    "events": "/internal/planning/v1/events",
    "projects": "/internal/planning/v1/projects",
    "status": "/internal/planning/v1/status",
    "calendar_sources_refresh": "/internal/planning/v1/calendar-sources/refresh",
}
PLANNING_MUTATION_ROUTES: Mapping[str, str] = {
    "create_reminder": "/internal/planning/v1/reminders",
    "edit_reminder": "/internal/planning/v1/reminders/{reminder_id}",
    "complete_reminder": "/internal/planning/v1/reminders/{reminder_id}/complete",
    "cancel_reminder": "/internal/planning/v1/reminders/{reminder_id}/cancel",
    "create_task": "/internal/planning/v1/tasks",
    "edit_task": "/internal/planning/v1/tasks/{task_id}",
    "complete_task": "/internal/planning/v1/tasks/{task_id}/complete",
    "archive_task": "/internal/planning/v1/tasks/{task_id}",
    "create_event": "/internal/planning/v1/events",
    "edit_event": "/internal/planning/v1/events/{event_id}",
    "delete_event": "/internal/planning/v1/events/{event_id}",
}
PLANNING_MUTATION_METHODS: Mapping[str, str] = {
    "create_reminder": "POST",
    "edit_reminder": "PATCH",
    "complete_reminder": "POST",
    "cancel_reminder": "POST",
    "create_task": "POST",
    "edit_task": "PATCH",
    "complete_task": "POST",
    "archive_task": "DELETE",
    "create_event": "POST",
    "edit_event": "PATCH",
    "delete_event": "DELETE",
}
PLANNING_TASK_READ_ROUTE = "/internal/planning/v1/tasks/{task_id}"
PLANNING_EVENT_READ_ROUTE = "/internal/planning/v1/events/{event_id}"
PLANNING_AUDIENCE = "panel-agent"
PLANNING_PAGE_LIMIT = 20
PLANNING_MAX_UPSTREAM_PAGE = 100
PLANNING_REMINDER_SCAN_MAX_PAGES_PER_SOURCE = 2
PLANNING_REMINDER_SCAN_MAX_ROWS_PER_SOURCE = (
    PLANNING_MAX_UPSTREAM_PAGE * PLANNING_REMINDER_SCAN_MAX_PAGES_PER_SOURCE
)
PLANNING_REMINDER_SCAN_MAX_ROWS = PLANNING_REMINDER_SCAN_MAX_ROWS_PER_SOURCE * 2
PLANNING_FAILURE_SCAN_MAX_PAGES = 1
PLANNING_RANGE_DAYS = 30
PLANNING_EVENT_UPCOMING_DAYS = 7
PLANNING_JITTER_RATIO = 0.10


class PlanningConfigurationError(ValueError):
    """The fixed server-side Planning connection is unsafe or incomplete."""


class PlanningUpstreamError(RuntimeError):
    """A bounded upstream request or strict contract validation failed."""

    def __init__(self, category: str, *, status_code: int | None = None) -> None:
        super().__init__(category)
        self.category = category
        self.status_code = status_code

    @property
    def uncertain(self) -> bool:
        return self.category == "mutation_uncertain"


class PlanningBoundedScanError(PlanningUpstreamError):
    """A derived read cannot be proven inside its fixed scan budget."""

    def __init__(self) -> None:
        super().__init__("reminder_view_scan_budget_exceeded")


class PlanningReadUnavailable(RuntimeError):
    """A route read cannot be satisfied from the live upstream or a complete cache."""


@dataclass
class _ReminderScanSource:
    state: Literal["pending", "due"]
    from_utc: str | None = None
    to_utc: str | None = None
    items: list[UpstreamReminder] = field(default_factory=list)
    envelopes: list[ReminderListEnvelope] = field(default_factory=list)
    next_offset: int = 0
    pages: int = 0
    exhausted: bool = False


def validate_planning_base_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanningConfigurationError("Planning base URL is required")
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PlanningConfigurationError("Planning base URL must use http or https")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise PlanningConfigurationError(
            "Planning base URL must not contain credentials, query, or fragment"
        )
    if parsed.path not in {"", "/"}:
        raise PlanningConfigurationError(
            "Planning base URL must be an origin without a path"
        )
    try:
        parsed.port
    except ValueError as exc:
        raise PlanningConfigurationError("Planning base URL contains an invalid port") from exc
    return normalized


def _duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


class PlanningClient:
    """Fixed-route, fixed-header Planning client; it is not a generic proxy."""

    def __init__(
        self,
        *,
        base_url: str,
        internal_secret: str,
        panel_secret: str,
        timeout_seconds: float = 10,
        response_limit_bytes: int = 256 * 1024,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not internal_secret or not panel_secret:
            raise PlanningConfigurationError("Planning authentication secrets are required")
        if timeout_seconds <= 0:
            raise PlanningConfigurationError("Planning request timeout must be positive")
        if response_limit_bytes <= 0:
            raise PlanningConfigurationError("Planning response limit must be positive")
        self.base_url = validate_planning_base_url(base_url)
        self._response_limit_bytes = response_limit_bytes
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_seconds),
            transport=transport,
        )
        self._headers = {
            "X-Internal-Secret": internal_secret,
            "X-Planning-Audience": PLANNING_AUDIENCE,
            "X-Planning-Secret": panel_secret,
        }

    async def close(self) -> None:
        await self._client.aclose()

    async def reminders(
        self,
        *,
        state: str | None = None,
        from_utc: str | None = None,
        to_utc: str | None = None,
        limit: int = PLANNING_PAGE_LIMIT,
        offset: int = 0,
    ) -> ReminderListEnvelope:
        if state is not None and state not in {"pending", "due", "completed", "cancelled"}:
            raise PlanningUpstreamError("query_state_out_of_range")
        if (from_utc is None) != (to_utc is None):
            raise PlanningUpstreamError("query_range_requires_both")
        if from_utc is not None and to_utc is not None:
            _validate_range(from_utc, to_utc)
        params = _fixed_list_query(
            {"state": state, "from": from_utc, "to": to_utc, "limit": limit, "offset": offset},
            allowed={"state", "from", "to", "limit", "offset"},
        )
        payload = await self._get_json("reminders", params)
        return _validate_envelope(ReminderListEnvelope, payload)

    async def tasks(
        self,
        *,
        view: Literal["today", "overdue", "upcoming"],
        project_id: str | None = None,
        limit: int = PLANNING_PAGE_LIMIT,
        offset: int = 0,
    ) -> TaskListEnvelope:
        if view not in {"today", "overdue", "upcoming"}:
            raise PlanningUpstreamError("query_view_out_of_range")
        if project_id is not None:
            validate_uuid4(project_id, "planning.project_id")
        params = _fixed_list_query(
            {"view": view, "project_id": project_id, "limit": limit, "offset": offset},
            allowed={"view", "project_id", "limit", "offset"},
        )
        payload = await self._get_json("tasks", params)
        return _validate_envelope(TaskListEnvelope, payload)

    async def events(
        self,
        *,
        from_utc: str,
        to_utc: str,
        limit: int = PLANNING_PAGE_LIMIT,
        offset: int = 0,
    ) -> EventListEnvelope:
        _validate_range(from_utc, to_utc)
        params = _fixed_list_query(
            {"from": from_utc, "to": to_utc, "limit": limit, "offset": offset},
            allowed={"from", "to", "limit", "offset"},
        )
        payload = await self._get_json("events", params)
        return _validate_envelope(EventListEnvelope, payload)

    async def get_event(self, event_id: str) -> EventObjectEnvelope:
        validate_uuid4(event_id, "planning.calendar_event_id")
        path = PLANNING_EVENT_READ_ROUTE.replace("{event_id}", event_id)
        payload = await self._request_json("GET", path, expected_status={200})
        return _validate_envelope(EventObjectEnvelope, payload)

    async def projects(
        self,
        *,
        limit: int = PLANNING_PAGE_LIMIT,
        offset: int = 0,
    ) -> ProjectListEnvelope:
        params = _fixed_list_query(
            {"limit": limit, "offset": offset},
            allowed={"limit", "offset"},
        )
        payload = await self._get_json("projects", params)
        return _validate_envelope(ProjectListEnvelope, payload)

    async def status(self) -> StatusEnvelope:
        payload = await self._get_json("status", {})
        return _validate_envelope(StatusEnvelope, payload)

    async def refresh_calendar_sources(self) -> PlanningCalendarSourcesRefresh:
        payload = await self._request_json(
            "POST",
            PLANNING_ROUTES["calendar_sources_refresh"],
            json_body={},
            expected_status={200},
        )
        return _validate_envelope(PlanningCalendarSourcesRefresh, payload)

    async def parse_preview(
        self,
        *,
        text: str,
        reference_time_utc: str,
        timezone: str,
        locale: str = "ru-RU",
    ) -> PlanningParsePreview:
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise PlanningUpstreamError("parse_input_invalid")
        validate_utc_timestamp(reference_time_utc, "planning.reference_time_utc")
        if not isinstance(timezone, str) or len(timezone) > 64:
            raise PlanningUpstreamError("parse_input_invalid")
        if locale != "ru-RU":
            raise PlanningUpstreamError("parse_input_invalid")
        payload = await self._request_json(
            "POST",
            PLANNING_ROUTES["parse"],
            json_body={
                "text": text,
                "reference_time_utc": reference_time_utc,
                "timezone": timezone,
                "locale": locale,
            },
            expected_status={200},
        )
        return _validate_envelope(PlanningParsePreview, payload)

    async def create_reminder(
        self,
        *,
        idempotency_key: str,
        title: str,
        notes: str | None,
        due_at_utc: str,
        timezone: str,
    ) -> ReminderObjectEnvelope:
        body = {
            "title": title,
            "notes": notes,
            "due_at_utc": due_at_utc,
            "timezone": timezone,
        }
        payload = await self._mutation_json(
            "create_reminder",
            idempotency_key=idempotency_key,
            body=body,
        )
        return _validate_envelope(ReminderObjectEnvelope, payload)

    async def edit_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> ReminderObjectEnvelope:
        validate_uuid4(reminder_id, "planning.reminder_id")
        _validate_expected_version(expected_version)
        _validate_idempotency_key(idempotency_key)
        _validate_reminder_patch_body(body)
        payload = await self._mutation_json(
            "edit_reminder",
            reminder_id=reminder_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body=dict(body),
        )
        return _validate_envelope(ReminderObjectEnvelope, payload)

    async def complete_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> ReminderObjectEnvelope:
        return await self._action_reminder(
            "complete_reminder",
            reminder_id=reminder_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    async def cancel_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> ReminderObjectEnvelope:
        return await self._action_reminder(
            "cancel_reminder",
            reminder_id=reminder_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    async def get_task(self, task_id: str) -> TaskObjectEnvelope:
        validate_uuid4(task_id, "planning.task_id")
        path = PLANNING_TASK_READ_ROUTE.replace("{task_id}", task_id)
        payload = await self._request_json("GET", path, expected_status={200})
        return _validate_envelope(TaskObjectEnvelope, payload)

    async def create_task(
        self,
        *,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> TaskObjectEnvelope:
        _validate_task_create_body(body)
        payload = await self._mutation_json(
            "create_task",
            idempotency_key=idempotency_key,
            body=body,
        )
        return _validate_envelope(TaskObjectEnvelope, payload)

    async def edit_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> TaskObjectEnvelope:
        validate_uuid4(task_id, "planning.task_id")
        _validate_expected_version(expected_version)
        _validate_task_patch_body(body)
        payload = await self._mutation_json(
            "edit_task",
            task_id=task_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body=body,
        )
        return _validate_envelope(TaskObjectEnvelope, payload)

    async def complete_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> TaskObjectEnvelope:
        return await self._action_task(
            "complete_task",
            task_id=task_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    async def archive_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> TaskObjectEnvelope:
        return await self._action_task(
            "archive_task",
            task_id=task_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    async def create_event(
        self,
        *,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> EventObjectEnvelope:
        _validate_event_create_body(body)
        payload = await self._mutation_json(
            "create_event",
            idempotency_key=idempotency_key,
            body=body,
        )
        return _validate_envelope(EventObjectEnvelope, payload)

    async def edit_event(
        self,
        *,
        event_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> EventObjectEnvelope:
        validate_uuid4(event_id, "planning.calendar_event_id")
        _validate_expected_version(expected_version)
        _validate_event_patch_body(body)
        payload = await self._mutation_json(
            "edit_event",
            event_id=event_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body=body,
        )
        return _validate_envelope(EventObjectEnvelope, payload)

    async def delete_event(
        self,
        *,
        event_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> EventObjectEnvelope:
        validate_uuid4(event_id, "planning.calendar_event_id")
        _validate_expected_version(expected_version)
        payload = await self._mutation_json(
            "delete_event",
            event_id=event_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body={},
        )
        return _validate_envelope(EventObjectEnvelope, payload)

    async def _action_task(
        self,
        route_name: Literal["complete_task", "archive_task"],
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> TaskObjectEnvelope:
        validate_uuid4(task_id, "planning.task_id")
        _validate_expected_version(expected_version)
        payload = await self._mutation_json(
            route_name,
            task_id=task_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body={},
        )
        return _validate_envelope(TaskObjectEnvelope, payload)

    async def _action_reminder(
        self,
        route_name: Literal["complete_reminder", "cancel_reminder"],
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> ReminderObjectEnvelope:
        validate_uuid4(reminder_id, "planning.reminder_id")
        _validate_expected_version(expected_version)
        payload = await self._mutation_json(
            route_name,
            reminder_id=reminder_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            body={},
        )
        return _validate_envelope(ReminderObjectEnvelope, payload)

    async def _mutation_json(
        self,
        route_name: str,
        *,
        idempotency_key: str,
        body: Mapping[str, Any],
        reminder_id: str | None = None,
        task_id: str | None = None,
        event_id: str | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        path = PLANNING_MUTATION_ROUTES.get(route_name)
        if path is None:
            raise PlanningUpstreamError("route_not_allowlisted")
        _validate_idempotency_key(idempotency_key)
        if "{reminder_id}" in path:
            if reminder_id is None:
                raise PlanningUpstreamError("mutation_target_missing")
            path = path.replace("{reminder_id}", reminder_id)
        if "{task_id}" in path:
            if task_id is None:
                raise PlanningUpstreamError("mutation_target_missing")
            path = path.replace("{task_id}", task_id)
        if "{event_id}" in path:
            if event_id is None:
                raise PlanningUpstreamError("mutation_target_missing")
            path = path.replace("{event_id}", event_id)
        method = PLANNING_MUTATION_METHODS.get(route_name)
        if method is None:
            raise PlanningUpstreamError("route_not_allowlisted")
        headers = {"Idempotency-Key": idempotency_key}
        if expected_version is not None:
            headers["If-Match"] = str(expected_version)
        return await self._request_json(
            method,
            path,
            json_body=dict(body),
            headers=headers,
            expected_status={200, 201},
            mutation=True,
        )

    async def _get_json(self, route_name: str, params: Mapping[str, str | int]) -> dict[str, Any]:
        path = PLANNING_ROUTES.get(route_name)
        if path is None:
            raise PlanningUpstreamError("route_not_allowlisted")
        return await self._request_json("GET", path, params=params, expected_status={200})

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        json_body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        expected_status: set[int],
        mutation: bool = False,
    ) -> dict[str, Any]:
        request_headers = {**self._headers, **(dict(headers) if headers else {})}
        try:
            async with self._client.stream(
                method,
                path,
                params=dict(params or {}),
                headers=request_headers,
                json=dict(json_body) if json_body is not None else None,
            ) as response:
                content_length = response.headers.get("content-length")
                if content_length is not None:
                    try:
                        if int(content_length) > self._response_limit_bytes:
                            raise PlanningUpstreamError("response_too_large")
                    except ValueError as exc:
                        raise PlanningUpstreamError("invalid_content_length") from exc
                if response.status_code not in expected_status:
                    raw_error = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw_error.extend(chunk)
                        if len(raw_error) > self._response_limit_bytes:
                            break
                    category = _upstream_error_category(bytes(raw_error), response.status_code, mutation=mutation)
                    raise PlanningUpstreamError(category, status_code=response.status_code)
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > self._response_limit_bytes:
                        raise PlanningUpstreamError("response_too_large")
        except PlanningUpstreamError:
            raise
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            raise PlanningUpstreamError("mutation_uncertain" if mutation else "transport_error") from exc
        try:
            payload = json.loads(
                bytes(raw).decode("utf-8"),
                object_pairs_hook=_duplicate_rejecting_object,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise PlanningUpstreamError("malformed_json") from exc
        if not isinstance(payload, dict):
            raise PlanningUpstreamError("malformed_json")
        return payload


def _validate_envelope(model, payload: dict[str, Any]):
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        category = "contract_mismatch"
        for error in exc.errors():
            if error.get("loc") and error["loc"][0] == "schemaVersion":
                category = "schema_version_mismatch"
                break
            if error.get("loc") and error["loc"][0] == "domain":
                category = "domain_mismatch"
                break
        raise PlanningUpstreamError(category) from exc


def _upstream_error_category(raw: bytes, status_code: int, *, mutation: bool) -> str:
    if mutation and status_code in {408, 429, 500, 502, 503, 504}:
        return "mutation_uncertain"
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_duplicate_rejecting_object)
        code = payload.get("error", {}).get("code") if isinstance(payload, dict) else None
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError):
        code = None
    if code in {"version_conflict", "idempotency_conflict", "idempotency_in_progress", "not_found", "validation_error", "event_not_local_only"}:
        return str(code)
    return "http_error"


def _validate_idempotency_key(value: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 0x20 for char in value):
        raise PlanningUpstreamError("idempotency_key_invalid")


def _validate_expected_version(value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise PlanningUpstreamError("expected_version_invalid")


def _validate_reminder_patch_body(body: Mapping[str, Any]) -> None:
    allowed = {"title", "notes", "due_at_utc", "timezone"}
    if not body or set(body) - allowed:
        raise PlanningUpstreamError("reminder_patch_invalid")
    if "title" in body and (not isinstance(body["title"], str) or not body["title"].strip() or len(body["title"]) > 500):
        raise PlanningUpstreamError("reminder_patch_invalid")
    if "notes" in body and (body["notes"] is not None and (not isinstance(body["notes"], str) or len(body["notes"]) > 4000)):
        raise PlanningUpstreamError("reminder_patch_invalid")
    if "due_at_utc" in body:
        try:
            validate_utc_timestamp(body["due_at_utc"], "planning.reminder.due_at_utc")
        except ValueError as exc:
            raise PlanningUpstreamError("reminder_patch_invalid") from exc
    if "timezone" in body:
        if not isinstance(body["timezone"], str) or not body["timezone"] or len(body["timezone"]) > 64:
            raise PlanningUpstreamError("reminder_patch_invalid")


def _validate_task_create_body(body: Mapping[str, Any]) -> None:
    allowed = {"title", "notes", "due_date", "due_time", "timezone", "priority", "project_id"}
    if set(body) - allowed or not body:
        raise PlanningUpstreamError("task_create_invalid")
    if not isinstance(body.get("title"), str) or not body["title"].strip() or len(body["title"]) > 500:
        raise PlanningUpstreamError("task_create_invalid")
    if body.get("priority") not in {"none", "low", "normal", "high"}:
        raise PlanningUpstreamError("task_create_invalid")
    _validate_task_optional_fields(body, allow_missing=False)


def _validate_task_patch_body(body: Mapping[str, Any]) -> None:
    allowed = {"title", "notes", "due_date", "due_time", "timezone", "priority", "project_id"}
    if not body or set(body) - allowed:
        raise PlanningUpstreamError("task_patch_invalid")
    if "title" in body and (not isinstance(body["title"], str) or not body["title"].strip() or len(body["title"]) > 500):
        raise PlanningUpstreamError("task_patch_invalid")
    if "notes" in body and body["notes"] is not None and (not isinstance(body["notes"], str) or len(body["notes"]) > 4000):
        raise PlanningUpstreamError("task_patch_invalid")
    if "priority" in body and body["priority"] not in {"none", "low", "normal", "high"}:
        raise PlanningUpstreamError("task_patch_invalid")
    _validate_task_optional_fields(body, allow_missing=True, category="task_patch_invalid")


def _validate_task_optional_fields(
    body: Mapping[str, Any],
    *,
    allow_missing: bool,
    category: str = "task_create_invalid",
) -> None:
    if "notes" in body and body["notes"] is not None and (not isinstance(body["notes"], str) or len(body["notes"]) > 4000):
        raise PlanningUpstreamError(category)
    if "project_id" in body and body["project_id"] is not None:
        try:
            validate_uuid4(body["project_id"], "planning.task.project_id")
        except ValueError as exc:
            raise PlanningUpstreamError(category) from exc
    if "due_date" in body and body["due_date"] is not None:
        try:
            validate_date(body["due_date"], "planning.task.due_date")
        except ValueError as exc:
            raise PlanningUpstreamError(category) from exc
    if "due_time" in body and body["due_time"] is not None:
        from .planning import validate_local_time

        try:
            validate_local_time(body["due_time"], "planning.task.due_time")
        except ValueError as exc:
            raise PlanningUpstreamError(category) from exc
    if "timezone" in body and body["timezone"] is not None:
        from .planning import validate_timezone

        try:
            validate_timezone(body["timezone"], "planning.task.timezone")
        except ValueError as exc:
            raise PlanningUpstreamError(category) from exc
    if not allow_missing and "priority" not in body:
        raise PlanningUpstreamError(category)


def _validate_event_create_body(body: Mapping[str, Any]) -> None:
    allowed = {
        "title", "notes", "location", "all_day", "timezone",
        "start_at_utc", "end_at_utc", "start_date", "end_date_exclusive",
    }
    if not body or set(body) - allowed:
        raise PlanningUpstreamError("event_create_invalid")
    if not isinstance(body.get("title"), str) or not body["title"].strip() or len(body["title"]) > 500:
        raise PlanningUpstreamError("event_create_invalid")
    if not isinstance(body.get("all_day"), bool) or not isinstance(body.get("timezone"), str):
        raise PlanningUpstreamError("event_create_invalid")
    _validate_event_shape(body, category="event_create_invalid", require_shape=True)


def _validate_event_patch_body(body: Mapping[str, Any]) -> None:
    allowed = {
        "title", "notes", "location", "all_day", "timezone",
        "start_at_utc", "end_at_utc", "start_date", "end_date_exclusive",
    }
    if not body or set(body) - allowed:
        raise PlanningUpstreamError("event_patch_invalid")
    if "title" in body and (not isinstance(body["title"], str) or not body["title"].strip() or len(body["title"]) > 500):
        raise PlanningUpstreamError("event_patch_invalid")
    if "notes" in body and body["notes"] is not None and (not isinstance(body["notes"], str) or len(body["notes"]) > 4000):
        raise PlanningUpstreamError("event_patch_invalid")
    if "location" in body and body["location"] is not None and (not isinstance(body["location"], str) or len(body["location"]) > 1000):
        raise PlanningUpstreamError("event_patch_invalid")
    if "all_day" in body and not isinstance(body["all_day"], bool):
        raise PlanningUpstreamError("event_patch_invalid")
    if "timezone" in body and (not isinstance(body["timezone"], str) or not body["timezone"] or len(body["timezone"]) > 64):
        raise PlanningUpstreamError("event_patch_invalid")
    _validate_event_shape(body, category="event_patch_invalid", require_shape=False)


def _validate_event_shape(body: Mapping[str, Any], *, category: str, require_shape: bool) -> None:
    temporal_fields = {"all_day", "timezone", "start_at_utc", "end_at_utc", "start_date", "end_date_exclusive"}
    if not require_shape and not temporal_fields.intersection(body):
        return
    if require_shape and not temporal_fields <= set(body):
        raise PlanningUpstreamError(category)
    if not isinstance(body.get("all_day"), bool) or not isinstance(body.get("timezone"), str):
        raise PlanningUpstreamError(category)
    if body["all_day"]:
        if body.get("start_date") is None or body.get("end_date_exclusive") is None:
            raise PlanningUpstreamError(category)
        if body.get("start_at_utc") is not None or body.get("end_at_utc") is not None:
            raise PlanningUpstreamError(category)
    else:
        if body.get("start_at_utc") is None or body.get("end_at_utc") is None:
            raise PlanningUpstreamError(category)
        if body.get("start_date") is not None or body.get("end_date_exclusive") is not None:
            raise PlanningUpstreamError(category)
    for field in ("start_at_utc", "end_at_utc"):
        if field in body and body[field] is not None:
            try:
                validate_utc_timestamp(body[field], f"planning.calendar_event.{field}")
            except ValueError as exc:
                raise PlanningUpstreamError(category) from exc
    for field in ("start_date", "end_date_exclusive"):
        if field in body and body[field] is not None:
            try:
                validate_date(body[field], f"planning.calendar_event.{field}")
            except ValueError as exc:
                raise PlanningUpstreamError(category) from exc


def _event_identity(event: UpstreamCalendarEvent) -> PlanningCalendarIdentity:
    """Legacy-Alice fallback identity when the additive sources field is absent."""

    if event.provider_id is None and event.provider_calendar_id is None:
        return PlanningCalendarIdentity(
            providerId="local-planning",
            providerLabel="Local Planning",
            calendarId="local",
            calendarLabel="Локальный",
        )
    return PlanningCalendarIdentity(
        providerId=event.source,
        providerLabel=source_label(event.source),
        calendarId="external",
        calendarLabel="Внешний календарь",
    )


def _browser_source_id(source: UpstreamPlanningSource) -> str:
    if source.sourceType == "native_planning":
        return "native-planning"
    digest = hashlib.sha256(
        f"planning-source\0{source.provider}\0{source.accountId}".encode("utf-8")
    ).hexdigest()[:24]
    return f"external-{source.provider}-{digest}"


def _browser_calendar_id(source: UpstreamPlanningSource, calendar_id: str) -> str:
    digest = hashlib.sha256(
        f"planning-calendar\0{_browser_source_id(source)}\0{calendar_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"calendar-{digest}"


def _browser_source_label(source: UpstreamPlanningSource) -> str:
    return "Local Planning" if source.provider == "local" else "iCloud"
def _fixed_list_query(
    values: Mapping[str, str | int | None],
    *,
    allowed: set[str],
) -> dict[str, str | int]:
    if set(values) - allowed:
        raise PlanningUpstreamError("query_not_allowlisted")
    result: dict[str, str | int] = {}
    for key, value in values.items():
        if value is None:
            continue
        if key in {"limit", "offset"}:
            if isinstance(value, bool) or not isinstance(value, int):
                raise PlanningUpstreamError("query_invalid")
            if key == "limit" and not 1 <= value <= PLANNING_MAX_UPSTREAM_PAGE:
                raise PlanningUpstreamError("query_limit_out_of_range")
            if key == "offset" and not 0 <= value <= 10_000:
                raise PlanningUpstreamError("query_offset_out_of_range")
        elif not isinstance(value, str) or len(value) > 128:
            raise PlanningUpstreamError("query_invalid")
        result[key] = value
    return result


def _validate_range(from_utc: str, to_utc: str) -> None:
    validate_utc_timestamp(from_utc, "planning.from")
    validate_utc_timestamp(to_utc, "planning.to")
    start = timestamp_datetime(from_utc)
    end = timestamp_datetime(to_utc)
    if end <= start or end - start > timedelta(days=366):
        raise PlanningUpstreamError("query_range_out_of_range")


class PlanningAdapter:
    """One coordinated Planning adapter with bounded last-good read state."""

    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        client: PlanningClient | None = None,
        cache: PlanningProjectionCache | None = None,
        monotonic_clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] | None = None,
        random_fn: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_change: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._settings = settings
        self._enabled = bool(settings.panel_planning_enabled)
        self._clock = monotonic_clock
        self._wall_clock = wall_clock or (lambda: datetime.now(timezone.utc))
        self._random = random_fn or (lambda: 0.5)
        self._sleep = sleep
        self._on_change = on_change
        self._task: asyncio.Task[None] | None = None
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._projection: PlanningProjection | None = None
        self._last_good: PlanningProjection | None = None
        self._last_success_at: float | None = None
        self._last_status: StatusEnvelope | None = None
        self._last_status_at: float | None = None
        self._last_status_attempt_at: float | None = None
        self._status_refresh_requested = False
        self._domains_current = False
        self._cache_loaded = False
        self._upstream_connected = False
        self._failure_count = 0
        self._calendar_source_refresh_task: asyncio.Task[PlanningCalendarSourcesRefresh] | None = None

        if not self._enabled:
            self._client = None
            self._cache = None
            return
        self._client = client or PlanningClient(
            base_url=settings.panel_planning_base_url,
            internal_secret=settings.panel_planning_internal_secret,
            panel_secret=settings.panel_planning_secret,
            timeout_seconds=settings.http_request_timeout_seconds,
            response_limit_bytes=settings.panel_planning_response_limit_bytes,
            transport=transport,
        )
        self._cache = cache or PlanningProjectionCache(
            settings.panel_planning_cache_path,
            max_bytes=max(4096, settings.panel_planning_response_limit_bytes),
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def status_requests_due(self) -> bool:
        return self._status_due()

    @property
    def projection(self) -> PlanningProjection | None:
        return self._projection.model_copy(deep=True) if self._projection else None

    @property
    def snapshot(self) -> PlanningProjection | None:
        """Backward-friendly name for callers that treat adapters as snapshots."""

        return self.projection

    def status_projection(self) -> PlanningStatusProjection | None:
        current = self._projection
        if current is None:
            return None
        return status_projection(current)

    @property
    def reminder_mutations_enabled(self) -> bool:
        """The server-side B4 feature gate is deliberately off by default."""

        return bool(getattr(self._settings, "panel_planning_reminder_mutations_enabled", False))

    def reminder_mutation_allowed(self, action: Literal["create", "update", "complete", "cancel"]) -> bool:
        if not self.reminder_mutations_enabled or self._last_status is None:
            return False
        if _status_is_degraded(self._last_status):
            return False
        return action in set(self._last_status.capabilities.reminders)

    @property
    def task_mutations_enabled(self) -> bool:
        """The server-side B4.2 writer gate is deliberately off by default."""

        return bool(getattr(self._settings, "panel_planning_task_mutations_enabled", False))

    def task_mutation_allowed(self, action: Literal["create", "update", "complete", "archive"]) -> bool:
        if not self.task_mutations_enabled or self._last_status is None:
            return False
        if _status_is_degraded(self._last_status):
            return False
        return action in set(self._last_status.capabilities.tasks)

    @property
    def calendar_mutations_enabled(self) -> bool:
        """The B4.3 writer gate is deliberately false unless explicitly enabled."""

        return bool(getattr(self._settings, "panel_planning_calendar_mutations_enabled", False))

    def calendar_mutation_allowed(self, action: Literal["create", "update", "delete"]) -> bool:
        if not self.calendar_mutations_enabled or self._last_status is None:
            return False
        if _status_is_degraded(self._last_status):
            return False
        return action in set(self._last_status.capabilities.events)

    def set_on_change(self, callback: Callable[[], Awaitable[None]] | None) -> None:
        self._on_change = callback

    async def start(self) -> None:
        if not self._enabled:
            return
        if self.running:
            return
        self._load_cache()
        try:
            await self.refresh_status(force=True)
        except PlanningUpstreamError as exc:
            self._record_failure("status", exc)
        try:
            await self.refresh()
        except PlanningUpstreamError as exc:
            self._record_failure("domain", exc)
        if not self.running:
            self._task = asyncio.create_task(self._poll(), name="panel-planning-poll")

    async def close(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            current_loop = asyncio.get_running_loop()
            task_loop = task.get_loop()
            if task_loop is current_loop:
                await asyncio.gather(task, return_exceptions=True)
        if self._client is not None:
            await self._client.close()

    async def refresh(self) -> bool:
        if not self._enabled:
            return False
        domain_ok = await self.refresh_domains()
        if self._status_due() or (domain_ok and self._status_refresh_requested):
            try:
                await self.refresh_status(force=True)
            except PlanningUpstreamError as exc:
                self._record_failure("status", exc)
                if self._projection is not None:
                    await self._set_projection(
                        self._projection.model_copy(
                            update={
                                "generatedAt": self._now_text(),
                                "sourceStatus": (
                                    "degraded"
                                    if self._domains_current
                                    else self._failure_source_status()
                                ),
                            },
                            deep=True,
                        )
                    )
                domain_ok = False
        return domain_ok

    async def refresh_status(self, *, force: bool = False) -> bool:
        if not self._enabled or self._client is None:
            return False
        if not force and not self._status_due():
            return True
        self._last_status_attempt_at = self._clock()
        try:
            status = await self._client.status()
        except PlanningUpstreamError:
            self._status_refresh_requested = False
            raise
        self._last_status = status
        self._last_status_at = self._clock()
        self._status_refresh_requested = False
        current = self._projection or empty_planning_projection(
            generated_at=self._now_text(),
            source_status=self._status_source_status(current=self._domains_current),
        )
        updates: dict[str, Any] = {
            "generatedAt": self._now_text(),
            "sourceStatus": self._status_source_status(current=self._domains_current),
            "capabilities": PlanningCapabilities(**self._effective_capabilities()),
        }
        if status.sources is not None:
            updates["providerStatuses"] = self._project_sources(status.sources)
        await self._set_projection(
            current.model_copy(
                update=updates,
                deep=True,
            )
        )
        return True

    async def refresh_calendar_sources(self) -> PlanningCalendarSourcesRefresh:
        """Refresh provider discovery, then reload only canonical source metadata."""

        if self._calendar_source_refresh_task is not None and not self._calendar_source_refresh_task.done():
            return await self._calendar_source_refresh_task
        task = asyncio.create_task(
            self._refresh_calendar_sources_once(),
            name="panel-planning-calendar-source-refresh",
        )
        self._calendar_source_refresh_task = task
        try:
            return await task
        finally:
            if self._calendar_source_refresh_task is task:
                self._calendar_source_refresh_task = None

    async def _refresh_calendar_sources_once(self) -> PlanningCalendarSourcesRefresh:
        try:
            result = await self._live_client().refresh_calendar_sources()
        except (PlanningReadUnavailable, PlanningUpstreamError):
            try:
                await self.refresh_status(force=True)
            except PlanningUpstreamError:
                pass
            raise
        await self.refresh_status(force=True)
        return result

    async def refresh_domains(self) -> bool:
        if not self._enabled or self._client is None:
            return False
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        async with self._lock:
            now = self._wall_now()
            windows = self._windows(now)
            results = await asyncio.gather(
                self._client.reminders(
                    state="pending",
                    from_utc=windows["reminder_overdue_from"],
                    to_utc=windows["now"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                self._client.reminders(
                    state="due",
                    from_utc=windows["reminder_overdue_from"],
                    to_utc=windows["now"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                self._client.reminders(
                    state="pending",
                    from_utc=windows["now"],
                    to_utc=windows["reminder_upcoming_to"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                self._client.reminders(
                    state="due",
                    from_utc=windows["now"],
                    to_utc=windows["reminder_upcoming_to"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                *(
                    self._client.reminders(
                        state="due",
                        limit=PLANNING_MAX_UPSTREAM_PAGE,
                        offset=page * PLANNING_MAX_UPSTREAM_PAGE,
                    )
                    for page in range(PLANNING_FAILURE_SCAN_MAX_PAGES)
                ),
                self._client.tasks(view="today", limit=PLANNING_PAGE_LIMIT, offset=0),
                self._client.tasks(view="overdue", limit=PLANNING_PAGE_LIMIT, offset=0),
                self._client.tasks(view="upcoming", limit=PLANNING_PAGE_LIMIT, offset=0),
                self._client.events(
                    from_utc=windows["today_from"],
                    to_utc=windows["today_to"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                self._client.events(
                    from_utc=windows["upcoming_from"],
                    to_utc=windows["upcoming_to"],
                    limit=PLANNING_PAGE_LIMIT,
                    offset=0,
                ),
                self._client.projects(limit=PLANNING_PAGE_LIMIT, offset=0),
                return_exceptions=True,
            )
            errors = [result for result in results if isinstance(result, Exception)]
            success_count = len(results) - len(errors)
            previous = self._last_good or self._projection
            upstream_sources = self._sources_from_results(results)
            mapped = self._mapped_domains(results, previous, upstream_sources)
            all_success = not errors
            provider_statuses = (
                self._project_sources(upstream_sources)
                if all_success or upstream_sources is not None
                else self._failure_provider_statuses(previous)
            )
            if all_success:
                self._failure_count = 0
                self._last_success_at = self._clock()
                self._domains_current = True
                self._cache_loaded = False
                source_status = self._status_source_status(current=True)
                projection = self._projection_from_domains(
                    mapped,
                    generated_at=self._now_text(now),
                    source_status=source_status,
                    last_synced_at=self._max_synced_at(results),
                    provider_statuses=provider_statuses,
                )
                self._last_good = projection.model_copy(deep=True)
                self._upstream_connected = True
                if self._cache is not None:
                    try:
                        self._cache.store(projection, saved_at=self._now_text(now))
                    except (OSError, ValueError):
                        LOGGER.warning("planning_cache_store_failed category=bounded_write")
            else:
                self._failure_count += 1
                self._upstream_connected = False
                self._domains_current = False
                if success_count == 0:
                    self._status_refresh_requested = True
                source_status = (
                    "degraded"
                    if success_count > 0
                    else self._failure_source_status()
                )
                projection = self._projection_from_domains(
                    mapped,
                    generated_at=self._now_text(now),
                    source_status=source_status,
                    last_synced_at=(
                        self._max_synced_at(results)
                        if success_count > 0
                        else self._last_synced_at(previous)
                    ),
                    provider_statuses=provider_statuses,
                )
                self._record_domain_errors(errors)
            await self._set_projection(projection)
            return all_success

    def read_status(self) -> PlanningStatusProjection:
        projection = self._read_projection()
        return status_projection(projection)

    async def parse_preview(
        self,
        *,
        text: str,
        reference_time_utc: str,
        timezone: str,
    ) -> PlanningParsePreview:
        return await self._live_client().parse_preview(
            text=text,
            reference_time_utc=reference_time_utc,
            timezone=timezone,
        )

    async def create_reminder(
        self,
        *,
        idempotency_key: str,
        title: str,
        notes: str | None,
        due_at_utc: str,
        timezone: str,
    ) -> PlanningObjectEnvelope:
        return self._object_readback(
            await self._live_client().create_reminder(
                idempotency_key=idempotency_key,
                title=title,
                notes=notes,
                due_at_utc=due_at_utc,
                timezone=timezone,
            )
        )

    async def edit_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> PlanningObjectEnvelope:
        return self._object_readback(
            await self._live_client().edit_reminder(
                reminder_id=reminder_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                body=body,
            )
        )

    async def complete_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> PlanningObjectEnvelope:
        return self._object_readback(
            await self._live_client().complete_reminder(
                reminder_id=reminder_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
            )
        )

    async def cancel_reminder(
        self,
        *,
        reminder_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> PlanningObjectEnvelope:
        return self._object_readback(
            await self._live_client().cancel_reminder(
                reminder_id=reminder_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
            )
        )

    async def read_task_by_id(self, *, task_id: str) -> PlanningTaskObjectEnvelope:
        return self._task_object_readback(await self._live_client().get_task(task_id))

    async def read_event_by_id(self, *, event_id: str) -> PlanningEventObjectEnvelope:
        return self._event_object_readback(await self._live_client().get_event(event_id))

    async def create_task(
        self,
        *,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> PlanningTaskObjectEnvelope:
        return self._task_object_readback(
            await self._live_client().create_task(
                idempotency_key=idempotency_key,
                body=body,
            )
        )

    async def edit_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> PlanningTaskObjectEnvelope:
        return self._task_object_readback(
            await self._live_client().edit_task(
                task_id=task_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                body=body,
            )
        )

    async def complete_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> PlanningTaskObjectEnvelope:
        return self._task_object_readback(
            await self._live_client().complete_task(
                task_id=task_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
            )
        )

    async def archive_task(
        self,
        *,
        task_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> PlanningTaskObjectEnvelope:
        return self._task_object_readback(
            await self._live_client().archive_task(
                task_id=task_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
            )
        )

    async def create_event(
        self,
        *,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> PlanningEventObjectEnvelope:
        return self._event_object_readback(
            await self._live_client().create_event(idempotency_key=idempotency_key, body=body)
        )

    async def edit_event(
        self,
        *,
        event_id: str,
        expected_version: int,
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> PlanningEventObjectEnvelope:
        return self._event_object_readback(
            await self._live_client().edit_event(
                event_id=event_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                body=body,
            )
        )

    async def delete_event(
        self,
        *,
        event_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> PlanningEventObjectEnvelope:
        return self._event_object_readback(
            await self._live_client().delete_event(
                event_id=event_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
            )
        )

    async def read_reminders(
        self,
        *,
        state: str | None,
        from_utc: str | None,
        to_utc: str | None,
        limit: int,
        offset: int,
    ) -> PlanningReadEnvelope:
        client = self._live_client()
        envelope = await client.reminders(
            state=state,
            from_utc=from_utc,
            to_utc=to_utc,
            limit=limit,
            offset=offset,
        )
        return self._read_upstream_envelope(envelope)

    async def read_reminder_view(
        self,
        *,
        view: Literal["upcoming", "overdue", "delivery"],
        limit: int,
        offset: int,
    ) -> PlanningReadEnvelope:
        """Build one bounded, truthful reminder monitor view from fixed reads.

        AliceTG_Bot exposes lifecycle state, not the UI's derived delivery view.
        The adapter therefore scans successive fixed 100-row A4 pages, up to two
        pages per lifecycle source (200 rows per source, 400 rows for a composed
        pending+due view). Delivery exhausts its single due source before sorting,
        because the upstream due-time order cannot prove the derived delivery
        rank. Upcoming/overdue use the more efficient due-time prefix proof. If
        either proof needs another page beyond the budget, the read fails closed
        with a dedicated bounded-scan error.
        """

        if view not in {"upcoming", "overdue", "delivery"}:
            raise PlanningUpstreamError("reminder_view_out_of_range")
        client = self._live_client()
        now = self._wall_now()
        windows = self._windows(now)
        if view == "delivery":
            sources = [
                _ReminderScanSource(state="due")
            ]
        else:
            from_utc = (
                windows["now"]
                if view == "upcoming"
                else windows["reminder_overdue_from"]
            )
            to_utc = (
                windows["reminder_upcoming_to"]
                if view == "upcoming"
                else windows["now"]
            )
            sources = [
                _ReminderScanSource(
                    state=state,
                    from_utc=from_utc,
                    to_utc=to_utc,
                )
                for state in ("pending", "due")
            ]

        page_end = offset + limit
        await self._scan_reminder_sources(
            client,
            sources,
            view=view,
            page_end=page_end,
        )
        ordered_source = self._ordered_reminder_items(view, sources)
        mapped = self._map_reminders(ordered_source)
        page = mapped[offset : offset + limit]
        envelopes = [
            envelope
            for source in sources
            for envelope in source.envelopes
        ]
        last_synced_at = self._max_synced_at(envelopes)
        return PlanningReadEnvelope(
            schemaVersion="planning.panel.v1",
            kind="list",
            domain="reminder",
            generatedAt=self._now_text(now),
            sourceStatus=self._status_source_status(current=True),
            lastSyncedAt=last_synced_at,
            staleAfter=(
                self._now_text(
                    timestamp_datetime(last_synced_at)
                    + timedelta(seconds=self._settings.panel_planning_stale_after_seconds)
                )
                if last_synced_at is not None
                else None
            ),
            items=page,
            limit=limit,
            offset=offset,
            count=len(page),
            hasMore=offset + len(page) < len(mapped),
            sources=self._project_sources(self._sources_from_results(envelopes)),
        )

    async def _scan_reminder_sources(
        self,
        client: PlanningClient,
        sources: list[_ReminderScanSource],
        *,
        view: Literal["upcoming", "overdue", "delivery"],
        page_end: int,
    ) -> None:
        """Read only enough fixed pages to prove one composed page.

        Delivery is the exception to the prefix strategy: its due source is
        ordered by due time, while the derived view promotes delivery state, so
        the source must be exhausted before any page can be globally proven.
        Every non-exhausted source must contribute at least ``page_end`` raw
        rows before its prefix can prove the composed ordering. A source that
        is already exhausted is fully known. When the requested page ends at
        the current unique boundary, another unique row or exhaustion is also
        required to prove ``hasMore``; otherwise this method fails closed at
        the fixed two-page budget.
        """

        if view == "delivery":
            source = sources[0]
            while not source.exhausted:
                if source.pages >= PLANNING_REMINDER_SCAN_MAX_PAGES_PER_SOURCE:
                    raise PlanningBoundedScanError()
                await self._read_next_reminder_source_page(client, source)
                if sum(len(source.items) for source in sources) > PLANNING_REMINDER_SCAN_MAX_ROWS:
                    raise PlanningBoundedScanError()
            return

        while True:
            ordered = self._ordered_reminder_items_from_sources(sources, view=view)
            all_exhausted = all(source.exhausted for source in sources)
            prefixes_proven = all(
                source.exhausted or len(source.items) >= page_end
                for source in sources
            )
            has_more_proven = len(ordered) > page_end or all_exhausted
            if all_exhausted or (prefixes_proven and has_more_proven):
                return

            active_sources = [source for source in sources if not source.exhausted]
            if not active_sources or any(
                source.pages >= PLANNING_REMINDER_SCAN_MAX_PAGES_PER_SOURCE
                for source in active_sources
            ):
                raise PlanningBoundedScanError()

            await asyncio.gather(
                *(self._read_next_reminder_source_page(client, source) for source in active_sources)
            )
            if sum(len(source.items) for source in sources) > PLANNING_REMINDER_SCAN_MAX_ROWS:
                raise PlanningBoundedScanError()

    async def _read_next_reminder_source_page(
        self,
        client: PlanningClient,
        source: _ReminderScanSource,
    ) -> None:
        if source.exhausted:
            return
        if source.pages >= PLANNING_REMINDER_SCAN_MAX_PAGES_PER_SOURCE:
            raise PlanningBoundedScanError()
        page_offset = source.next_offset
        envelope = await client.reminders(
            state=source.state,
            from_utc=source.from_utc,
            to_utc=source.to_utc,
            limit=PLANNING_MAX_UPSTREAM_PAGE,
            offset=page_offset,
        )
        source.pages += 1
        source.envelopes.append(envelope)
        source.items.extend(envelope.items)
        if len(source.items) > PLANNING_REMINDER_SCAN_MAX_ROWS_PER_SOURCE:
            raise PlanningBoundedScanError()
        if not envelope.pagination.has_more:
            source.exhausted = True
            return
        next_offset = envelope.pagination.next_offset
        if next_offset is None or next_offset <= page_offset:
            raise PlanningUpstreamError("reminder_view_pagination_invalid")
        source.next_offset = next_offset

    def _ordered_reminder_items(
        self,
        view: Literal["upcoming", "overdue", "delivery"],
        sources: list[_ReminderScanSource],
    ) -> list[UpstreamReminder]:
        return self._ordered_reminder_items_from_sources(sources, view=view)

    @staticmethod
    def _ordered_reminder_items_from_sources(
        sources: list[_ReminderScanSource],
        *,
        view: Literal["upcoming", "overdue", "delivery"],
    ) -> list[UpstreamReminder]:
        selected_source: list[UpstreamReminder] = []
        for source in sources:
            for item in source.items:
                if view == "delivery":
                    if item.status == "due" and item.delivery_state in {"queued", "retrying", "failed"}:
                        selected_source.append(item)
                elif item.status in {"pending", "due"}:
                    selected_source.append(item)

        unique_source: dict[str, UpstreamReminder] = {}
        for item in selected_source:
            unique_source.setdefault(item.id, item)
        if view == "delivery":
            delivery_rank = {"failed": 0, "retrying": 1, "queued": 2}
            return sorted(
                unique_source.values(),
                key=lambda item: (
                    delivery_rank.get(item.delivery_state, 3),
                    item.due_at_utc,
                    item.id,
                ),
            )
        return sorted(
            unique_source.values(),
            key=lambda item: (item.due_at_utc, item.id),
        )

    async def read_tasks(
        self,
        *,
        view: Literal["today", "overdue", "upcoming"],
        project_id: str | None,
        limit: int,
        offset: int,
    ) -> PlanningReadEnvelope:
        client = self._live_client()
        envelope = await client.tasks(
            view=view,
            project_id=project_id,
            limit=limit,
            offset=offset,
        )
        return self._read_upstream_envelope(envelope)

    async def read_events(
        self,
        *,
        from_utc: str,
        to_utc: str,
        limit: int,
        offset: int,
    ) -> PlanningReadEnvelope:
        _validate_range(from_utc, to_utc)
        envelope = await self._live_client().events(
            from_utc=from_utc,
            to_utc=to_utc,
            limit=limit,
            offset=offset,
        )
        return self._read_upstream_envelope(envelope)

    async def read_projects(self, *, limit: int, offset: int) -> PlanningReadEnvelope:
        envelope = await self._live_client().projects(limit=limit, offset=offset)
        return self._read_upstream_envelope(envelope)

    async def _poll(self) -> None:
        failures = 0
        delay = self.next_poll_delay(0)
        while True:
            try:
                await self._sleep(delay)
                ok = await self.refresh()
                failures = 0 if ok else failures + 1
                delay = self.next_poll_delay(failures)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                LOGGER.warning(
                    "planning_poll_failed category=%s retry_seconds=%s",
                    _error_category(exc),
                    round(self.next_poll_delay(failures), 3),
                )
                delay = self.next_poll_delay(failures)

    def next_poll_delay(self, failures: int) -> float:
        failures = max(0, int(failures))
        base = float(self._settings.panel_planning_refresh_seconds)
        if failures:
            base = min(
                base * (2 ** min(failures - 1, 8)),
                float(self._settings.panel_planning_max_backoff_seconds),
            )
        sample = min(1.0, max(0.0, float(self._random())))
        jittered = base * (1 + ((sample * 2) - 1) * PLANNING_JITTER_RATIO)
        return min(float(self._settings.panel_planning_max_backoff_seconds), max(0.01, jittered))

    def _load_cache(self) -> None:
        if self._cache is None:
            return
        cached = self._cache.load()
        if cached is None:
            return
        now = self._wall_now()
        age = max(0.0, (now - timestamp_datetime(cached.lastSyncedAt)).total_seconds()) if cached.lastSyncedAt else float("inf")
        self._last_good = cached.model_copy(deep=True)
        self._cache_loaded = True
        self._last_success_at = self._clock() - age if age != float("inf") else None
        self._projection = cached.model_copy(
            update={
                "generatedAt": self._now_text(now),
                "sourceStatus": self._cache_source_status(age),
            },
            deep=True,
        )

    def _read_projection(self) -> PlanningProjection:
        if self._projection is not None:
            return self._projection.model_copy(deep=True)
        return empty_planning_projection(
            generated_at=self._now_text(),
            source_status="offline",
        )

    def _sources_from_results(self, results: list[Any]) -> list[UpstreamPlanningSource] | None:
        """Return only source metadata observed in this domain refresh batch."""

        for result in results:
            if not isinstance(result, PlanningListEnvelope):
                continue
            if result.sources is not None:
                return result.sources
        return None

    def _project_sources(
        self,
        sources: list[UpstreamPlanningSource] | None,
    ) -> list[PlanningCalendarSource]:
        if sources is None:
            observed = self._now_text(self._wall_now())
            return [
                PlanningCalendarSource(
                    id="native-planning",
                    kind="native",
                    provider="local",
                    label="Local Planning",
                    status="current",
                    configured=True,
                    lastSyncedAt=None,
                    observedAt=observed,
                    calendars=[],
                )
            ]
        projected: list[PlanningCalendarSource] = []
        for source in sources:
            source_id = _browser_source_id(source)
            display_counts: dict[str, int] = {}
            for calendar in source.calendars:
                display_counts[calendar.displayName] = display_counts.get(calendar.displayName, 0) + 1
            projected_calendars: list[PlanningCalendarSourceCalendar] = []
            for calendar in source.calendars:
                browser_calendar_id = _browser_calendar_id(source, calendar.calendarId)
                label = calendar.displayName
                if display_counts[calendar.displayName] > 1:
                    label = f"{label} · #{browser_calendar_id[-6:]}"
                projected_calendars.append(
                    PlanningCalendarSourceCalendar(
                        id=browser_calendar_id,
                        label=label,
                        color=calendar.color,
                        enabled=calendar.enabled,
                        status=calendar.status,
                        lastSyncedAt=calendar.lastSyncedAt,
                        observedAt=calendar.observedAt,
                    )
                )
            projected.append(
                PlanningCalendarSource(
                    id=source_id,
                    kind="native" if source.sourceType == "native_planning" else "external",
                    provider=source.provider,
                    label=_browser_source_label(source),
                    status=source.status,
                    configured=(
                        source.status != "not_configured"
                        and source.accountId != "not-configured"
                    ),
                    lastSyncedAt=source.lastSyncedAt,
                    observedAt=source.observedAt,
                    calendars=projected_calendars,
                )
            )
        return projected

    def _failure_provider_statuses(
        self,
        previous: PlanningProjection | None,
    ) -> list[PlanningCalendarSource]:
        if previous is None:
            return [
                PlanningCalendarSource(
                    id="native-planning",
                    kind="native",
                    provider="local",
                    label="Local Planning",
                    status="error",
                    configured=True,
                    lastSyncedAt=None,
                    observedAt=self._now_text(self._wall_now()),
                    calendars=[],
                )
            ]
        statuses: list[PlanningCalendarSource] = []
        for source in previous.providerStatuses:
            if source.status == "current":
                source = source.model_copy(
                    update={"status": "stale" if source.lastSyncedAt else "error"},
                    deep=True,
                )
            statuses.append(source)
        return statuses

    def _mapped_domains(
        self,
        results: list[Any],
        previous: PlanningProjection | None,
        upstream_sources: list[UpstreamPlanningSource] | None,
    ) -> dict[str, Any]:
        previous = previous or empty_planning_projection(
            generated_at=self._now_text(),
            source_status="offline",
        )
        reminder_overdue = self._map_active_reminders(
            results[0:2],
            previous.reminders.overdue,
        )
        reminder_upcoming = self._map_active_reminders(
            results[2:4],
            previous.reminders.upcoming,
        )
        failure_items = self._map_failure_scan(
            results[4 : 4 + PLANNING_FAILURE_SCAN_MAX_PAGES],
            previous.reminders.deliveryFailures,
        )
        task_index = 4 + PLANNING_FAILURE_SCAN_MAX_PAGES
        task_today = self._map_tasks(results[task_index], previous.tasks.today)
        task_overdue = self._map_tasks(results[task_index + 1], previous.tasks.overdue)
        task_upcoming = self._map_tasks(results[task_index + 2], previous.tasks.upcoming)
        event_today = self._map_events(results[task_index + 3], previous.calendar.today, upstream_sources)
        event_upcoming = self._map_events(results[task_index + 4], previous.calendar.upcoming, upstream_sources)
        projects = self._map_projects(results[task_index + 5], previous.tasks.projects)
        events = [*event_today, *event_upcoming]
        return {
            "reminders": {
                "upcoming": _bounded_unique(reminder_upcoming),
                "overdue": _bounded_unique(reminder_overdue),
                "deliveryFailures": _bounded_unique(failure_items),
            },
            "tasks": {
                "today": _bounded_unique(task_today),
                "overdue": _bounded_unique(task_overdue),
                "upcoming": _bounded_unique(task_upcoming),
                "projects": _bounded_unique(projects),
            },
            "calendar": {
                "today": _bounded_unique(event_today),
                "upcoming": _bounded_unique(event_upcoming),
                "conflicts": _event_conflicts(events, timezone_name=self._settings.panel_planning_timezone),
            },
        }

    @staticmethod
    def _map_reminders(items: list[UpstreamReminder]) -> list[ReminderProjection]:
        return [
            ReminderProjection(
                id=item.id,
                version=item.version,
                source=item.source,
                sourceLabel=source_label(item.source),
                title=item.title,
                dueAtUtc=item.due_at_utc,
                timezone=item.timezone,
                status=item.status,
                deliveryState=item.delivery_state,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in items
        ]

    @classmethod
    def _map_active_reminders(
        cls,
        results: list[Any],
        fallback: list[ReminderProjection],
    ) -> list[ReminderProjection]:
        if not all(isinstance(result, ReminderListEnvelope) for result in results):
            return list(fallback)
        items = [
            item
            for result in results
            for item in result.items
            if item.status in {"pending", "due"}
        ]
        return cls._map_reminders(items)

    @classmethod
    def _map_failure_scan(
        cls,
        results: list[Any],
        fallback: list[ReminderProjection],
    ) -> list[ReminderProjection]:
        if not results or not all(isinstance(result, ReminderListEnvelope) for result in results):
            return list(fallback)
        items = [
            item
            for result in results
            for item in result.items
            if item.status == "due"
            and item.delivery_state == "failed"
            and item.final_failure_at is not None
        ]
        return cls._map_reminders(items)

    @staticmethod
    def _map_tasks(
        result: Any,
        fallback: list[TaskProjection],
    ) -> list[TaskProjection]:
        if not isinstance(result, TaskListEnvelope):
            return list(fallback)
        return [
            TaskProjection(
                id=item.id,
                version=item.version,
                source=item.source,
                sourceLabel=source_label(item.source),
                title=item.title,
                notes=item.notes,
                priority=item.priority,
                status=item.status,
                dueDate=item.due_date,
                dueTime=item.due_time,
                timezone=item.timezone,
                projectId=item.project_id,
                sourceRef=item.source_ref,
                completedAt=item.completed_at,
                archivedAt=item.archived_at,
                deletedAt=item.deleted_at,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in result.items
        ]

    def _map_events(
        self,
        result: Any,
        fallback: list[CalendarEventProjection],
        upstream_sources: list[UpstreamPlanningSource] | None,
    ) -> list[CalendarEventProjection]:
        if not isinstance(result, EventListEnvelope):
            return list(fallback)
        return [
            CalendarEventProjection(
                id=item.id,
                version=item.version,
                source=item.source,
                sourceLabel=source_label(item.source),
                calendarIdentity=self._event_identity(item, upstream_sources),
                title=item.title,
                notes=item.notes,
                location=item.location,
                allDay=item.all_day,
                timezone=item.timezone,
                syncState=item.sync_state,
                localOnlyMutable=(item.sync_state == "local_only" and item.provider_id is None and item.provider_calendar_id is None),
                startAtUtc=item.start_at_utc,
                endAtUtc=item.end_at_utc,
                startDate=item.start_date,
                endDateExclusive=item.end_date_exclusive,
                deletedAt=item.deleted_at,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in result.items
        ]

    def _event_identity(
        self,
        event: UpstreamCalendarEvent,
        upstream_sources: list[UpstreamPlanningSource] | None,
    ) -> PlanningCalendarIdentity:
        if event.provider_id is None and event.provider_calendar_id is None:
            return PlanningCalendarIdentity(
                providerId="native-planning",
                providerLabel="Local Planning",
                calendarId="local",
                calendarLabel="Локальный",
            )
        if upstream_sources is None:
            return _event_identity(event)
        if event.provider_calendar_id is None:
            raise PlanningReadUnavailable("planning_calendar_identity_unmapped")
        for source in upstream_sources:
            if source.sourceType != "external_calendar":
                continue
            for calendar in source.calendars:
                if calendar.calendarId != event.provider_calendar_id:
                    continue
                source_id = _browser_source_id(source)
                calendar_id = _browser_calendar_id(source, calendar.calendarId)
                label_counts = sum(
                    candidate.displayName == calendar.displayName
                    for candidate in source.calendars
                )
                label = calendar.displayName
                if label_counts > 1:
                    label = f"{label} · #{calendar_id[-6:]}"
                return PlanningCalendarIdentity(
                    providerId=source_id,
                    providerLabel=_browser_source_label(source),
                    calendarId=calendar_id,
                    calendarLabel=label,
                )
        raise PlanningReadUnavailable("planning_calendar_identity_unmapped")

    @staticmethod
    def _map_projects(
        result: Any,
        fallback: list[ProjectProjection],
    ) -> list[ProjectProjection]:
        if not isinstance(result, ProjectListEnvelope):
            return list(fallback)
        return [
            ProjectProjection(
                id=item.id,
                version=item.version,
                source=item.source,
                sourceLabel=source_label(item.source),
                name=item.name,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in result.items
        ]

    def _projection_from_domains(
        self,
        mapped: Mapping[str, Any],
        *,
        generated_at: str,
        source_status: PlanningSourceStatus,
        last_synced_at: str | None,
        provider_statuses: list[PlanningCalendarSource],
    ) -> PlanningProjection:
        stale_after = None
        if last_synced_at is not None:
            stale_after = self._now_text(
                timestamp_datetime(last_synced_at)
                + timedelta(seconds=self._settings.panel_planning_stale_after_seconds)
            )
        return PlanningProjection(
            schemaVersion="planning.panel.v1",
            generatedAt=generated_at,
            sourceStatus=source_status,
            lastSyncedAt=last_synced_at,
            staleAfter=stale_after,
            reminders=mapped["reminders"],
            tasks=mapped["tasks"],
            calendar=mapped["calendar"],
            capabilities=PlanningCapabilities(**self._effective_capabilities()),
            providerStatuses=provider_statuses,
        )

    def _live_client(self) -> PlanningClient:
        if not self._enabled or self._client is None:
            raise PlanningReadUnavailable("planning_live_read_unavailable")
        return self._client

    def _effective_capabilities(self) -> dict[str, bool]:
        allowed = {
            action
            for action in ("create", "update", "complete", "cancel")
            if self.reminder_mutation_allowed(action)  # type: ignore[arg-type]
        }
        task_allowed = {
            action
            for action in ("create", "update", "complete", "archive")
            if self.task_mutation_allowed(action)  # type: ignore[arg-type]
        }
        return {
            "create": "create" in allowed,
            "edit": "update" in allowed,
            "complete": "complete" in allowed,
            "cancel": "cancel" in allowed,
            "delete": False,
            "voice": False,
            "providerSync": False,
            "tasks": {
                "create": "create" in task_allowed,
                "edit": "update" in task_allowed,
                "complete": "complete" in task_allowed,
                "archive": "archive" in task_allowed,
            },
            "calendar": {
                "create": self.calendar_mutation_allowed("create"),
                "edit": self.calendar_mutation_allowed("update"),
                "delete": self.calendar_mutation_allowed("delete"),
            },
        }

    def _object_readback(self, envelope: ReminderObjectEnvelope) -> PlanningObjectEnvelope:
        reminder = self._map_reminders([envelope.object])[0]
        return PlanningObjectEnvelope(
            schemaVersion="planning.panel.v1",
            kind="object",
            domain="reminder",
            object=reminder,
            sourceStatus="current",
            lastSyncedAt=envelope.lastSyncedAt,
            staleAfter=envelope.staleAfter,
            sources=self._project_sources(envelope.sources),
        )

    def _task_object_readback(self, envelope: TaskObjectEnvelope) -> PlanningTaskObjectEnvelope:
        task = self._map_tasks(
            TaskListEnvelope(
                schemaVersion="planning.v1",
                kind="list",
                domain="task",
                generatedAt=envelope.lastSyncedAt,
                sourceStatus="current",
                lastSyncedAt=envelope.lastSyncedAt,
                staleAfter=envelope.staleAfter,
                pagination={"limit": 1, "offset": 0, "count": 1, "has_more": False, "next_offset": None},
                correlation_id=envelope.correlation_id,
                items=[envelope.object],
            ),
            [],
        )[0]
        return PlanningTaskObjectEnvelope(
            schemaVersion="planning.panel.v1",
            kind="object",
            domain="task",
            object=task,
            sourceStatus="current",
            lastSyncedAt=envelope.lastSyncedAt,
            staleAfter=envelope.staleAfter,
            sources=self._project_sources(envelope.sources),
        )

    def _event_object_readback(self, envelope: EventObjectEnvelope) -> PlanningEventObjectEnvelope:
        event = self._map_events(
            EventListEnvelope(
                schemaVersion="planning.v1",
                kind="list",
                domain="calendar_event",
                generatedAt=envelope.lastSyncedAt,
                sourceStatus="current",
                lastSyncedAt=envelope.lastSyncedAt,
                staleAfter=envelope.staleAfter,
                sources=envelope.sources,
                pagination={"limit": 1, "offset": 0, "count": 1, "has_more": False, "next_offset": None},
                correlation_id=envelope.correlation_id,
                items=[envelope.object],
            ),
            [],
            envelope.sources,
        )[0]
        return PlanningEventObjectEnvelope(
            schemaVersion="planning.panel.v1",
            kind="object",
            domain="calendar_event",
            object=event,
            sourceStatus="current",
            lastSyncedAt=envelope.lastSyncedAt,
            staleAfter=envelope.staleAfter,
            sources=self._project_sources(envelope.sources),
        )

    def _read_upstream_envelope(
        self,
        envelope: PlanningListEnvelope,
    ) -> PlanningReadEnvelope:
        if isinstance(envelope, ReminderListEnvelope):
            items = self._map_reminders(envelope.items)
        elif isinstance(envelope, TaskListEnvelope):
            items = self._map_tasks(envelope, [])
        elif isinstance(envelope, EventListEnvelope):
            items = self._map_events(envelope, [], envelope.sources)
        elif isinstance(envelope, ProjectListEnvelope):
            items = self._map_projects(envelope, [])
        else:
            raise PlanningReadUnavailable("planning_domain_read_unavailable")
        return PlanningReadEnvelope(
            schemaVersion="planning.panel.v1",
            kind="list",
            domain=envelope.domain,
            generatedAt=envelope.generatedAt,
            sourceStatus=self._status_source_status(current=True),
            lastSyncedAt=envelope.lastSyncedAt,
            staleAfter=envelope.staleAfter,
            sources=self._project_sources(envelope.sources),
            items=items,
            limit=envelope.pagination.limit,
            offset=envelope.pagination.offset,
            count=len(items),
            hasMore=envelope.pagination.has_more,
        )

    def _status_due(self) -> bool:
        if self._last_status_attempt_at is None:
            return True
        return (
            self._clock() - self._last_status_attempt_at
            >= float(self._settings.panel_planning_status_refresh_seconds)
        )

    async def _set_projection(self, projection: PlanningProjection) -> None:
        self._projection = projection.model_copy(deep=True)
        if self._on_change is not None:
            await self._on_change()

    def _status_source_status(self, *, current: bool) -> PlanningSourceStatus:
        if not current:
            return "degraded"
        if self._last_status is None:
            return "current"
        if _status_is_degraded(self._last_status):
            return "degraded"
        return "current"

    def _failure_source_status(self) -> PlanningSourceStatus:
        if self._last_good is None:
            return "offline"
        if self._last_success_at is None:
            return "stale"
        age = max(0.0, self._clock() - self._last_success_at)
        if self._cache_loaded:
            return self._cache_source_status(age)
        if age > self._settings.panel_planning_unavailable_after_seconds:
            return "offline"
        if age > self._settings.panel_planning_stale_after_seconds:
            return "stale"
        return "degraded"

    def _cache_source_status(self, age: float) -> PlanningSourceStatus:
        if age > self._settings.panel_planning_unavailable_after_seconds:
            return "offline"
        return "stale"

    def _last_synced_at(self, projection: PlanningProjection | None) -> str | None:
        return projection.lastSyncedAt if projection is not None else None

    def _max_synced_at(self, results: list[Any]) -> str | None:
        values = [
            result.lastSyncedAt
            for result in results
            if hasattr(result, "lastSyncedAt") and isinstance(result.lastSyncedAt, str)
        ]
        return max(values) if values else None

    def _record_failure(self, domain: str, error: Exception) -> None:
        self._upstream_connected = False
        if domain == "domain":
            self._status_refresh_requested = True
        LOGGER.warning(
            "planning_request_failed domain=%s category=%s status_category=%s",
            domain,
            _error_category(error),
            _status_category(error),
        )

    def _record_domain_errors(self, errors: list[Exception]) -> None:
        categories = sorted({_error_category(error) for error in errors})
        LOGGER.warning(
            "planning_domain_refresh_degraded failed_domains=%s",
            len(errors),
        )
        if categories:
            LOGGER.debug("planning_contract_categories categories=%s", ",".join(categories[:4]))

    @property
    def _timezone(self) -> ZoneInfo:
        return ZoneInfo(self._settings.panel_planning_timezone)

    def _wall_now(self) -> datetime:
        value = self._wall_clock()
        if value.tzinfo is None or value.utcoffset() is None:
            raise PlanningConfigurationError("Planning adapter clock must be timezone-aware")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _now_text(value: datetime | None = None) -> str:
        selected = value or datetime.now(timezone.utc)
        return selected.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    def _windows(self, now: datetime) -> dict[str, str]:
        local = now.astimezone(self._timezone)
        today = local.date()
        today_start = datetime.combine(today, local_time.min, tzinfo=self._timezone)
        tomorrow = today + timedelta(days=1)
        upcoming_end = today + timedelta(days=PLANNING_EVENT_UPCOMING_DAYS + 1)
        reminder_from = now - timedelta(days=PLANNING_RANGE_DAYS)
        reminder_to = now + timedelta(days=PLANNING_RANGE_DAYS)
        return {
            "now": self._now_text(now),
            "reminder_overdue_from": self._now_text(reminder_from),
            "reminder_upcoming_to": self._now_text(reminder_to),
            "today_from": self._now_text(today_start.astimezone(timezone.utc)),
            "today_to": self._now_text(
                datetime.combine(tomorrow, local_time.min, tzinfo=self._timezone).astimezone(timezone.utc)
            ),
            "upcoming_from": self._now_text(
                datetime.combine(tomorrow, local_time.min, tzinfo=self._timezone).astimezone(timezone.utc)
            ),
            "upcoming_to": self._now_text(
                datetime.combine(upcoming_end, local_time.min, tzinfo=self._timezone).astimezone(timezone.utc)
            ),
        }


def _status_is_degraded(status: StatusEnvelope) -> bool:
    if status.storageStatus != "available":
        return True
    health = status.planningHealth
    if health is None:
        return False
    if health.dbIntegrityStatus != "ok" or not health.dbAvailable:
        return True
    if health.schedulerHealth == "degraded":
        return True
    if health.incidents:
        return True
    return health.providerStatus not in {"not_configured", "local_only"}


def _bounded_unique(items: list[Any]) -> list[Any]:
    result: list[Any] = []
    seen: set[str] = set()
    for item in items:
        item_id = getattr(item, "id", None)
        if not isinstance(item_id, str) or item_id in seen:
            continue
        seen.add(item_id)
        result.append(item)
        if len(result) >= PLANNING_PAGE_LIMIT:
            break
    return result


def _unique_by_id(items: list[Any]) -> list[Any]:
    return _bounded_unique(items)


def _event_overlaps(
    event: CalendarEventProjection,
    start: datetime,
    end: datetime,
    timezone_name: str,
) -> bool:
    if event.allDay:
        local_start = start.astimezone(ZoneInfo(timezone_name)).date().isoformat()
        local_end = end.astimezone(ZoneInfo(timezone_name)).date().isoformat()
        assert event.startDate is not None and event.endDateExclusive is not None
        return event.startDate < local_end and event.endDateExclusive > local_start
    assert event.startAtUtc is not None and event.endAtUtc is not None
    return timestamp_datetime(event.startAtUtc) < end and timestamp_datetime(event.endAtUtc) > start


def _event_conflicts(
    events: list[CalendarEventProjection],
    *,
    timezone_name: str,
) -> list[PlanningConflict]:
    events = _unique_by_id(events)
    conflicts: list[PlanningConflict] = []
    for index, left in enumerate(events):
        for right in events[index + 1 :]:
            if not _events_overlap(left, right, timezone_name):
                continue
            ids = sorted([left.id, right.id])
            start_at = None
            end_at = None
            if left.startAtUtc and right.startAtUtc:
                start_at = max(timestamp_datetime(left.startAtUtc), timestamp_datetime(right.startAtUtc))
                end_at = min(
                    timestamp_datetime(left.endAtUtc or left.startAtUtc),
                    timestamp_datetime(right.endAtUtc or right.startAtUtc),
                )
            conflicts.append(
                PlanningConflict(
                    id="conflict:" + ":".join(ids),
                    eventIds=ids,
                    startAtUtc=None if start_at is None else _format_datetime(start_at),
                    endAtUtc=None if end_at is None else _format_datetime(end_at),
                )
            )
            if len(conflicts) >= PLANNING_PAGE_LIMIT:
                return conflicts
    return conflicts


def _events_overlap(
    left: CalendarEventProjection,
    right: CalendarEventProjection,
    timezone_name: str,
) -> bool:
    if left.allDay or right.allDay:
        zone = ZoneInfo(timezone_name)
        left_start, left_end = _event_local_date_window(left, zone)
        right_start, right_end = _event_local_date_window(right, zone)
        return left_start < right_end and left_end > right_start
    assert left.startAtUtc and left.endAtUtc and right.startAtUtc and right.endAtUtc
    return (
        timestamp_datetime(left.startAtUtc) < timestamp_datetime(right.endAtUtc)
        and timestamp_datetime(right.startAtUtc) < timestamp_datetime(left.endAtUtc)
    )


def _event_local_date_window(
    event: CalendarEventProjection,
    zone: ZoneInfo,
) -> tuple[str, str]:
    if event.allDay:
        assert event.startDate is not None and event.endDateExclusive is not None
        return event.startDate, event.endDateExclusive
    assert event.startAtUtc is not None and event.endAtUtc is not None
    start = timestamp_datetime(event.startAtUtc).astimezone(zone)
    end = timestamp_datetime(event.endAtUtc).astimezone(zone)
    end_date = end.date()
    if end.time() != local_time.min:
        end_date += timedelta(days=1)
    return start.date().isoformat(), end_date.isoformat()


def _format_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _error_category(error: Exception) -> str:
    if isinstance(error, PlanningUpstreamError):
        return error.category
    return type(error).__name__


def _status_category(error: Exception) -> str:
    if isinstance(error, PlanningUpstreamError) and error.status_code is not None:
        return str(error.status_code // 100) + "xx"
    return "none"
