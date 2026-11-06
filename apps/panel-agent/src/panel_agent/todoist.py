"""Independent Todoist v1 boundary. No Planning UUIDs, disk cache or write retries."""
from __future__ import annotations

import asyncio
import json
import re
from datetime import date, datetime, timezone
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from .settings import IntegrationSettings

def provider_id(value: str) -> str:
    if value.lower().startswith("temp"):
        raise ValueError("temporary provider ID")
    return value


ProviderId = Annotated[str, StringConstraints(strict=True, pattern=r"^[A-Za-z0-9]{1,64}$"), AfterValidator(provider_id)]
Cursor = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512, pattern=r"^[A-Za-z0-9._=~+/-]+$")]
Priority = Literal["p1", "p2", "p3", "p4"]
View = Literal["today", "overdue", "upcoming", "undated", "all"]
# Sync task semantics + Doist/todoist-cli parsePriority: API 4 is client p1.
PRIORITY_TO_API = {"p1": 4, "p2": 3, "p3": 2, "p4": 1}
FILTERS = {"today": "today", "overdue": "overdue", "upcoming": "due after: today", "undated": "no date"}
RESPONSE_LIMIT = 512 * 1024


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_due(value: str) -> str:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        date.fromisoformat(value)
    else:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?", value):
            raise ValueError("invalid due date")
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


