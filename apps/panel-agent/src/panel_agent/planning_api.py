"""Narrow same-origin read surface backed by the normalized Planning adapter."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator, model_validator
from starlette.datastructures import QueryParams

from .planning import (
    PlanningObjectEnvelope,
    PlanningEventObjectEnvelope,
    PlanningTaskObjectEnvelope,
    PlanningParsePreview,
    PlanningReadEnvelope,
    PlanningStatusProjection,
    validate_timezone,
    validate_date,
    validate_local_datetime,
    validate_local_time,
    validate_uuid4,
    validate_utc_timestamp,
)
from .planning_adapter import (
    PlanningAdapter,
    PlanningBoundedScanError,
    PlanningReadUnavailable,
    PlanningUpstreamError,
)


class ReminderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr = Field(min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    due_at_utc: StrictStr
    timezone: StrictStr = Field(min_length=1, max_length=64)

    @field_validator("due_at_utc")
    @classmethod
    def _due(cls, value: str) -> str:
        validate_utc_timestamp(value, "planning.reminder.due_at_utc")
        return value

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        validate_timezone(value, "planning.reminder.timezone")
        return value


class ReminderPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr | None = Field(default=None, min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    due_at_utc: StrictStr | None = None
    timezone: StrictStr | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("due_at_utc")
    @classmethod
    def _due(cls, value: str | None) -> str | None:
        if value is not None:
            validate_utc_timestamp(value, "planning.reminder.due_at_utc")
        return value

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        if value is not None:
            validate_timezone(value, "planning.reminder.timezone")
        return value

    @model_validator(mode="after")
    def _not_empty(self) -> "ReminderPatchRequest":
        if not self.model_fields_set:
            raise ValueError("reminder patch must contain at least one field")
        return self


class TaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr = Field(min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    due_date: StrictStr | None = None
    due_time: StrictStr | None = None
    timezone: StrictStr | None = Field(default=None, max_length=64)
    priority: Literal["none", "low", "normal", "high"]
    project_id: StrictStr | None = None

    @field_validator("due_date")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.task.due_date")

    @field_validator("due_time")
    @classmethod
    def _time(cls, value: str | None) -> str | None:
        return None if value is None else validate_local_time(value, "planning.task.due_time")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else validate_timezone(value, "planning.task.timezone")

    @field_validator("project_id")
    @classmethod
    def _project(cls, value: str | None) -> str | None:
        if value is not None:
            validate_uuid4(value, "planning.task.project_id")
        return value

    @model_validator(mode="after")
    def _shape(self) -> "TaskCreateRequest":
        if self.due_date is None and (self.due_time is not None or self.timezone is not None):
            raise ValueError("task due_time/timezone require due_date")
        if self.due_date is not None and self.due_time is None and self.timezone is not None:
            raise ValueError("date-only task must not contain timezone")
        if self.due_time is not None and self.timezone is None:
            raise ValueError("timed task requires timezone")
        if self.due_date is not None and self.due_time is not None and self.timezone is not None:
            validate_local_datetime(self.due_date, self.due_time, self.timezone)
        return self


class TaskPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr | None = Field(default=None, min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    due_date: StrictStr | None = None
    due_time: StrictStr | None = None
    timezone: StrictStr | None = Field(default=None, max_length=64)
    priority: Literal["none", "low", "normal", "high"] | None = None
    project_id: StrictStr | None = None

    @field_validator("due_date")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.task.due_date")

    @field_validator("due_time")
    @classmethod
    def _time(cls, value: str | None) -> str | None:
        return None if value is None else validate_local_time(value, "planning.task.due_time")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else validate_timezone(value, "planning.task.timezone")

    @field_validator("project_id")
    @classmethod
    def _project(cls, value: str | None) -> str | None:
        if value is not None:
            validate_uuid4(value, "planning.task.project_id")
        return value

    @model_validator(mode="after")
    def _not_empty(self) -> "TaskPatchRequest":
        if not self.model_fields_set:
            raise ValueError("task patch must contain at least one field")
        return self


class EventCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr = Field(min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    location: StrictStr | None = Field(default=None, max_length=1000)
    all_day: bool
    timezone: StrictStr = Field(min_length=1, max_length=64)
    start_at_utc: StrictStr | None = None
    end_at_utc: StrictStr | None = None
    start_date: StrictStr | None = None
    end_date_exclusive: StrictStr | None = None

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        return validate_timezone(value, "planning.calendar_event.timezone")

    @field_validator("start_at_utc", "end_at_utc")
    @classmethod
    def _timestamp(cls, value: str | None) -> str | None:
        return None if value is None else validate_utc_timestamp(value, "planning.calendar_event.timestamp")

    @field_validator("start_date", "end_date_exclusive")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.calendar_event.date")

    @model_validator(mode="after")
    def _shape(self) -> "EventCreateRequest":
        if self.all_day:
            if self.start_date is None or self.end_date_exclusive is None or self.start_at_utc is not None or self.end_at_utc is not None:
                raise ValueError("all-day event shape is invalid")
            if self.end_date_exclusive <= self.start_date:
                raise ValueError("all-day event range is invalid")
        else:
            if self.start_at_utc is None or self.end_at_utc is None or self.start_date is not None or self.end_date_exclusive is not None:
                raise ValueError("timed event shape is invalid")
            if self.end_at_utc <= self.start_at_utc:
                raise ValueError("timed event range is invalid")
        return self


class EventPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: StrictStr | None = Field(default=None, min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    location: StrictStr | None = Field(default=None, max_length=1000)
    all_day: bool | None = None
    timezone: StrictStr | None = Field(default=None, max_length=64)
    start_at_utc: StrictStr | None = None
    end_at_utc: StrictStr | None = None
    start_date: StrictStr | None = None
    end_date_exclusive: StrictStr | None = None

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else validate_timezone(value, "planning.calendar_event.timezone")

    @field_validator("start_at_utc", "end_at_utc")
    @classmethod
    def _timestamp(cls, value: str | None) -> str | None:
        return None if value is None else validate_utc_timestamp(value, "planning.calendar_event.timestamp")

    @field_validator("start_date", "end_date_exclusive")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.calendar_event.date")

    @model_validator(mode="after")
    def _shape(self) -> "EventPatchRequest":
        if not self.model_fields_set:
            raise ValueError("event patch must contain at least one field")
        temporal = {"all_day", "timezone", "start_at_utc", "end_at_utc", "start_date", "end_date_exclusive"}
        if not temporal.intersection(self.model_fields_set):
            return self
        if self.all_day is None or self.timezone is None:
            raise ValueError("event shape transition requires all_day and timezone")
        if self.all_day:
            if self.start_date is None or self.end_date_exclusive is None or self.start_at_utc is not None or self.end_at_utc is not None:
                raise ValueError("all-day event shape is invalid")
            if self.end_date_exclusive <= self.start_date:
                raise ValueError("all-day event range is invalid")
        else:
            if self.start_at_utc is None or self.end_at_utc is None or self.start_date is not None or self.end_date_exclusive is not None:
                raise ValueError("timed event shape is invalid")
            if self.end_at_utc <= self.start_at_utc:
                raise ValueError("timed event range is invalid")
        return self


class PlanningParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    text: StrictStr = Field(min_length=1, max_length=2000)
    reference_time_utc: StrictStr
    timezone: StrictStr = Field(min_length=1, max_length=64)
    locale: StrictStr = Field(default="ru-RU", min_length=1, max_length=16)

    @field_validator("reference_time_utc")
    @classmethod
    def _reference(cls, value: str) -> str:
        validate_utc_timestamp(value, "planning.reference_time_utc")
        return value

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        validate_timezone(value, "planning.timezone")
        return value

    @field_validator("locale")
    @classmethod
    def _locale(cls, value: str) -> str:
        if value != "ru-RU":
            raise ValueError("planning parser supports only ru-RU")
        return value


def build_planning_router(
    adapter: PlanningAdapter,
    *,
    prefix: str = "/api/v1/planning",
    calendar_read_observer: Callable[..., None] | None = None,
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["planning"])

    @router.get("/status", response_model=PlanningStatusProjection)
    async def planning_status(request: Request, response: Response) -> PlanningStatusProjection:
        del request
        _enabled(adapter)
        _no_store(response)
        return adapter.read_status()

    @router.get("/reminders", response_model=PlanningReadEnvelope)
    async def planning_reminders(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"state", "from", "to", "limit", "offset"})
        state = query.get("state")
        if state is not None and state not in {"pending", "due", "completed", "cancelled"}:
            raise HTTPException(status_code=422, detail="planning_state_invalid")
        from_utc, to_utc = _optional_range(query)
        try:
            return await adapter.read_reminders(
                state=state,
                from_utc=from_utc,
                to_utc=to_utc,
                limit=_limit(query),
                offset=_offset(query),
            )
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.get("/reminders/view", response_model=PlanningReadEnvelope)
    async def planning_reminder_view(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"view", "limit", "offset"})
        view = query.get("view")
        if view not in {"upcoming", "overdue", "delivery"}:
            raise HTTPException(status_code=422, detail="planning_reminder_view_required")
        try:
            return await adapter.read_reminder_view(
                view=view,  # type: ignore[arg-type]
                limit=_limit(query),
                offset=_offset(query),
            )
        except PlanningBoundedScanError as exc:
            raise _read_unavailable(detail=exc.category) from exc
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.post("/parse", response_model=PlanningParsePreview)
    async def planning_parse_preview(
        request: PlanningParseRequest,
        response: Response,
    ) -> PlanningParsePreview:
        _enabled(adapter)
        _no_store(response)
        try:
            return await adapter.parse_preview(
                text=request.text,
                reference_time_utc=request.reference_time_utc,
                timezone=request.timezone,
            )
        except PlanningUpstreamError as exc:
            raise _read_unavailable(detail=exc.category) from exc

    @router.post("/reminders", response_model=PlanningObjectEnvelope)
    async def planning_create_reminder(
        request: ReminderCreateRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_reminder_mutation(adapter, "create")
        _no_store(response)
        try:
            return await adapter.create_reminder(
                idempotency_key=_idempotency_key(raw_request),
                title=request.title,
                notes=request.notes,
                due_at_utc=request.due_at_utc,
                timezone=request.timezone,
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc) from exc

    @router.patch("/reminders/{reminder_id}", response_model=PlanningObjectEnvelope)
    async def planning_edit_reminder(
        reminder_id: str,
        request: ReminderPatchRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_reminder_mutation(adapter, "update")
        _no_store(response)
        _validate_reminder_id(reminder_id)
        try:
            return await adapter.edit_reminder(
                reminder_id=reminder_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
                body=request.model_dump(exclude_unset=True),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc) from exc

    @router.post("/reminders/{reminder_id}/complete", response_model=PlanningObjectEnvelope)
    async def planning_complete_reminder(
        reminder_id: str,
        raw_request: Request,
        response: Response,
    ) -> PlanningObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_reminder_mutation(adapter, "complete")
        _no_store(response)
        _validate_reminder_id(reminder_id)
        await _require_empty_body(raw_request)
        try:
            return await adapter.complete_reminder(
                reminder_id=reminder_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc) from exc

    @router.post("/reminders/{reminder_id}/cancel", response_model=PlanningObjectEnvelope)
    async def planning_cancel_reminder(
        reminder_id: str,
        raw_request: Request,
        response: Response,
    ) -> PlanningObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_reminder_mutation(adapter, "cancel")
        _no_store(response)
        _validate_reminder_id(reminder_id)
        await _require_empty_body(raw_request)
        try:
            return await adapter.cancel_reminder(
                reminder_id=reminder_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc) from exc

    @router.get("/tasks", response_model=PlanningReadEnvelope)
    async def planning_tasks(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"view", "projectId", "limit", "offset"})
        view = query.get("view")
        if view not in {"today", "overdue", "upcoming"}:
            raise HTTPException(status_code=422, detail="planning_view_required")
        project_id = query.get("projectId")
        if project_id is not None:
            try:
                validate_uuid4(project_id, "planning.projectId")
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="planning_project_id_invalid") from exc
        try:
            return await adapter.read_tasks(
                view=view,  # type: ignore[arg-type]
                project_id=project_id,
                limit=_limit(query),
                offset=_offset(query),
            )
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.get("/tasks/{task_id}", response_model=PlanningTaskObjectEnvelope)
    async def planning_task_by_id(
        task_id: str,
        request: Request,
        response: Response,
    ) -> PlanningTaskObjectEnvelope:
        _enabled(adapter)
        _no_store(response)
        _query(request, allowed=set())
        _validate_task_id(task_id)
        try:
            return await adapter.read_task_by_id(task_id=task_id)
        except PlanningUpstreamError as exc:
            raise _task_read_error(exc) from exc
        except PlanningReadUnavailable as exc:
            raise _read_unavailable() from exc

    @router.post("/tasks", response_model=PlanningTaskObjectEnvelope)
    async def planning_create_task(
        request: TaskCreateRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningTaskObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_task_mutation(adapter, "create")
        _no_store(response)
        try:
            return await adapter.create_task(
                idempotency_key=_idempotency_key(raw_request),
                body=request.model_dump(exclude_unset=True),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="task") from exc

    @router.patch("/tasks/{task_id}", response_model=PlanningTaskObjectEnvelope)
    async def planning_edit_task(
        task_id: str,
        request: TaskPatchRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningTaskObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_task_mutation(adapter, "update")
        _no_store(response)
        _validate_task_id(task_id)
        try:
            return await adapter.edit_task(
                task_id=task_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
                body=request.model_dump(exclude_unset=True),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="task") from exc

    @router.post("/tasks/{task_id}/complete", response_model=PlanningTaskObjectEnvelope)
    async def planning_complete_task(
        task_id: str,
        raw_request: Request,
        response: Response,
    ) -> PlanningTaskObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_task_mutation(adapter, "complete")
        _no_store(response)
        _validate_task_id(task_id)
        await _require_empty_body(raw_request)
        try:
            return await adapter.complete_task(
                task_id=task_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="task") from exc

    @router.delete("/tasks/{task_id}", response_model=PlanningTaskObjectEnvelope)
    async def planning_archive_task(
        task_id: str,
        raw_request: Request,
        response: Response,
    ) -> PlanningTaskObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_task_mutation(adapter, "archive")
        _no_store(response)
        _validate_task_id(task_id)
        await _require_empty_body(raw_request)
        try:
            return await adapter.archive_task(
                task_id=task_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="task") from exc

    @router.get("/events", response_model=PlanningReadEnvelope)
    async def planning_events(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"from", "to", "limit", "offset", "view"})
        from_utc, to_utc = _required_range(query)
        view = query.get("view")
        if view is not None and view not in {"today", "agenda"}:
            raise HTTPException(status_code=422, detail="planning_calendar_view_invalid")
        try:
            envelope = await adapter.read_events(
                from_utc=from_utc,
                to_utc=to_utc,
                limit=_limit(query),
                offset=_offset(query),
            )
            _record_calendar_read(
                calendar_read_observer,
                from_utc=from_utc,
                to_utc=to_utc,
                view=view,
                item_count=envelope.count,
                source_status=envelope.sourceStatus,
                last_synced_at=envelope.lastSyncedAt,
                providers=envelope.sources,
            )
            return envelope
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            _record_calendar_read(
                calendar_read_observer,
                from_utc=from_utc,
                to_utc=to_utc,
                view=view,
                result_status="error" if isinstance(exc, PlanningUpstreamError) else "unavailable",
                projection_status="unavailable",
            )
            raise _read_unavailable() from exc

    @router.get("/events/{event_id}", response_model=PlanningEventObjectEnvelope)
    async def planning_event_by_id(
        event_id: str,
        request: Request,
        response: Response,
    ) -> PlanningEventObjectEnvelope:
        _enabled(adapter)
        _no_store(response)
        _query(request, allowed=set())
        _validate_event_id(event_id)
        try:
            return await adapter.read_event_by_id(event_id=event_id)
        except PlanningUpstreamError as exc:
            raise _event_read_error(exc) from exc
        except PlanningReadUnavailable as exc:
            raise _read_unavailable() from exc

    @router.post("/events", response_model=PlanningEventObjectEnvelope)
    async def planning_create_event(
        request: EventCreateRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningEventObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_calendar_mutation(adapter, "create")
        _no_store(response)
        try:
            return await adapter.create_event(
                idempotency_key=_idempotency_key(raw_request),
                body=request.model_dump(exclude_unset=True),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="event") from exc

    @router.patch("/events/{event_id}", response_model=PlanningEventObjectEnvelope)
    async def planning_edit_event(
        event_id: str,
        request: EventPatchRequest,
        raw_request: Request,
        response: Response,
    ) -> PlanningEventObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_calendar_mutation(adapter, "update")
        _no_store(response)
        _validate_event_id(event_id)
        try:
            return await adapter.edit_event(
                event_id=event_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
                body=request.model_dump(exclude_unset=True),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="event") from exc

    @router.delete("/events/{event_id}", response_model=PlanningEventObjectEnvelope)
    async def planning_delete_event(
        event_id: str,
        raw_request: Request,
        response: Response,
    ) -> PlanningEventObjectEnvelope:
        _canonical_mutation_route(prefix)
        _require_calendar_mutation(adapter, "delete")
        _no_store(response)
        _validate_event_id(event_id)
        await _require_empty_body(raw_request)
        try:
            return await adapter.delete_event(
                event_id=event_id,
                expected_version=_if_match(raw_request),
                idempotency_key=_idempotency_key(raw_request),
            )
        except PlanningUpstreamError as exc:
            raise _mutation_error(exc, domain="event") from exc

    @router.get("/projects", response_model=PlanningReadEnvelope)
    async def planning_projects(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"limit", "offset"})
        try:
            return await adapter.read_projects(limit=_limit(query), offset=_offset(query))
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    return router


def _enabled(adapter: PlanningAdapter) -> None:
    if not adapter.enabled:
        raise HTTPException(status_code=404, detail="planning_disabled")


def _record_calendar_read(observer: Callable[..., None] | None, **values: object) -> None:
    """Diagnostics are best-effort and can never change the read response."""

    if observer is None:
        return
    try:
        observer(**values)
    except Exception:
        return


def _require_reminder_mutation(adapter: PlanningAdapter, action: str) -> None:
    _enabled(adapter)
    if not adapter.reminder_mutations_enabled:
        raise HTTPException(status_code=404, detail="planning_reminder_mutations_disabled")
    if action not in {"create", "update", "complete", "cancel"} or not adapter.reminder_mutation_allowed(action):
        raise HTTPException(status_code=403, detail="planning_reminder_capability_denied")


def _require_task_mutation(adapter: PlanningAdapter, action: str) -> None:
    _enabled(adapter)
    if not adapter.task_mutations_enabled:
        raise HTTPException(status_code=404, detail="planning_task_mutations_disabled")
    if action not in {"create", "update", "complete", "archive"} or not adapter.task_mutation_allowed(action):
        raise HTTPException(status_code=403, detail="planning_task_capability_denied")


def _require_calendar_mutation(adapter: PlanningAdapter, action: str) -> None:
    _enabled(adapter)
    if not adapter.calendar_mutations_enabled:
        raise HTTPException(status_code=404, detail="planning_calendar_mutations_disabled")
    if action not in {"create", "update", "delete"} or not adapter.calendar_mutation_allowed(action):
        raise HTTPException(status_code=403, detail="planning_calendar_capability_denied")


def _idempotency_key(request: Request) -> str:
    value = request.headers.get("Idempotency-Key", "")
    if not value or len(value) > 256 or any(ord(char) < 0x20 for char in value):
        raise HTTPException(status_code=400, detail="planning_idempotency_key_invalid")
    return value


def _if_match(request: Request) -> int:
    value = request.headers.get("If-Match", "")
    if not value.isdigit() or int(value) < 1:
        raise HTTPException(status_code=400, detail="planning_if_match_invalid")
    return int(value)


def _validate_reminder_id(value: str) -> None:
    try:
        validate_uuid4(value, "planning.reminder_id")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="planning_reminder_id_invalid") from exc


def _validate_task_id(value: str) -> None:
    try:
        validate_uuid4(value, "planning.task_id")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="planning_task_id_invalid") from exc


def _validate_event_id(value: str) -> None:
    try:
        validate_uuid4(value, "planning.calendar_event_id")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="planning_calendar_event_id_invalid") from exc


async def _require_empty_body(request: Request) -> None:
    body = await request.body()
    if body.strip() not in {b"", b"{}"}:
        raise HTTPException(status_code=422, detail="planning_action_body_not_empty")


def _mutation_error(error: PlanningUpstreamError, *, domain: Literal["reminder", "task", "event"] = "reminder") -> HTTPException:
    if error.category == "mutation_uncertain":
        return HTTPException(status_code=503, detail="planning_mutation_uncertain")
    if error.category in {"version_conflict", "idempotency_conflict", "idempotency_in_progress"}:
        return HTTPException(status_code=409, detail=f"planning_{error.category}")
    if error.category == "event_not_local_only":
        return HTTPException(status_code=409, detail="event_not_local_only")
    if error.category == "not_found":
        return HTTPException(status_code=404, detail=f"planning_{domain}_not_found")
    if error.category in {
        "validation_error",
        "reminder_patch_invalid",
        "task_create_invalid",
        "task_patch_invalid",
        "event_create_invalid",
        "event_patch_invalid",
        "idempotency_key_invalid",
        "expected_version_invalid",
    }:
        return HTTPException(status_code=422, detail="planning_mutation_invalid")
    return HTTPException(status_code=503, detail="planning_mutation_unavailable")


def _task_read_error(error: PlanningUpstreamError) -> HTTPException:
    if error.category == "not_found":
        return HTTPException(status_code=404, detail="planning_task_not_found")
    if error.category in {"validation_error", "contract_mismatch", "domain_mismatch"}:
        return HTTPException(status_code=422, detail="planning_task_invalid")
    return _read_unavailable()


def _event_read_error(error: PlanningUpstreamError) -> HTTPException:
    if error.category == "not_found":
        return HTTPException(status_code=404, detail="planning_calendar_event_not_found")
    if error.category in {"validation_error", "contract_mismatch", "domain_mismatch"}:
        return HTTPException(status_code=422, detail="planning_calendar_event_invalid")
    return _read_unavailable()


def _canonical_mutation_route(prefix: str) -> None:
    if prefix != "/api/v1/planning":
        raise HTTPException(status_code=404, detail="planning_route_not_found")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _read_unavailable(*, detail: str = "planning_read_unavailable") -> HTTPException:
    """Never turn a bounded summary cache into a false complete route page."""

    return HTTPException(status_code=503, detail=detail)


def _query(request: Request, *, allowed: set[str]) -> dict[str, str]:
    params: QueryParams = request.query_params
    unknown = set(params.keys()) - allowed
    if unknown:
        raise HTTPException(status_code=422, detail="planning_query_not_allowlisted")
    result: dict[str, str] = {}
    for key, value in params.multi_items():
        if key in result or len(value) > 128:
            raise HTTPException(status_code=422, detail="planning_query_invalid")
        result[key] = value
    return result


def _limit(query: dict[str, str]) -> int:
    return _positive_int(query.get("limit", "20"), maximum=100, code="planning_limit_invalid")


def _offset(query: dict[str, str]) -> int:
    return _nonnegative_int(query.get("offset", "0"), maximum=10_000, code="planning_offset_invalid")


def _positive_int(value: str, *, maximum: int, code: str) -> int:
    if not value.isdigit() or not 1 <= int(value) <= maximum:
        raise HTTPException(status_code=422, detail=code)
    return int(value)


def _nonnegative_int(value: str, *, maximum: int, code: str) -> int:
    if not value.isdigit() or not 0 <= int(value) <= maximum:
        raise HTTPException(status_code=422, detail=code)
    return int(value)


def _optional_range(query: dict[str, str]) -> tuple[str | None, str | None]:
    from_utc, to_utc = query.get("from"), query.get("to")
    if (from_utc is None) != (to_utc is None):
        raise HTTPException(status_code=422, detail="planning_range_requires_both")
    if from_utc is None:
        return None, None
    _validate_range(from_utc, to_utc)
    return from_utc, to_utc


def _required_range(query: dict[str, str]) -> tuple[str, str]:
    from_utc, to_utc = query.get("from"), query.get("to")
    if from_utc is None or to_utc is None:
        raise HTTPException(status_code=422, detail="planning_range_required")
    _validate_range(from_utc, to_utc)
    return from_utc, to_utc


def _validate_range(from_utc: str, to_utc: str | None) -> None:
    if to_utc is None:
        raise HTTPException(status_code=422, detail="planning_range_requires_both")
    try:
        validate_utc_timestamp(from_utc, "planning.from")
        validate_utc_timestamp(to_utc, "planning.to")
        from_value = datetime.fromisoformat(from_utc[:-1] + "+00:00")
        to_value = datetime.fromisoformat(to_utc[:-1] + "+00:00")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="planning_range_invalid") from exc
    if to_value <= from_value or to_value - from_value > timedelta(days=366):
        raise HTTPException(status_code=422, detail="planning_range_invalid")
