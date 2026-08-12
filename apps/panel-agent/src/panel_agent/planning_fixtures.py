"""Deterministic synthetic Planning v1 transport for local tests and fixtures."""

from __future__ import annotations

import json
from typing import Any

import httpx


FIXTURE_TIMESTAMP = "2026-08-12T09:00:00Z"
FIXTURE_STALE_AFTER = "2026-08-12T09:05:00Z"
PLANNING_FIXTURE_SCENARIOS = frozenset(
    {
        "healthy",
        "current",
        "empty",
        "reminders",
        "tasks",
        "events",
        "project",
        "delivery-failure",
        "degraded",
        "timeout",
        "malformed",
        "incompatible",
        "offline",
        "oversized",
    }
)
_IDS = {
    "reminder": "00000000-0000-4000-8000-000000000001",
    "failure": "00000000-0000-4000-8000-000000000002",
    "today_task": "00000000-0000-4000-8000-000000000003",
    "overdue_task": "00000000-0000-4000-8000-000000000004",
    "upcoming_task": "00000000-0000-4000-8000-000000000005",
    "project": "00000000-0000-4000-8000-000000000006",
    "timed_event": "00000000-0000-4000-8000-000000000007",
    "all_day_event": "00000000-0000-4000-8000-000000000008",
}


class PlanningFixtureTransport(httpx.AsyncBaseTransport):
    """A fixed-route synthetic server; it never contacts a network."""

    def __init__(self, scenario: str = "healthy") -> None:
        if scenario not in PLANNING_FIXTURE_SCENARIOS:
            raise ValueError("unknown Planning fixture scenario")
        self.scenario = scenario
        self.calls: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        if request.method != "GET":
            return httpx.Response(405, request=request)
        if (
            not request.headers.get("x-internal-secret")
            or request.headers.get("x-planning-audience") != "panel-agent"
            or not request.headers.get("x-planning-secret")
        ):
            return httpx.Response(401, request=request)
        if self.scenario == "timeout":
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if self.scenario == "offline":
            raise httpx.ConnectError("fixture offline", request=request)
        if self.scenario == "malformed":
            return httpx.Response(200, content=b"{not-json", request=request)
        if self.scenario == "oversized":
            return httpx.Response(200, content=b"x" * 300_000, request=request)

        payload = fixture_payload(self.scenario, request.url.path, request.url.params)
        if payload is None:
            return httpx.Response(404, request=request)
        if self.scenario == "incompatible":
            payload["schemaVersion"] = "planning.v2"
        return httpx.Response(
            200,
            content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers={"content-type": "application/json"},
            request=request,
        )


def fixture_payload(scenario: str, path: str, query: httpx.QueryParams | None = None) -> dict[str, Any] | None:
    if path == "/internal/planning/v1/status":
        return _status(scenario)
    if path == "/internal/planning/v1/reminders":
        return _list_envelope(
            "reminder",
            [] if scenario == "empty" else [_reminder(), _failure_reminder()],
        )
    if path == "/internal/planning/v1/tasks":
        if scenario == "empty":
            items: list[dict[str, Any]] = []
        else:
            view = query.get("view") if query is not None else None
            items = {
                "today": [_task("today_task", "2026-08-12", "high")],
                "overdue": [_task("overdue_task", "2026-08-11", "normal")],
                "upcoming": [_task("upcoming_task", "2026-08-15", "low")],
            }.get(view or "today", [])
        return _list_envelope("task", items)
    if path == "/internal/planning/v1/events":
        return _list_envelope(
            "calendar_event",
            []
            if scenario == "empty"
            else [_timed_event(), _all_day_event()],
        )
    if path == "/internal/planning/v1/projects":
        return _list_envelope(
            "project",
            [] if scenario == "empty" else [_project()],
        )
    return None


