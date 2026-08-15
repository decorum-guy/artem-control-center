"""Strict, provider-neutral Planning v1 contracts and browser projection.

The upstream models in this module mirror the merged AliceTG_Bot A4 response
envelopes.  The projection models are deliberately separate: they contain
only bounded, browser-safe fields and never carry authentication material,
notes, or the upstream correlation identifiers.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, time, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator, model_validator


PLANNING_UPSTREAM_SCHEMA = "planning.v1"
PLANNING_PANEL_SCHEMA = "planning.panel.v1"
PLANNING_OPERATIONS_SCHEMA = "planning.operations.v1"

PlanningSourceStatus = Literal["current", "stale", "offline", "degraded"]
PlanningSource = Literal[
    "alice",
    "telegram",
    "panel-agent",
    "operator",
    "ticktick",
    "calendar-provider",
    "system",
]
ReminderStatus = Literal["pending", "due", "completed", "cancelled"]
DeliveryState = Literal["not_due", "queued", "retrying", "delivered", "failed"]
TaskPriority = Literal["none", "low", "normal", "high"]
TaskStatus = Literal["open", "completed", "archived"]
EventSyncState = Literal["local_only", "pending", "synced", "stale", "conflict", "error"]

_UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
_LOCAL_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")


class StrictPlanningModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def validate_uuid4(value: str, field: str = "id") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a UUIDv4")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{field} must be a UUIDv4") from exc
    if parsed.version != 4 or str(parsed) != value.lower():
        raise ValueError(f"{field} must be a UUIDv4")
    return value


def validate_optional_uuid4(value: str | None, field: str = "id") -> str | None:
    if value is None:
        return None
    return validate_uuid4(value, field)


def validate_utc_timestamp(value: str, field: str = "timestamp") -> str:
    if not isinstance(value, str) or _UTC_TIMESTAMP.fullmatch(value) is None:
        raise ValueError(f"{field} must be an RFC3339 UTC timestamp with Z suffix")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid UTC timestamp") from exc
    if parsed.tzinfo != timezone.utc:
        raise ValueError(f"{field} must be UTC")
    return value


def validate_date(value: str, field: str = "date") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{field} must be YYYY-MM-DD")
    return value


def validate_timezone(value: str, field: str = "timezone") -> str:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError(f"{field} must be an IANA timezone")
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"{field} must be an IANA timezone") from exc
    return value


def validate_local_time(value: str, field: str = "time") -> str:
    if not isinstance(value, str) or _LOCAL_TIME.fullmatch(value) is None:
        raise ValueError(f"{field} must be HH:MM or HH:MM:SS")
    return value


def validate_local_datetime(local_date: str, local_time: str, timezone_name: str) -> None:
    """Reject nonexistent or ambiguous wall-clock task due values."""

    validate_date(local_date, "task.due_date")
    validate_local_time(local_time, "task.due_time")
    validate_timezone(timezone_name, "task.timezone")
    parts = [int(part) for part in local_time.split(":")]
    selected_time = time(parts[0], parts[1], parts[2] if len(parts) == 3 else 0)
    naive = datetime.combine(date.fromisoformat(local_date), selected_time)
    zone = ZoneInfo(timezone_name)
    candidates: list[datetime] = []
    for fold in (0, 1):
        local = naive.replace(tzinfo=zone, fold=fold)
        utc_value = local.astimezone(timezone.utc)
        if utc_value.astimezone(zone).replace(tzinfo=None) == naive and utc_value not in candidates:
            candidates.append(utc_value)
    if not candidates:
        raise ValueError("task due wall-clock value does not exist")
    if len(candidates) > 1:
        raise ValueError("task due wall-clock value is ambiguous")


def _timestamp_fields(*fields: str):
    def validator(cls, value: str | None):
        if value is None:
            return None
        return validate_utc_timestamp(value, fields[0])

    return field_validator(*fields)(validator)


class PlanningPagination(StrictPlanningModel):
    limit: StrictInt = Field(ge=1, le=100)
    offset: StrictInt = Field(ge=0, le=10_000)
    count: StrictInt = Field(ge=0, le=100)
    has_more: StrictBool
    next_offset: StrictInt | None = Field(default=None, ge=0, le=10_000)


class UpstreamReminder(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    domain: Literal["reminder"]
    title: StrictStr = Field(min_length=1, max_length=500)
    due_at_utc: StrictStr
    timezone: StrictStr = Field(min_length=1, max_length=64)
    status: ReminderStatus
    source: PlanningSource
    created_by: StrictStr = Field(min_length=1, max_length=128)
    delivery_state: DeliveryState
    version: StrictInt = Field(ge=1)
    created_at: StrictStr
    updated_at: StrictStr
    audit_correlation_id: StrictStr = Field(min_length=36, max_length=36)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    source_ref: StrictStr | None = Field(default=None, max_length=256)
    completed_at: StrictStr | None = None
    cancelled_at: StrictStr | None = None
    next_attempt_at: StrictStr | None = None
    final_failure_at: StrictStr | None = None
    deleted_at: StrictStr | None = None

    _ids = field_validator("id", "audit_correlation_id")(validate_uuid4)
    _dates = _timestamp_fields(
        "due_at_utc",
        "created_at",
        "updated_at",
        "completed_at",
        "cancelled_at",
        "next_attempt_at",
        "final_failure_at",
        "deleted_at",
    )

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        return validate_timezone(value, "reminder.timezone")

    @field_validator("due_at_utc")
    @classmethod
    def _due(cls, value: str) -> str:
        return validate_utc_timestamp(value, "reminder.due_at_utc")


class UpstreamTask(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    domain: Literal["task"]
    title: StrictStr = Field(min_length=1, max_length=500)
    priority: TaskPriority
    status: TaskStatus
    source: PlanningSource
    version: StrictInt = Field(ge=1)
    created_at: StrictStr
    updated_at: StrictStr
    audit_correlation_id: StrictStr = Field(min_length=36, max_length=36)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    due_date: StrictStr | None = None
    due_time: StrictStr | None = None
    timezone: StrictStr | None = Field(default=None, max_length=64)
    project_id: StrictStr | None = Field(default=None, min_length=36, max_length=36)
    source_ref: StrictStr | None = Field(default=None, max_length=256)
    completed_at: StrictStr | None = None
    archived_at: StrictStr | None = None
    deleted_at: StrictStr | None = None

    _ids = field_validator("id", "audit_correlation_id")(validate_uuid4)
    _project_id = field_validator("project_id")(validate_optional_uuid4)
    _dates = _timestamp_fields(
        "created_at",
        "updated_at",
        "completed_at",
        "archived_at",
        "deleted_at",
    )

    @field_validator("due_date")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "task.due_date")

    @field_validator("due_time")
    @classmethod
    def _time(cls, value: str | None) -> str | None:
        return None if value is None else validate_local_time(value, "task.due_time")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else validate_timezone(value, "task.timezone")

    @model_validator(mode="after")
    def _shape(self) -> "UpstreamTask":
        if self.due_date is None and (self.due_time is not None or self.timezone is not None):
            raise ValueError("task due_time/timezone require due_date")
        if self.due_date is not None and self.due_time is None and self.timezone is not None:
            raise ValueError("date-only task must not contain timezone")
        if self.due_time is not None and self.timezone is None:
            raise ValueError("timed task requires timezone")
        if self.due_date is not None and self.due_time is not None and self.timezone is not None:
            validate_local_datetime(self.due_date, self.due_time, self.timezone)
        return self


class UpstreamCalendarEvent(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    domain: Literal["calendar_event"]
    title: StrictStr = Field(min_length=1, max_length=500)
    all_day: StrictBool
    timezone: StrictStr = Field(min_length=1, max_length=64)
    sync_state: EventSyncState
    source: PlanningSource
    version: StrictInt = Field(ge=1)
    created_at: StrictStr
    updated_at: StrictStr
    audit_correlation_id: StrictStr = Field(min_length=36, max_length=36)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    location: StrictStr | None = Field(default=None, max_length=1000)
    start_at_utc: StrictStr | None = None
    end_at_utc: StrictStr | None = None
    start_date: StrictStr | None = None
    end_date_exclusive: StrictStr | None = None
    recurrence_rule: StrictStr | None = None
    provider_id: StrictStr | None = Field(default=None, max_length=256)
    provider_calendar_id: StrictStr | None = Field(default=None, max_length=256)
    source_ref: StrictStr | None = Field(default=None, max_length=256)
    deleted_at: StrictStr | None = None

    _ids = field_validator("id", "audit_correlation_id")(validate_uuid4)
    _dates = _timestamp_fields(
        "created_at",
        "updated_at",
        "start_at_utc",
        "end_at_utc",
        "deleted_at",
    )

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        return validate_timezone(value, "calendar_event.timezone")

    @field_validator("start_date", "end_date_exclusive")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "calendar_event.date")

    @model_validator(mode="after")
    def _shape(self) -> "UpstreamCalendarEvent":
        if self.recurrence_rule is not None:
            raise ValueError("calendar_event.recurrence_rule is disabled in Planning v1")
        if self.all_day:
            if self.start_date is None or self.end_date_exclusive is None:
                raise ValueError("all-day event requires an exclusive date range")
            if self.start_at_utc is not None or self.end_at_utc is not None:
                raise ValueError("all-day event cannot contain timed fields")
            if date.fromisoformat(self.end_date_exclusive) <= date.fromisoformat(self.start_date):
                raise ValueError("calendar_event.end_date_exclusive must be later than start_date")
        else:
            if self.start_at_utc is None or self.end_at_utc is None:
                raise ValueError("timed event requires start and end timestamps")
            if self.start_date is not None or self.end_date_exclusive is not None:
                raise ValueError("timed event cannot contain all-day fields")
            start = datetime.fromisoformat(self.start_at_utc[:-1] + "+00:00")
            end = datetime.fromisoformat(self.end_at_utc[:-1] + "+00:00")
            if end <= start:
                raise ValueError("calendar_event.end_at_utc must be later than start_at_utc")
        return self


class UpstreamProject(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    domain: Literal["project"]
    name: StrictStr = Field(min_length=1, max_length=500)
    source: PlanningSource
    version: StrictInt = Field(ge=1)
    created_at: StrictStr
    updated_at: StrictStr
    audit_correlation_id: StrictStr = Field(min_length=36, max_length=36)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    source_ref: StrictStr | None = Field(default=None, max_length=256)
    deleted_at: StrictStr | None = None

    _ids = field_validator("id", "audit_correlation_id")(validate_uuid4)
    _dates = _timestamp_fields("created_at", "updated_at", "deleted_at")


class PlanningListEnvelope(StrictPlanningModel):
    schemaVersion: Literal["planning.v1"]
    kind: Literal["list"]
    domain: StrictStr
    generatedAt: StrictStr
    sourceStatus: Literal["current"]
    lastSyncedAt: StrictStr
    staleAfter: StrictStr
    pagination: PlanningPagination
    correlation_id: StrictStr = Field(min_length=36, max_length=36)

    _timestamps = _timestamp_fields("generatedAt", "lastSyncedAt", "staleAfter")
    _correlation = field_validator("correlation_id")(validate_uuid4)


class ReminderListEnvelope(PlanningListEnvelope):
    domain: Literal["reminder"]
    items: list[UpstreamReminder] = Field(max_length=100)


class TaskListEnvelope(PlanningListEnvelope):
    domain: Literal["task"]
    items: list[UpstreamTask] = Field(max_length=100)


class EventListEnvelope(PlanningListEnvelope):
    domain: Literal["calendar_event"]
    items: list[UpstreamCalendarEvent] = Field(max_length=100)


class ProjectListEnvelope(PlanningListEnvelope):
    domain: Literal["project"]
    items: list[UpstreamProject] = Field(max_length=100)


CapabilityToken = Literal[
    "read",
    "create",
    "update",
    "complete",
    "cancel",
    "archive",
    "delete",
]


class UpstreamCapabilities(StrictPlanningModel):
    reminders: list[CapabilityToken] = Field(max_length=8)
    tasks: list[CapabilityToken] = Field(max_length=8)
    events: list[CapabilityToken] = Field(max_length=8)
    projects: list[CapabilityToken] = Field(max_length=8)
    status: list[Literal["read"]] = Field(max_length=2)


class UpstreamTaskCapabilityMetadata(StrictPlanningModel):
    read: StrictBool
    create: StrictBool
    update: StrictBool
    complete: StrictBool
    archive: StrictBool
    local_authoritative: StrictBool


class UpstreamEventCapabilityMetadata(StrictPlanningModel):
    read: StrictBool
    create: StrictBool
    update: StrictBool
    delete: StrictBool
    recurrence: StrictBool
    provider_sync: StrictBool
    local_only: StrictBool


class UpstreamProjectCapabilityMetadata(StrictPlanningModel):
    read: StrictBool
    create: StrictBool
    update: StrictBool
    archive: StrictBool
    local_management: StrictBool


class UpstreamCapabilityMetadata(StrictPlanningModel):
    tasks: UpstreamTaskCapabilityMetadata
    events: UpstreamEventCapabilityMetadata
    projects: UpstreamProjectCapabilityMetadata


class PlanningIncident(StrictPlanningModel):
    code: StrictStr = Field(min_length=1, max_length=128)
    active: StrictBool
    aggregateCount: StrictInt = Field(ge=0)
    ageSeconds: StrictInt | None = Field(default=None, ge=0)


class UpstreamPlanningHealth(StrictPlanningModel):
    schemaVersion: Literal["planning.operations.v1"]
    observedAt: StrictStr
    planningSchemaVersion: StrictInt | None = Field(default=None, ge=1)
    dbAvailable: StrictBool
    dbIntegrityStatus: Literal["unknown", "ok", "failed"]
    queuedOutboxCount: StrictInt = Field(ge=0)
    leasedOutboxCount: StrictInt = Field(ge=0)
    retryingReminderCount: StrictInt = Field(ge=0)
    terminalFailedReminderCount: StrictInt = Field(ge=0)
    activeDueReminderCount: StrictInt = Field(ge=0)
    oldestQueuedOrLeasedOutboxAgeSeconds: StrictInt | None = Field(default=None, ge=0)
    eligibleQueuedOrLeasedOutboxCount: StrictInt = Field(ge=0)
    durableSchedulerEnabled: StrictBool
    schedulerHeartbeatAt: StrictStr | None = None
    schedulerHeartbeatAgeSeconds: StrictInt | None = Field(default=None, ge=0)
    schedulerHealth: Literal["disabled", "unknown", "healthy", "degraded"]
    backupStatus: Literal["disabled", "unavailable", "failed", "unknown", "overdue", "fresh"]
    lastSuccessfulBackupAt: StrictStr | None = None
    lastSuccessfulRestoreVerificationAt: StrictStr | None = None
    lastBackupAgeSeconds: StrictInt | None = Field(default=None, ge=0)
    lastRestoreVerificationStatus: StrictStr = Field(min_length=1, max_length=64)
    providerStatus: StrictStr = Field(min_length=1, max_length=64)
    providerLastSyncAt: StrictStr | None = None
    capabilityMetadata: UpstreamCapabilityMetadata
    applicationVersion: StrictStr = Field(min_length=1, max_length=256)
    applicationCommit: StrictStr = Field(min_length=1, max_length=256)
    incidents: list[PlanningIncident] = Field(max_length=32)

    _timestamps = _timestamp_fields(
        "observedAt",
        "schedulerHeartbeatAt",
        "lastSuccessfulBackupAt",
        "lastSuccessfulRestoreVerificationAt",
        "providerLastSyncAt",
    )


class StatusEnvelope(StrictPlanningModel):
    schemaVersion: Literal["planning.v1"]
    kind: Literal["status"]
    apiVersion: Literal["v1"]
    capabilities: UpstreamCapabilities
    storageStatus: Literal["available", "unavailable"]
    sourceStatus: Literal["current"]
    lastSyncedAt: StrictStr
    staleAfter: StrictStr
    correlation_id: StrictStr = Field(min_length=36, max_length=36)
    capabilityMetadata: UpstreamCapabilityMetadata
    planningHealth: UpstreamPlanningHealth | None = None

    _timestamps = _timestamp_fields("lastSyncedAt", "staleAfter")
    _correlation = field_validator("correlation_id")(validate_uuid4)


class ReminderObjectEnvelope(StrictPlanningModel):
    """The only canonical object response accepted by the reminder writer."""

    schemaVersion: Literal["planning.v1"]
    kind: Literal["object"]
    domain: Literal["reminder"]
    object: UpstreamReminder
    sourceStatus: Literal["current"]
    lastSyncedAt: StrictStr
    staleAfter: StrictStr
    correlation_id: StrictStr = Field(min_length=36, max_length=36)

    _timestamps = _timestamp_fields("lastSyncedAt", "staleAfter")
    _correlation = field_validator("correlation_id")(validate_uuid4)


class TaskObjectEnvelope(StrictPlanningModel):
    """The canonical task object returned by create/update/lifecycle routes."""

    schemaVersion: Literal["planning.v1"]
    kind: Literal["object"]
    domain: Literal["task"]
    object: UpstreamTask
    sourceStatus: Literal["current"]
    lastSyncedAt: StrictStr
    staleAfter: StrictStr
    correlation_id: StrictStr = Field(min_length=36, max_length=36)

    _timestamps = _timestamp_fields("lastSyncedAt", "staleAfter")
    _correlation = field_validator("correlation_id")(validate_uuid4)


class ReminderProjection(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    version: StrictInt = Field(ge=1)
    source: PlanningSource
    sourceLabel: StrictStr = Field(min_length=1, max_length=64)
    title: StrictStr = Field(min_length=1, max_length=500)
    dueAtUtc: StrictStr
    timezone: StrictStr = Field(min_length=1, max_length=64)
    status: ReminderStatus
    deliveryState: DeliveryState
    createdAt: StrictStr
    updatedAt: StrictStr

    _ids = field_validator("id")(validate_uuid4)
    _timestamps = _timestamp_fields("dueAtUtc", "createdAt", "updatedAt")

    @field_validator("dueAtUtc")
    @classmethod
    def _due(cls, value: str) -> str:
        return validate_utc_timestamp(value, "planning.reminder.dueAtUtc")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        return validate_timezone(value, "planning.reminder.timezone")


class TaskProjection(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    version: StrictInt = Field(ge=1)
    source: PlanningSource
    sourceLabel: StrictStr = Field(min_length=1, max_length=64)
    title: StrictStr = Field(min_length=1, max_length=500)
    notes: StrictStr | None = Field(default=None, max_length=4000)
    priority: TaskPriority
    status: TaskStatus
    dueDate: StrictStr | None = None
    dueTime: StrictStr | None = None
    timezone: StrictStr | None = None
    projectId: StrictStr | None = Field(default=None, min_length=36, max_length=36)
    sourceRef: StrictStr | None = Field(default=None, max_length=256)
    completedAt: StrictStr | None = None
    archivedAt: StrictStr | None = None
    deletedAt: StrictStr | None = None
    createdAt: StrictStr
    updatedAt: StrictStr

    _ids = field_validator("id")(validate_uuid4)
    _project_id = field_validator("projectId")(validate_optional_uuid4)
    _timestamps = _timestamp_fields(
        "createdAt",
        "updatedAt",
        "completedAt",
        "archivedAt",
        "deletedAt",
    )

    @field_validator("dueDate")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.task.dueDate")

    @field_validator("dueTime")
    @classmethod
    def _time(cls, value: str | None) -> str | None:
        return None if value is None else validate_local_time(value, "planning.task.dueTime")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else validate_timezone(value, "planning.task.timezone")

    @model_validator(mode="after")
    def _shape(self) -> "TaskProjection":
        if self.dueDate is None and (self.dueTime is not None or self.timezone is not None):
            raise ValueError("planning task dueTime/timezone require dueDate")
        if self.dueDate is not None and self.dueTime is None and self.timezone is not None:
            raise ValueError("planning date-only task must not contain timezone")
        if self.dueTime is not None and self.timezone is None:
            raise ValueError("planning timed task requires timezone")
        if self.dueDate is not None and self.dueTime is not None and self.timezone is not None:
            validate_local_datetime(self.dueDate, self.dueTime, self.timezone)
        return self


class CalendarEventProjection(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    version: StrictInt = Field(ge=1)
    source: PlanningSource
    sourceLabel: StrictStr = Field(min_length=1, max_length=64)
    title: StrictStr = Field(min_length=1, max_length=500)
    allDay: StrictBool
    timezone: StrictStr = Field(min_length=1, max_length=64)
    syncState: EventSyncState
    startAtUtc: StrictStr | None = None
    endAtUtc: StrictStr | None = None
    startDate: StrictStr | None = None
    endDateExclusive: StrictStr | None = None
    createdAt: StrictStr
    updatedAt: StrictStr

    _ids = field_validator("id")(validate_uuid4)
    _timestamps = _timestamp_fields("startAtUtc", "endAtUtc", "createdAt", "updatedAt")

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        return validate_timezone(value, "planning.event.timezone")

    @field_validator("startDate", "endDateExclusive")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        return None if value is None else validate_date(value, "planning.event.date")

    @model_validator(mode="after")
    def _shape(self) -> "CalendarEventProjection":
        if self.allDay:
            if self.startDate is None or self.endDateExclusive is None:
                raise ValueError("planning all-day event requires date fields")
            if self.startAtUtc is not None or self.endAtUtc is not None:
                raise ValueError("planning all-day event cannot contain timed fields")
            if date.fromisoformat(self.endDateExclusive) <= date.fromisoformat(self.startDate):
                raise ValueError("planning all-day event range is invalid")
        else:
            if self.startAtUtc is None or self.endAtUtc is None:
                raise ValueError("planning timed event requires timestamps")
            if self.startDate is not None or self.endDateExclusive is not None:
                raise ValueError("planning timed event cannot contain date fields")
            if datetime.fromisoformat(self.endAtUtc[:-1] + "+00:00") <= datetime.fromisoformat(self.startAtUtc[:-1] + "+00:00"):
                raise ValueError("planning timed event range is invalid")
        return self


class ProjectProjection(StrictPlanningModel):
    id: StrictStr = Field(min_length=36, max_length=36)
    version: StrictInt = Field(ge=1)
    source: PlanningSource
    sourceLabel: StrictStr = Field(min_length=1, max_length=64)
    name: StrictStr = Field(min_length=1, max_length=500)
    createdAt: StrictStr
    updatedAt: StrictStr

    _ids = field_validator("id")(validate_uuid4)
    _timestamps = _timestamp_fields("createdAt", "updatedAt")


class PlanningConflict(StrictPlanningModel):
    id: StrictStr = Field(min_length=10, max_length=180)
    eventIds: list[StrictStr] = Field(min_length=2, max_length=20)
    source: Literal["system"] = "system"
    sourceLabel: Literal["Panel Agent"] = "Panel Agent"
    startAtUtc: StrictStr | None = None
    endAtUtc: StrictStr | None = None

    _timestamps = _timestamp_fields("startAtUtc", "endAtUtc")

    @field_validator("eventIds")
    @classmethod
    def _event_ids(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("planning conflict contains duplicate event ids")
        for value in values:
            validate_uuid4(value, "planning.conflict.eventId")
        return values


class PlanningTaskCapabilities(StrictPlanningModel):
    create: StrictBool = False
    edit: StrictBool = False
    complete: StrictBool = False
    archive: StrictBool = False


class PlanningCapabilities(StrictPlanningModel):
    create: StrictBool = False
    edit: StrictBool = False
    complete: StrictBool = False
    cancel: StrictBool = False
    delete: StrictBool = False
    voice: StrictBool = False
    providerSync: StrictBool = False
    tasks: PlanningTaskCapabilities = Field(default_factory=PlanningTaskCapabilities)


class PlanningProviderStatus(StrictPlanningModel):
    id: Literal["native-planning"] = "native-planning"
    label: Literal["Local Planning"] = "Local Planning"
    status: Literal["local_only", "not_configured", "degraded", "offline"] = "local_only"
    configured: StrictBool = True
    lastSyncedAt: StrictStr | None = None

    _timestamps = _timestamp_fields("lastSyncedAt")


class PlanningReminderLists(StrictPlanningModel):
    upcoming: list[ReminderProjection] = Field(max_length=20)
    overdue: list[ReminderProjection] = Field(max_length=20)
    deliveryFailures: list[ReminderProjection] = Field(max_length=20)


class PlanningTaskLists(StrictPlanningModel):
    today: list[TaskProjection] = Field(max_length=20)
    overdue: list[TaskProjection] = Field(max_length=20)
    upcoming: list[TaskProjection] = Field(max_length=20)
    projects: list[ProjectProjection] = Field(max_length=20)


class PlanningCalendarLists(StrictPlanningModel):
    today: list[CalendarEventProjection] = Field(max_length=20)
    upcoming: list[CalendarEventProjection] = Field(max_length=20)
    conflicts: list[PlanningConflict] = Field(max_length=20)


class PlanningProjection(StrictPlanningModel):
    schemaVersion: Literal["planning.panel.v1"]
    generatedAt: StrictStr
    sourceStatus: PlanningSourceStatus
    lastSyncedAt: StrictStr | None = None
    staleAfter: StrictStr | None = None
    reminders: PlanningReminderLists
    tasks: PlanningTaskLists
    calendar: PlanningCalendarLists
    capabilities: PlanningCapabilities
    providerStatuses: list[PlanningProviderStatus] = Field(max_length=4)

    _timestamps = _timestamp_fields("generatedAt", "lastSyncedAt", "staleAfter")


class PlanningStatusProjection(StrictPlanningModel):
    schemaVersion: Literal["planning.panel.v1"]
    generatedAt: StrictStr
    sourceStatus: PlanningSourceStatus
    lastSyncedAt: StrictStr | None = None
    staleAfter: StrictStr | None = None
    capabilities: PlanningCapabilities
    providerStatuses: list[PlanningProviderStatus] = Field(max_length=4)

    _timestamps = _timestamp_fields("generatedAt", "lastSyncedAt", "staleAfter")


class PlanningReadEnvelope(StrictPlanningModel):
    schemaVersion: Literal["planning.panel.v1"]
    kind: Literal["list"]
    domain: Literal["reminder", "task", "calendar_event", "project"]
    generatedAt: StrictStr
    sourceStatus: PlanningSourceStatus
    lastSyncedAt: StrictStr | None = None
    staleAfter: StrictStr | None = None
    items: list[
        ReminderProjection
        | TaskProjection
        | CalendarEventProjection
        | ProjectProjection
    ] = Field(max_length=100)
    limit: StrictInt = Field(ge=1, le=100)
    offset: StrictInt = Field(ge=0, le=10_000)
    count: StrictInt = Field(ge=0, le=100)
    hasMore: StrictBool

    _timestamps = _timestamp_fields("generatedAt", "lastSyncedAt", "staleAfter")


class PlanningObjectEnvelope(StrictPlanningModel):
    """Browser-safe canonical object readback after a reminder mutation."""

    schemaVersion: Literal["planning.panel.v1"]
    kind: Literal["object"]
    domain: Literal["reminder"]
    object: ReminderProjection
    sourceStatus: PlanningSourceStatus
    lastSyncedAt: StrictStr | None = None
    staleAfter: StrictStr | None = None

    _timestamps = _timestamp_fields("lastSyncedAt", "staleAfter")


class PlanningTaskObjectEnvelope(StrictPlanningModel):
    """Browser-safe canonical task object readback."""

    schemaVersion: Literal["planning.panel.v1"]
    kind: Literal["object"]
    domain: Literal["task"]
    object: TaskProjection
    sourceStatus: PlanningSourceStatus
    lastSyncedAt: StrictStr | None = None
    staleAfter: StrictStr | None = None

    _timestamps = _timestamp_fields("lastSyncedAt", "staleAfter")


class PlanningParsePreview(StrictPlanningModel):
    """Closed relay for the canonical non-mutating parser preview."""

    schemaVersion: Literal["planning.v1"]
    kind: Literal["parse_preview"]
    candidate: dict[str, Any] | None = None
    confidence: Literal["high", "medium", "low"]
    ambiguities: list[dict[str, Any]] = Field(max_length=16)
    requires_confirmation: StrictBool
    normalized_text: StrictStr = Field(max_length=2000)
    error_code: StrictStr | None = Field(default=None, max_length=128)
    correlation_id: StrictStr = Field(min_length=36, max_length=36)

    _correlation = field_validator("correlation_id")(validate_uuid4)


def source_label(source: str) -> str:
    return {
        "alice": "AliceTG Bot",
        "telegram": "Telegram",
        "panel-agent": "Panel Agent",
        "operator": "Operator",
        "ticktick": "TickTick",
        "calendar-provider": "Calendar provider",
        "system": "System",
    }.get(source, "Planning")


def timestamp_datetime(value: str) -> datetime:
    validate_utc_timestamp(value)
    return datetime.fromisoformat(value[:-1] + "+00:00")


def empty_planning_projection(
    *,
    generated_at: str,
    source_status: PlanningSourceStatus,
    last_synced_at: str | None = None,
    stale_after: str | None = None,
    provider_status: Literal["local_only", "not_configured", "degraded", "offline"] = "local_only",
) -> PlanningProjection:
    return PlanningProjection(
        schemaVersion=PLANNING_PANEL_SCHEMA,
        generatedAt=generated_at,
        sourceStatus=source_status,
        lastSyncedAt=last_synced_at,
        staleAfter=stale_after,
        reminders=PlanningReminderLists(upcoming=[], overdue=[], deliveryFailures=[]),
        tasks=PlanningTaskLists(today=[], overdue=[], upcoming=[], projects=[]),
        calendar=PlanningCalendarLists(today=[], upcoming=[], conflicts=[]),
        capabilities=PlanningCapabilities(),
        providerStatuses=[PlanningProviderStatus(status=provider_status)],
    )


def status_projection(projection: PlanningProjection) -> PlanningStatusProjection:
    return PlanningStatusProjection(
        schemaVersion=projection.schemaVersion,
        generatedAt=projection.generatedAt,
        sourceStatus=projection.sourceStatus,
        lastSyncedAt=projection.lastSyncedAt,
        staleAfter=projection.staleAfter,
        capabilities=projection.capabilities,
        providerStatuses=projection.providerStatuses,
    )