class Due(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    date: str = Field(max_length=64)
    timezone: str | None = Field(default=None, max_length=64)
    is_recurring: bool
    string: str = Field(default="", max_length=1024)
    datetime: str | None = Field(default=None, max_length=64)

    @field_validator("date", "datetime")
    @classmethod
    def _date(cls, value):
        return valid_due(value) if value is not None else None

    @field_validator("timezone")
    @classmethod
    def _zone(cls, value):
        if value is not None:
            try:
                ZoneInfo(value)
            except ZoneInfoNotFoundError:
                raise ValueError("invalid timezone") from None
        return value


class Task(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    id: ProviderId
    project_id: ProviderId
    content: str = Field(min_length=1, max_length=16384)
    description: str = Field(max_length=32768)
    priority: int = Field(ge=1, le=4)
    due: Due | None


class Project(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    id: ProviderId
    name: str = Field(min_length=1, max_length=1024)


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: Literal["todoist"] = "todoist"
    activeSource: Literal["todoist"] = "todoist"
    generatedAt: str


class TaskPage(Envelope):
    lastSyncedAt: str
    results: list[Task]
    nextCursor: Cursor | None


class ProjectPage(Envelope):
    lastSyncedAt: str
    results: list[Project]
    nextCursor: Cursor | None


class MutationAccepted(Envelope):
    accepted: Literal[True]


class Status(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: Literal["todoist"]
    activeSource: Literal["todoist", "planning"]
    enabled: bool
    configured: bool
    writesEnabled: bool
    generatedAt: str
    lastSyncedAt: str | None
    error: str | None
    state: Literal["disabled", "unknown", "connected", "stale", "unavailable"]


class TaskFields(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    content: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=4000)
    priority: Priority | None = None
    # Omitted preserves recurrence/timezone; null explicitly clears due date.
    due: str | None = Field(default=None, max_length=64)

    @field_validator("content")
    @classmethod
    def _content(cls, value):
        if value is not None and not value.strip():
            raise ValueError("empty content")
        return value

    @field_validator("due")
    @classmethod
    def _due(cls, value):
        if value is not None:
            valid_due(value)
            if "T" in value and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError("timed input requires explicit UTC offset")
        return value

    @model_validator(mode="after")
    def _fields(self):
        if not self.model_fields_set:
            raise ValueError("empty update")
        if any(getattr(self, key) is None for key in self.model_fields_set - {"due"}):
            raise ValueError("only due may be null")
        return self

    def upstream(self) -> dict:
        fields = self.model_dump(exclude_unset=True)
        if "priority" in fields:
            fields["priority"] = PRIORITY_TO_API[fields["priority"]]
        if "due" in fields:
            due = fields.pop("due")
            fields["due_string" if due is None else "due_datetime" if "T" in due else "due_date"] = "no date" if due is None else due
        return fields


class CreateTask(TaskFields):
    content: str = Field(min_length=1, max_length=500)
    project_id: ProviderId | None = None

    @model_validator(mode="after")
    def _project(self):
        if "project_id" in self.model_fields_set and self.project_id is None:
            raise ValueError("omit project for Inbox")
        return self


class MoveTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    project_id: ProviderId


class TodoistError(Exception):
    def __init__(self, code: str, status: int = 503, retry_after: int | None = None):
        super().__init__(code)
        self.code, self.status, self.retry_after = code, status, retry_after


class TodoistAdapter:
    def __init__(self, settings: IntegrationSettings, *, transport=None):
        self._settings = settings
        self._transport = transport
        self.last_synced_at: str | None = None
        self.error: str | None = None
        self._mutation_lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._settings.todoist_enabled if self._settings.todoist_enabled is not None else bool(self._settings.todoist_api_token)

    @property
    def writes_enabled(self) -> bool:
        return self.enabled and bool(self._settings.todoist_api_token) and self._settings.writes_enabled and self._settings.todoist_writes_enabled

    def status(self) -> dict:
        return {"provider": "todoist", "activeSource": "todoist" if self.enabled else "planning",
                "enabled": self.enabled, "configured": bool(self._settings.todoist_api_token),
                "writesEnabled": self.writes_enabled, "generatedAt": timestamp(),
                "lastSyncedAt": self.last_synced_at, "error": self.error,
                "state": "disabled" if not self.enabled else "stale" if self.error and self.last_synced_at else "unavailable" if self.error else "connected" if self.last_synced_at else "unknown"}

    async def _request(self, method: str, path: str, *, params=None, body=None, close=False):
        if not self.enabled or not self._settings.todoist_api_token:
            raise TodoistError("not_configured")
        async def send():
            async with httpx.AsyncClient(transport=self._transport, timeout=httpx.Timeout(10, connect=5), follow_redirects=False) as client:
                async with client.stream(method, "https://api.todoist.com/api/v1/" + path,
                                         params=params, json=body,
                                         headers={"Authorization": "Bearer " + self._settings.todoist_api_token}) as response:
                    status = response.status_code
                    if status >= 300:
                        code = {401: "invalid_token", 403: "forbidden", 404: "not_found", 429: "rate_limited", 400: "invalid_request"}.get(status, "upstream_unavailable")
                        if method == "POST" and (status >= 500 or status < 400):
                            code = "outcome_uncertain"
                        retry = response.headers.get("retry-after", "")
                        raise TodoistError(code, 429 if status == 429 else 502, min(int(retry), 3600) if retry.isdigit() and len(retry) < 8 else None)
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > RESPONSE_LIMIT:
                            raise ValueError("response too large")
                    if close:
                        return None
                    return json.loads(data)
        try:
            return await asyncio.wait_for(send(), timeout=15)
        except TodoistError:
            raise
        except (httpx.HTTPError, asyncio.TimeoutError):
            raise TodoistError("outcome_uncertain" if method == "POST" else "offline") from None
        except (ValueError, TypeError, RecursionError):
            raise TodoistError("outcome_uncertain" if method == "POST" else "malformed_response", 502) from None

    async def page(self, *, projects=False, view: View = "today", project_id=None, cursor=None, limit=50) -> dict:
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        path = "projects" if projects else "tasks" if view == "all" else "tasks/filter"
        if not projects and view == "all" and project_id:
            params["project_id"] = project_id
        if not projects and path == "tasks/filter":
            query = FILTERS.get(view, "all")
            params.update(query=query, lang="en")
        try:
            raw = await self._request("GET", path, params=params)
            if not isinstance(raw, dict) or not isinstance(raw.get("results"), list) or "next_cursor" not in raw or len(raw["results"]) > limit:
                raise ValueError("invalid page")
            from pydantic import TypeAdapter
            next_cursor = TypeAdapter(Cursor | None).validate_python(raw["next_cursor"])
            if next_cursor is not None and next_cursor == cursor:
                raise ValueError("cursor did not advance")
            model = Project if projects else Task
            rows = [model.model_validate(row).model_dump() for row in raw["results"]]
            # Dedupe inside each page. UI also dedupes across cursor pages.
            rows = list({row["id"]: row for row in rows}.values())
            if not projects and project_id:
                # Preserve upstream cursor even for an empty filtered page.
                rows = [row for row in rows if row["project_id"] == project_id]
        except TodoistError as exc:
            self.error = exc.code
            raise
        except (ValueError, TypeError, KeyError):
            self.error = "malformed_response"
            raise TodoistError(self.error, 502) from None
        self.last_synced_at, self.error = timestamp(), None
        return {"provider": "todoist", "activeSource": "todoist", "generatedAt": self.last_synced_at,
                "lastSyncedAt": self.last_synced_at, "results": rows, "nextCursor": next_cursor}

    async def mutate(self, operation: Literal["create", "update", "move", "close"], fields=None, task_id=None) -> dict:
        if not self.writes_enabled:
            raise TodoistError("gate_disabled", 409)
        if self._mutation_lock.locked():
            raise TodoistError("busy", 409)
        path = "tasks" if operation == "create" else f"tasks/{task_id}" + (f"/{operation}" if operation in {"close", "move"} else "")
        async with self._mutation_lock:
            raw = await self._request("POST", path, body=fields, close=operation == "close")
            if operation != "close":
                try:
                    Task.model_validate(raw)
                except (ValueError, TypeError):
                    raise TodoistError("outcome_uncertain", 502) from None
        return {"provider": "todoist", "activeSource": "todoist", "generatedAt": timestamp(), "accepted": True}