def _list_envelope(domain: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    correlation = "00000000-0000-4000-8000-000000000099"
    return {
        "schemaVersion": "planning.v1",
        "kind": "list",
        "domain": domain,
        "items": items,
        "generatedAt": FIXTURE_TIMESTAMP,
        "sourceStatus": "current",
        "lastSyncedAt": FIXTURE_TIMESTAMP,
        "staleAfter": FIXTURE_STALE_AFTER,
        "pagination": {
            "limit": 20,
            "offset": 0,
            "count": len(items),
            "has_more": False,
            "next_offset": None,
        },
        "correlation_id": correlation,
    }


def _status(scenario: str) -> dict[str, Any]:
    degraded = scenario == "degraded"
    return {
        "schemaVersion": "planning.v1",
        "kind": "status",
        "apiVersion": "v1",
        "capabilities": {
            "reminders": ["read", "create", "update", "complete", "cancel"],
            "tasks": ["read", "create", "update", "complete", "archive"],
            "events": ["read", "create", "update", "delete"],
            "projects": ["read"],
            "status": ["read"],
        },
        "storageStatus": "available",
        "sourceStatus": "current",
        "lastSyncedAt": FIXTURE_TIMESTAMP,
        "staleAfter": FIXTURE_STALE_AFTER,
        "correlation_id": "00000000-0000-4000-8000-000000000098",
        "capabilityMetadata": {
            "tasks": {
                "read": True,
                "create": True,
                "update": True,
                "complete": True,
                "archive": True,
                "local_authoritative": True,
            },
            "events": {
                "read": True,
                "create": True,
                "update": True,
                "delete": True,
                "recurrence": False,
                "provider_sync": False,
                "local_only": True,
            },
            "projects": {
                "read": True,
                "create": True,
                "update": True,
                "archive": True,
                "local_management": True,
            },
        },
        "planningHealth": (
            {
                "schemaVersion": "planning.operations.v1",
                "observedAt": FIXTURE_TIMESTAMP,
                "planningSchemaVersion": 4,
                "dbAvailable": True,
                "dbIntegrityStatus": "ok",
                "queuedOutboxCount": 0,
                "leasedOutboxCount": 0,
                "retryingReminderCount": 0,
                "terminalFailedReminderCount": 0,
                "activeDueReminderCount": 0,
                "oldestQueuedOrLeasedOutboxAgeSeconds": None,
                "eligibleQueuedOrLeasedOutboxCount": 0,
                "durableSchedulerEnabled": True,
                "schedulerHeartbeatAt": FIXTURE_TIMESTAMP,
                "schedulerHeartbeatAgeSeconds": 0,
                "schedulerHealth": "degraded" if degraded else "healthy",
                "backupStatus": "fresh",
                "lastSuccessfulBackupAt": FIXTURE_TIMESTAMP,
                "lastSuccessfulRestoreVerificationAt": FIXTURE_TIMESTAMP,
                "lastBackupAgeSeconds": 0,
                "lastRestoreVerificationStatus": "ok",
                "providerStatus": "degraded" if degraded else "not_configured",
                "providerLastSyncAt": None,
                "capabilityMetadata": {
                    "tasks": {
                        "read": True,
                        "create": True,
                        "update": True,
                        "complete": True,
                        "archive": True,
                        "local_authoritative": True,
                    },
                    "events": {
                        "read": True,
                        "create": True,
                        "update": True,
                        "delete": True,
                        "recurrence": False,
                        "provider_sync": False,
                        "local_only": True,
                    },
                    "projects": {
                        "read": True,
                        "create": True,
                        "update": True,
                        "archive": True,
                        "local_management": True,
                    },
                },
                "applicationVersion": "fixture",
                "applicationCommit": "fixture",
                "incidents": (
                    [{"code": "planning.fixture_degraded", "active": True, "aggregateCount": 1, "ageSeconds": 0}]
                    if degraded
                    else []
                ),
            }
            if degraded
            else None
        ),
    }


def _common(identifier: str, *, source: str = "alice") -> dict[str, Any]:
    return {
        "id": _IDS[identifier],
        "source": source,
        "version": 1,
        "created_at": FIXTURE_TIMESTAMP,
        "updated_at": FIXTURE_TIMESTAMP,
        "audit_correlation_id": "00000000-0000-4000-8000-000000000097",
    }


def _reminder() -> dict[str, Any]:
    return {
        **_common("reminder"),
        "domain": "reminder",
        "title": "Synthetic reminder",
        "due_at_utc": "2026-08-12T10:00:00Z",
        "timezone": "Europe/Moscow",
        "status": "pending",
        "created_by": "fixture",
        "delivery_state": "not_due",
        "notes": None,
        "source_ref": None,
        "completed_at": None,
        "cancelled_at": None,
        "next_attempt_at": None,
        "final_failure_at": None,
        "deleted_at": None,
    }


def _failure_reminder() -> dict[str, Any]:
    return {
        **_reminder(),
        "id": _IDS["failure"],
        "title": "Synthetic delivery failure",
        "status": "due",
        "delivery_state": "failed",
        "final_failure_at": FIXTURE_TIMESTAMP,
    }


def _task(identifier: str, due_date: str, priority: str) -> dict[str, Any]:
    return {
        **_common(identifier),
        "domain": "task",
        "title": f"Synthetic {identifier.replace('_', ' ')}",
        "priority": priority,
        "status": "open",
        "notes": None,
        "due_date": due_date,
        "due_time": None,
        "timezone": None,
        "project_id": _IDS["project"],
        "source_ref": None,
        "completed_at": None,
        "archived_at": None,
        "deleted_at": None,
    }


def _timed_event() -> dict[str, Any]:
    return {
        **_common("timed_event", source="system"),
        "domain": "calendar_event",
        "title": "Synthetic timed event",
        "all_day": False,
        "timezone": "Europe/Moscow",
        "sync_state": "local_only",
        "notes": None,
        "location": None,
        "start_at_utc": "2026-08-12T12:00:00Z",
        "end_at_utc": "2026-08-12T13:00:00Z",
        "start_date": None,
        "end_date_exclusive": None,
        "recurrence_rule": None,
        "provider_id": None,
        "provider_calendar_id": None,
        "source_ref": None,
        "deleted_at": None,
    }


def _all_day_event() -> dict[str, Any]:
    return {
        **_common("all_day_event", source="system"),
        "domain": "calendar_event",
        "title": "Synthetic all-day event",
        "all_day": True,
        "timezone": "Europe/Moscow",
        "sync_state": "local_only",
        "notes": None,
        "location": None,
        "start_at_utc": None,
        "end_at_utc": None,
        "start_date": "2026-08-12",
        "end_date_exclusive": "2026-08-13",
        "recurrence_rule": None,
        "provider_id": None,
        "provider_calendar_id": None,
        "source_ref": None,
        "deleted_at": None,
    }


def _project() -> dict[str, Any]:
    return {
        **_common("project"),
        "domain": "project",
        "name": "Synthetic project",
        "notes": None,
        "source_ref": None,
        "deleted_at": None,
    }
