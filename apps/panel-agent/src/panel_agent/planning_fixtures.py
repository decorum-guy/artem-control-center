"""Deterministic synthetic Planning v1 transport for local tests and fixtures."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx


FIXTURE_TIMESTAMP = "2026-08-12T09:00:00Z"
FIXTURE_STALE_AFTER = "2026-08-12T09:05:00Z"
_FIXTURE_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)


def fixture_reference_datetime() -> datetime:
    """Return the canonical wall-clock instant used by Planning fixtures."""

    return datetime.fromisoformat(FIXTURE_TIMESTAMP.replace("Z", "+00:00"))


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
        "route-pagination",
        "overview-healthy",
        "overview-empty",
        "overview-reminder-soon",
        "overview-task-priorities",
        "overview-timed-event",
        "overview-all-day-event",
        "overview-degraded",
        "overview-delivery-failure",
        "overview-delivered-open",
        "overview-long-russian",
        "overview-bounded-20",
        "b3-healthy",
        "b3-empty",
        "b3-route-pagination",
        "b3-route-budget",
        "b3-composed-route-pagination",
        "b3-long-russian",
        "b3-overlap",
        "reminder-gate-off",
        "reminder-open-due",
        "reminder-delivered-open",
        "reminder-completed",
        "reminder-cancelled",
        "reminder-create-success",
        "reminder-edit-success",
        "reminder-reschedule-success",
        "reminder-complete-success",
        "reminder-cancel-success",
        "reminder-conflict",
        "reminder-uncertain",
        "reminder-unavailable",
    }
)
_IDS = {
    "reminder": "00000000-0000-4000-8000-000000000001",
    "failure": "00000000-0000-4000-8000-000000000002",
    "delivered": "00000000-0000-4000-8000-000000000009",
    "due_normal": "00000000-0000-4000-8000-000000000010",
    "completed_future": "00000000-0000-4000-8000-000000000011",
    "completed_past": "00000000-0000-4000-8000-000000000012",
    "cancelled": "00000000-0000-4000-8000-000000000013",
    "today_task": "00000000-0000-4000-8000-000000000003",
    "overdue_task": "00000000-0000-4000-8000-000000000004",
    "upcoming_task": "00000000-0000-4000-8000-000000000005",
    "undated_no_project": "00000000-0000-4000-8000-000000000014",
    "undated_project": "00000000-0000-4000-8000-000000000015",
    "project": "00000000-0000-4000-8000-000000000006",
    "timed_event": "00000000-0000-4000-8000-000000000007",
    "all_day_event": "00000000-0000-4000-8000-000000000008",
    "mutation_created": "00000000-0000-4000-8000-000000000099",
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
        if request.method == "POST" and request.url.path == "/internal/planning/v1/calendar-sources/refresh":
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
            return httpx.Response(
                200,
                json={
                    "schemaVersion": "planning.calendar-sources.refresh.v1",
                    "kind": "calendar_sources_refresh",
                    "result": "success",
                    "status": "current",
                    "observedAt": FIXTURE_TIMESTAMP,
                    "lastSuccessfulSyncAt": FIXTURE_TIMESTAMP,
                    "calendarsSeen": 0,
                    "eventsSeen": 0,
                    "errorCode": None,
                    "correlation_id": "00000000-0000-4000-8000-000000000097",
                },
                request=request,
            )
        if request.method in {"POST", "PATCH"} and _is_reminder_mutation_path(request.url.path):
            if (
                not request.headers.get("x-internal-secret")
                or request.headers.get("x-planning-audience") != "panel-agent"
                or not request.headers.get("x-planning-secret")
            ):
                return httpx.Response(401, request=request)
            if self.scenario in {"timeout", "reminder-uncertain"}:
                raise httpx.ReadTimeout("fixture mutation timeout", request=request)
            if self.scenario in {"offline", "reminder-unavailable"}:
                raise httpx.ConnectError("fixture mutation unavailable", request=request)
            if self.scenario == "reminder-conflict":
                return httpx.Response(409, json={"error": {"code": "version_conflict"}}, request=request)
            return _reminder_mutation_response(request)
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
        if self.scenario in {"offline", "reminder-unavailable"}:
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
        items = _filter_reminders(_reminder_items(scenario), query)
        return _list_envelope("reminder", items, query=query)
    if path == "/internal/planning/v1/tasks":
        if scenario in {"empty", "overview-empty", "b3-empty"}:
            items: list[dict[str, Any]] = []
        elif scenario in {"route-pagination", "b3-route-pagination"}:
            view = query.get("view") if query is not None else "today"
            items = _route_tasks(view or "today", b3=scenario == "b3-route-pagination")
        else:
            view = query.get("view") if query is not None else None
            items = _task_items(scenario, view or "today")
        items = _filter_tasks(items, query)
        return _list_envelope("task", items, query=query)
    if path == "/internal/planning/v1/events":
        items = [] if scenario in {"empty", "overview-empty", "b3-empty"} else _event_items(scenario)
        return _list_envelope(
            "calendar_event",
            _filter_events(items, query),
            query=query,
        )
    if path == "/internal/planning/v1/projects":
        items = [] if scenario in {"empty", "overview-empty"} else _project_items(scenario)
        return _list_envelope("project", items, query=query)
    return None


def _list_envelope(
    domain: str,
    items: list[dict[str, Any]],
    *,
    query: httpx.QueryParams | None = None,
) -> dict[str, Any]:
    correlation = "00000000-0000-4000-8000-000000000099"
    limit = int(query.get("limit", "20")) if query is not None else 20
    offset = int(query.get("offset", "0")) if query is not None else 0
    selected = items[offset : offset + limit]
    return {
        "schemaVersion": "planning.v1",
        "kind": "list",
        "domain": domain,
        "items": selected,
        "generatedAt": FIXTURE_TIMESTAMP,
        "sourceStatus": "current",
        "lastSyncedAt": FIXTURE_TIMESTAMP,
        "staleAfter": FIXTURE_STALE_AFTER,
        "pagination": {
            "limit": limit,
            "offset": offset,
            "count": len(selected),
            "has_more": offset + len(selected) < len(items),
            "next_offset": offset + len(selected) if offset + len(selected) < len(items) else None,
        },
        "correlation_id": correlation,
    }


def _synthetic_uuid(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012d}"


def _reminder_items(scenario: str) -> list[dict[str, Any]]:
    if scenario in {"empty", "overview-empty", "b3-empty"}:
        return []
    if scenario in {"b3-healthy", "b3-overlap", "b3-long-russian"}:
        return _b3_reminder_items(long_russian=scenario == "b3-long-russian")
    if scenario == "b3-route-pagination":
        return _b3_paged_reminder_items()
    if scenario == "b3-route-budget":
        return _b3_budget_reminder_items()
    if scenario == "b3-composed-route-pagination":
        return _b3_composed_paged_reminder_items()
    if scenario == "reminder-open-due":
        return [_due_normal_reminder()]
    if scenario == "reminder-delivered-open":
        return [_delivered_reminder()]
    if scenario == "reminder-completed":
        return [_completed_reminder("completed_future", "2026-08-12T11:00:00Z")]
    if scenario == "reminder-cancelled":
        return [_cancelled_reminder()]
    if scenario == "overview-delivery-failure":
        return [_reminder(), _failure_reminder()]
    if scenario == "overview-delivered-open":
        return [_delivered_reminder(due_at_utc="2026-08-12T09:45:00Z")]
    if scenario == "overview-reminder-soon":
        return [_reminder(due_at_utc="2026-08-12T09:40:00Z")]
    if scenario == "overview-long-russian":
        return [_reminder(
            title="Проверить длинное русское напоминание о доставке документов в бухгалтерию до конца рабочего дня",
        )]
    return [
        _reminder(),
        _failure_reminder(),
        _due_normal_reminder(),
        _delivered_reminder(),
        _completed_reminder("completed_future", "2026-08-12T11:00:00Z"),
        _completed_reminder("completed_past", "2026-08-11T08:00:00Z"),
        _cancelled_reminder(),
    ]


def _is_reminder_mutation_path(path: str) -> bool:
    prefix = "/internal/planning/v1/reminders"
    if path == prefix:
        return True
    parts = path.removeprefix(prefix).split("/")
    if len(parts) == 2 and parts[0] == "" and _FIXTURE_UUID4.fullmatch(parts[1]):
        return True
    return len(parts) == 3 and parts[0] == "" and _FIXTURE_UUID4.fullmatch(parts[1]) and parts[2] in {"complete", "cancel"}


def _reminder_mutation_response(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    item = _reminder()
    if path == "/internal/planning/v1/reminders":
        try:
            body = json.loads(request.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return httpx.Response(422, json={"error": {"code": "validation_error"}}, request=request)
        item.update({
            key: body[key]
            for key in ("title", "notes", "due_at_utc", "timezone")
            if key in body
        })
        item["id"] = _IDS["mutation_created"]
    elif path.endswith("/complete"):
        item["status"] = "completed"
        item["completed_at"] = FIXTURE_TIMESTAMP
    elif path.endswith("/cancel"):
        item["status"] = "cancelled"
        item["cancelled_at"] = FIXTURE_TIMESTAMP
        item["deleted_at"] = FIXTURE_TIMESTAMP
    else:
        try:
            body = json.loads(request.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return httpx.Response(422, json={"error": {"code": "validation_error"}}, request=request)
        item["id"] = path.rsplit("/", 1)[-1]
        item.update({
            key: body[key]
            for key in ("title", "notes", "due_at_utc", "timezone")
            if key in body
        })
    item["version"] = 2
    return httpx.Response(
        200,
        content=json.dumps({
            "schemaVersion": "planning.v1",
            "kind": "object",
            "domain": "reminder",
            "object": item,
            "sourceStatus": "current",
            "lastSyncedAt": FIXTURE_TIMESTAMP,
            "staleAfter": FIXTURE_STALE_AFTER,
            "correlation_id": "00000000-0000-4000-8000-000000000099",
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json"},
        request=request,
    )


def _filter_reminders(
    items: list[dict[str, Any]],
    query: httpx.QueryParams | None,
) -> list[dict[str, Any]]:
    query = query or httpx.QueryParams()
    state = query.get("state")
    from_utc = query.get("from")
    to_utc = query.get("to")
    result = []
    for item in items:
        if state == "cancelled":
            if item["status"] != "cancelled":
                continue
        else:
            if item["deleted_at"] is not None:
                continue
            if state is not None and item["status"] != state:
                continue
        if from_utc is not None and item["due_at_utc"] < from_utc:
            continue
        if to_utc is not None and item["due_at_utc"] >= to_utc:
            continue
        result.append(item)
    return sorted(result, key=lambda item: (item["due_at_utc"], item["id"]))


def _route_tasks(view: str, *, b3: bool = False) -> list[dict[str, Any]]:
    if view == "undated":
        return [
            _task("undated_no_project", None, "normal", project_id=None),
            _task("undated_project", None, "low"),
        ]
    due_date = {
        "today": "2026-08-12",
        "overdue": "2026-08-11",
        "upcoming": "2026-08-15",
    }.get(view, "2026-08-12")
    if b3:
        return _b3_paged_tasks(view)
    return [
        _task(
            "today_task",
            due_date,
            "normal",
            object_id=_synthetic_uuid(1000 + index),
        )
        for index in range(60)
    ]


def _filter_tasks(
    items: list[dict[str, Any]],
    query: httpx.QueryParams | None,
) -> list[dict[str, Any]]:
    project_id = query.get("project_id") if query is not None else None
    if project_id is None:
        return items
    return [item for item in items if item.get("project_id") == project_id]


def _b3_reminder_items(*, long_russian: bool = False) -> list[dict[str, Any]]:
    return [
        _reminder(
            due_at_utc="2026-08-13T10:00:00Z",
            title=(
                "Проверить длинное русское напоминание о доставке документов в бухгалтерию до конца рабочего дня"
                if long_russian
                else "Подготовить документы к отправке"
            ),
        ),
        _reminder_variant(
            "b3_overdue_pending",
            "Просроченное напоминание",
            "2026-08-12T07:30:00Z",
            object_id=_synthetic_uuid(5001),
            status="pending",
            delivery_state="not_due",
        ),
        _reminder_variant(
            "b3_due_queued",
            "Доставить документы",
            "2026-08-12T08:00:00Z",
            object_id=_synthetic_uuid(5002),
            status="due",
            delivery_state="queued",
        ),
        _reminder_variant(
            "b3_due_retrying",
            "Повторить доставку",
            "2026-08-12T08:15:00Z",
            object_id=_synthetic_uuid(5003),
            status="due",
            delivery_state="retrying",
            next_attempt_at="2026-08-12T09:15:00Z",
        ),
        _reminder_variant(
            "b3_due_delivered",
            "Доставлено, ждёт завершения",
            "2026-08-12T08:30:00Z",
            object_id=_synthetic_uuid(5004),
            status="due",
            delivery_state="delivered",
        ),
        _reminder_variant(
            "b3_due_failed",
            "Проверить сбой доставки",
            "2026-08-12T08:45:00Z",
            object_id=_synthetic_uuid(5005),
            status="due",
            delivery_state="failed",
            final_failure_at="2026-08-12T08:50:00Z",
        ),
        _completed_reminder("completed_future", "2026-08-12T11:00:00Z"),
        _cancelled_reminder(),
    ]


def _b3_paged_reminder_items() -> list[dict[str, Any]]:
    return _b3_delivery_page_items(count=140, id_start=6000, title_prefix="Контроль доставки")


def _b3_budget_reminder_items() -> list[dict[str, Any]]:
    return _b3_delivery_page_items(count=260, id_start=6500, title_prefix="Бюджет доставки")


def _b3_delivery_page_items(
    *,
    count: int,
    id_start: int,
    title_prefix: str,
) -> list[dict[str, Any]]:
    base = datetime(2026, 8, 12, 7, 0, tzinfo=timezone.utc)
    result: list[dict[str, Any]] = []
    for index in range(count):
        due = (base + timedelta(minutes=index)).isoformat(timespec="seconds").replace("+00:00", "Z")
        delivery_state = ("failed", "retrying", "queued")[index % 3]
        result.append(
            _reminder_variant(
                f"b3_paged_reminder_{index}",
                f"{title_prefix} {index + 1}",
                due,
                object_id=_synthetic_uuid(id_start + index),
                status="due",
                delivery_state=delivery_state,
                final_failure_at=FIXTURE_TIMESTAMP if delivery_state == "failed" else None,
            )
        )
    return result


def _b3_composed_paged_reminder_items() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    upcoming_base = datetime(2026, 8, 12, 10, 0, tzinfo=timezone.utc)
    overdue_base = datetime(2026, 8, 12, 6, 0, tzinfo=timezone.utc)
    for index in range(120):
        upcoming_due = (upcoming_base + timedelta(minutes=index)).isoformat(timespec="seconds").replace("+00:00", "Z")
        overdue_due = (overdue_base + timedelta(minutes=index)).isoformat(timespec="seconds").replace("+00:00", "Z")
        result.extend(
            [
                _reminder_variant(
                    f"b3_composed_pending_{index}",
                    f"Составное ожидающее {index + 1}",
                    upcoming_due,
                    object_id=_synthetic_uuid(7000 + index),
                    status="pending",
                    delivery_state="not_due",
                ),
                _reminder_variant(
                    f"b3_composed_due_upcoming_{index}",
                    f"Составное due скоро {index + 1}",
                    upcoming_due,
                    object_id=_synthetic_uuid(7200 + index),
                    status="due",
                    delivery_state="not_due",
                ),
                _reminder_variant(
                    f"b3_composed_due_overdue_{index}",
                    f"Составное due просрочено {index + 1}",
                    overdue_due,
                    object_id=_synthetic_uuid(7400 + index),
                    status="due",
                    delivery_state="not_due",
                ),
                _reminder_variant(
                    f"b3_composed_pending_overdue_{index}",
                    f"Составное pending просрочено {index + 1}",
                    overdue_due,
                    object_id=_synthetic_uuid(7600 + index),
                    status="pending",
                    delivery_state="not_due",
                ),
            ]
        )
    return result


def _reminder_variant(
    identifier: str,
    title: str,
    due_at_utc: str,
    *,
    object_id: str | None = None,
    status: str,
    delivery_state: str,
    next_attempt_at: str | None = None,
    final_failure_at: str | None = None,
) -> dict[str, Any]:
    item = _reminder(due_at_utc=due_at_utc, title=title)
    item.update(
        {
            "id": object_id or _synthetic_uuid(5000),
            "status": status,
            "delivery_state": delivery_state,
            "next_attempt_at": next_attempt_at,
            "final_failure_at": final_failure_at,
        }
    )
    return item


def _b3_tasks(view: str, *, long_russian: bool = False) -> list[dict[str, Any]]:
    if view == "undated":
        return [
            _task("undated_no_project", None, "normal", project_id=None),
            _task("undated_project", None, "low"),
        ]
    if view == "today":
        return [
            _task("today_task", "2026-08-12", "high", due_time="10:30", timezone_name="Europe/Moscow"),
            _task("today_task", "2026-08-12", "normal", object_id=_synthetic_uuid(5101), project_id=None),
            _task("today_task", "2026-08-12", "low", object_id=_synthetic_uuid(5102), due_time="14:30", timezone_name="Europe/Berlin"),
            _task("today_task", "2026-08-12", "none", object_id=_synthetic_uuid(5103), due_time=None, timezone_name=None),
        ]
    if view == "overdue":
        return [
            _task("overdue_task", "2026-08-11", "high", title=(
                "Подготовить очень длинную просроченную задачу для квартального отчёта https://example.com light.turn_on /etc/passwd"
                if long_russian
                else "Согласовать квартальный отчёт"
            ), due_time="15:20", timezone_name="Europe/Moscow"),
            _task("overdue_task", "2026-08-10", "normal", object_id=_synthetic_uuid(5104), project_id=None),
            _task("overdue_task", "2026-08-09", "low", object_id=_synthetic_uuid(5105), due_time=None, timezone_name=None),
            _task("overdue_task", "2026-08-08", "none", object_id=_synthetic_uuid(5106), due_time="09:00", timezone_name="Europe/Berlin"),
        ]
    return [
        _task("upcoming_task", "2026-08-15", "normal", due_time="09:30", timezone_name="Europe/Moscow"),
        _task("upcoming_task", "2026-08-16", "low", object_id=_synthetic_uuid(5107), project_id=None),
    ]


def _b3_paged_tasks(view: str) -> list[dict[str, Any]]:
    due_date = {"today": "2026-08-12", "overdue": "2026-08-11", "upcoming": "2026-08-15"}.get(view)
    return [
        _task(
            "today_task",
            due_date,
            ("high", "normal", "low", "none")[index % 4],
            object_id=_synthetic_uuid(5200 + index),
            due_time=(None if due_date is None or index % 5 == 0 else "10:00"),
            timezone_name=(None if due_date is None or index % 5 == 0 else "Europe/Moscow"),
            project_id=(None if index % 4 == 0 else _IDS["project"]),
        )
        for index in range(60)
    ]


def _b3_events(*, long_russian: bool = False) -> list[dict[str, Any]]:
    return [
        _all_day_event(
            object_id=_IDS["all_day_event"],
            title="Командировка · несколько дней",
            start_date="2026-08-12",
            end_date_exclusive="2026-08-14",
        ),
        _timed_event(
            object_id=_IDS["timed_event"],
            title=(
                "Длинная встреча с русским названием, которое должно спокойно занимать две строки"
                if long_russian
                else "Утреннее совещание"
            ),
            start_at_utc="2026-08-12T06:00:00Z",
            end_at_utc="2026-08-12T07:00:00Z",
        ),
        _timed_event(
            object_id=_synthetic_uuid(5301),
            title="Текущая встреча",
            start_at_utc="2026-08-12T08:30:00Z",
            end_at_utc="2026-08-12T09:30:00Z",
        ),
        _timed_event(
            object_id=_synthetic_uuid(5302),
            title="Первая пересекающаяся встреча",
            start_at_utc="2026-08-12T10:00:00Z",
            end_at_utc="2026-08-12T11:00:00Z",
        ),
        _timed_event(
            object_id=_synthetic_uuid(5303),
            title="Вторая пересекающаяся встреча",
            start_at_utc="2026-08-12T10:30:00Z",
            end_at_utc="2026-08-12T11:30:00Z",
        ),
        _timed_event(
            object_id=_synthetic_uuid(5304),
            title="Граничная встреча",
            start_at_utc="2026-08-12T11:30:00Z",
            end_at_utc="2026-08-12T12:00:00Z",
        ),
        _timed_event(
            object_id=_synthetic_uuid(5305),
            title="Встреча в Берлине",
            timezone="Europe/Berlin",
            start_at_utc="2026-08-13T07:00:00Z",
            end_at_utc="2026-08-13T08:00:00Z",
        ),
    ]


def _b3_paged_events() -> list[dict[str, Any]]:
    base = datetime(2026, 8, 12, 10, 0, tzinfo=timezone.utc)
    return [
        _timed_event(
            object_id=_synthetic_uuid(5400 + index),
            title=f"Событие повестки {index + 1}",
            start_at_utc=(base + timedelta(hours=index * 3)).isoformat(timespec="seconds").replace("+00:00", "Z"),
            end_at_utc=(base + timedelta(hours=index * 3 + 1)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        )
        for index in range(30)
    ]


def _task_items(scenario: str, view: str) -> list[dict[str, Any]]:
    if scenario in {"b3-healthy", "b3-overlap", "b3-long-russian"}:
        return _b3_tasks(view, long_russian=scenario == "b3-long-russian")
    if scenario == "overview-task-priorities" and view == "overdue":
        return [
            _task("overdue_task", "2026-08-12", "high", title="Высокий приоритет"),
            _task("overdue_task", "2026-08-11", "normal", object_id=_synthetic_uuid(4001), title="Обычный приоритет"),
            _task("overdue_task", "2026-08-10", "low", object_id=_synthetic_uuid(4002), title="Низкий приоритет"),
            _task("overdue_task", "2026-08-09", "none", object_id=_synthetic_uuid(4003), title="Без приоритета"),
        ]
    if scenario == "overview-bounded-20" and view == "overdue":
        return [
            _task(
                "overdue_task",
                "2026-08-11",
                "normal" if index else "high",
                object_id=_synthetic_uuid(4000 + index),
                title=f"Открытая просроченная задача {index + 1}",
            )
            for index in range(20)
        ]
    if scenario == "overview-long-russian" and view == "overdue":
        return [_task(
            "overdue_task",
            "2026-08-11",
            "high",
            title="Подготовить очень длинную просроченную задачу для квартального отчёта https://example.com light.turn_on /etc/passwd",
        )]
    return {
        "today": [_task("today_task", "2026-08-12", "high")],
        "overdue": [_task("overdue_task", "2026-08-11", "normal")],
        "upcoming": [_task("upcoming_task", "2026-08-15", "low")],
        "undated": [
            _task("undated_no_project", None, "normal", project_id=None),
            _task("undated_project", None, "low"),
        ],
    }.get(view, [])


def _event_items(scenario: str) -> list[dict[str, Any]]:
    if scenario in {"b3-healthy", "b3-overlap", "b3-long-russian"}:
        return _b3_events(long_russian=scenario == "b3-long-russian")
    if scenario == "b3-route-pagination":
        return _b3_paged_events()
    if scenario == "overview-timed-event":
        return [_timed_event()]
    if scenario == "overview-all-day-event":
        return [_all_day_event()]
    if scenario == "overview-long-russian":
        return [
            _timed_event(
                title="Длинная встреча с русским названием, которое должно спокойно занимать две строки",
            )
        ]
    items = [_timed_event(), _all_day_event()]
    if scenario == "route-pagination":
        items.append(_outside_event())
    return items


def _filter_events(
    items: list[dict[str, Any]],
    query: httpx.QueryParams | None,
) -> list[dict[str, Any]]:
    if query is None or query.get("from") is None or query.get("to") is None:
        return items
    start = datetime.fromisoformat(query["from"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(query["to"].replace("Z", "+00:00"))
    result = []
    for item in items:
        if item["all_day"]:
            event_start = datetime.fromisoformat(item["start_date"] + "T00:00:00+00:00")
            event_end = datetime.fromisoformat(item["end_date_exclusive"] + "T00:00:00+00:00")
        else:
            event_start = datetime.fromisoformat(item["start_at_utc"].replace("Z", "+00:00"))
            event_end = datetime.fromisoformat(item["end_at_utc"].replace("Z", "+00:00"))
        if event_start < end and event_end > start:
            result.append(item)
    return result


def _project_items(scenario: str) -> list[dict[str, Any]]:
    if scenario == "b3-empty":
        return []
    if scenario in {"b3-healthy", "b3-overlap", "b3-long-russian"}:
        return [
            _project(name="Домашние дела"),
            _project(object_id=_synthetic_uuid(2001), name="Работа"),
        ]
    if scenario != "route-pagination" and scenario != "b3-route-pagination":
        return [_project()]
    return [
        _project(object_id=_synthetic_uuid(2000 + index), name=f"Synthetic project {index}")
        for index in range(60)
    ]


def _status(scenario: str) -> dict[str, Any]:
    degraded = scenario in {"degraded", "overview-degraded"}
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
        "planningHealth": {
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
                "providerStatus": "not_configured",
                "providerLastSyncAt": None,
                "providerErrorCode": None,
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
        },
    }


def _common(
    identifier: str,
    *,
    source: str = "alice",
    object_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": object_id or _IDS[identifier],
        "source": source,
        "version": 1,
        "created_at": FIXTURE_TIMESTAMP,
        "updated_at": FIXTURE_TIMESTAMP,
        "audit_correlation_id": "00000000-0000-4000-8000-000000000097",
    }


def _reminder(
    *,
    due_at_utc: str = "2026-08-12T10:00:00Z",
    title: str = "Synthetic reminder",
) -> dict[str, Any]:
    return {
        **_common("reminder"),
        "domain": "reminder",
        "title": title,
        "due_at_utc": due_at_utc,
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
        "due_at_utc": "2026-08-12T08:30:00Z",
        "status": "due",
        "delivery_state": "failed",
        "final_failure_at": FIXTURE_TIMESTAMP,
    }


def _due_normal_reminder() -> dict[str, Any]:
    return {
        **_reminder(),
        "id": _IDS["due_normal"],
        "title": "Synthetic due reminder",
        "due_at_utc": "2026-08-12T08:45:00Z",
        "status": "due",
        "delivery_state": "queued",
    }


def _delivered_reminder(*, due_at_utc: str = "2026-08-12T08:15:00Z") -> dict[str, Any]:
    return {
        **_reminder(),
        "id": _IDS["delivered"],
        "title": "Synthetic delivered open reminder",
        "due_at_utc": due_at_utc,
        "status": "due",
        "delivery_state": "delivered",
    }


def _completed_reminder(identifier: str, due_at_utc: str) -> dict[str, Any]:
    return {
        **_reminder(),
        "id": _IDS[identifier],
        "title": f"Synthetic {identifier.replace('_', ' ')}",
        "due_at_utc": due_at_utc,
        "status": "completed",
        "completed_at": FIXTURE_TIMESTAMP,
    }


def _cancelled_reminder() -> dict[str, Any]:
    return {
        **_reminder(),
        "id": _IDS["cancelled"],
        "title": "Synthetic cancelled reminder",
        "status": "cancelled",
        "cancelled_at": FIXTURE_TIMESTAMP,
        "deleted_at": FIXTURE_TIMESTAMP,
    }


def _task(
    identifier: str,
    due_date: str | None,
    priority: str,
    *,
    object_id: str | None = None,
    title: str | None = None,
    due_time: str | None = None,
    timezone_name: str | None = None,
    project_id: str | None = _IDS["project"],
) -> dict[str, Any]:
    return {
        **_common(identifier, object_id=object_id),
        "domain": "task",
        "title": title or f"Synthetic {identifier.replace('_', ' ')}",
        "priority": priority,
        "status": "open",
        "notes": None,
        "due_date": due_date,
        "due_time": due_time,
        "timezone": timezone_name,
        "project_id": project_id,
        "source_ref": None,
        "completed_at": None,
        "archived_at": None,
        "deleted_at": None,
    }


def _timed_event(
    *,
    title: str = "Synthetic timed event",
    object_id: str | None = None,
    timezone: str = "Europe/Moscow",
    start_at_utc: str = "2026-08-12T12:00:00Z",
    end_at_utc: str = "2026-08-12T13:00:00Z",
    sync_state: str = "local_only",
) -> dict[str, Any]:
    return {
        **_common("timed_event", source="system", object_id=object_id),
        "domain": "calendar_event",
        "title": title,
        "all_day": False,
        "timezone": timezone,
        "sync_state": sync_state,
        "notes": None,
        "location": None,
        "start_at_utc": start_at_utc,
        "end_at_utc": end_at_utc,
        "start_date": None,
        "end_date_exclusive": None,
        "recurrence_rule": None,
        "provider_id": None,
        "provider_calendar_id": None,
        "source_ref": None,
        "deleted_at": None,
    }


def _all_day_event(
    *,
    title: str = "Synthetic all-day event",
    object_id: str | None = None,
    start_date: str = "2026-08-12",
    end_date_exclusive: str = "2026-08-13",
) -> dict[str, Any]:
    return {
        **_common("all_day_event", source="system", object_id=object_id),
        "domain": "calendar_event",
        "title": title,
        "all_day": True,
        "timezone": "Europe/Moscow",
        "sync_state": "local_only",
        "notes": None,
        "location": None,
        "start_at_utc": None,
        "end_at_utc": None,
        "start_date": start_date,
        "end_date_exclusive": end_date_exclusive,
        "recurrence_rule": None,
        "provider_id": None,
        "provider_calendar_id": None,
        "source_ref": None,
        "deleted_at": None,
    }


def _outside_event() -> dict[str, Any]:
    return {
        **_common("timed_event", source="system", object_id=_synthetic_uuid(3000)),
        "domain": "calendar_event",
        "title": "Synthetic outside-range event",
        "all_day": False,
        "timezone": "Europe/Moscow",
        "sync_state": "local_only",
        "notes": None,
        "location": None,
        "start_at_utc": "2026-08-25T12:00:00Z",
        "end_at_utc": "2026-08-25T13:00:00Z",
        "start_date": None,
        "end_date_exclusive": None,
        "recurrence_rule": None,
        "provider_id": None,
        "provider_calendar_id": None,
        "source_ref": None,
        "deleted_at": None,
    }


def _project(
    *,
    object_id: str | None = None,
    name: str = "Synthetic project",
) -> dict[str, Any]:
    return {
        **_common("project", object_id=object_id),
        "domain": "project",
        "name": name,
        "notes": None,
        "source_ref": None,
        "deleted_at": None,
    }
