"""Read-only Panel Agent adapter for AliceTG_Bot Planning v1."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from datetime import date, datetime, time as local_time, timedelta, timezone
from typing import Any, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from pydantic import ValidationError

from .planning import (
    CalendarEventProjection,
    EventListEnvelope,
    PlanningConflict,
    PlanningProjection,
    PlanningReadEnvelope,
    PlanningListEnvelope,
    PlanningSourceStatus,
    PlanningStatusProjection,
    ProjectListEnvelope,
    ProjectProjection,
    ReminderListEnvelope,
    ReminderProjection,
    StatusEnvelope,
    TaskListEnvelope,
    TaskProjection,
    UpstreamCalendarEvent,
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
    "tasks": "/internal/planning/v1/tasks",
    "events": "/internal/planning/v1/events",
    "projects": "/internal/planning/v1/projects",
    "status": "/internal/planning/v1/status",
}
PLANNING_AUDIENCE = "panel-agent"
PLANNING_PAGE_LIMIT = 20
PLANNING_MAX_UPSTREAM_PAGE = 100
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


class PlanningReadUnavailable(RuntimeError):
    """A route read cannot be satisfied from the live upstream or a complete cache."""


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
    """Fixed-route, fixed-header GET client; it is not a generic proxy."""

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

    async def _get_json(self, route_name: str, params: Mapping[str, str | int]) -> dict[str, Any]:
        path = PLANNING_ROUTES.get(route_name)
        if path is None:
            raise PlanningUpstreamError("route_not_allowlisted")
        try:
            async with self._client.stream(
                "GET",
                path,
                params=dict(params),
                headers=self._headers,
            ) as response:
                content_length = response.headers.get("content-length")
                if content_length is not None:
                    try:
                        if int(content_length) > self._response_limit_bytes:
                            raise PlanningUpstreamError("response_too_large")
                    except ValueError as exc:
                        raise PlanningUpstreamError("invalid_content_length") from exc
                if response.status_code != 200:
                    raise PlanningUpstreamError(
                        "http_error",
                        status_code=response.status_code,
                    )
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > self._response_limit_bytes:
                        raise PlanningUpstreamError("response_too_large")
        except PlanningUpstreamError:
            raise
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            raise PlanningUpstreamError("transport_error") from exc
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
    """One coordinated, read-only polling loop with bounded last-good state."""

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
        if self._projection is not None:
            source_status = self._status_source_status(
                current=self._domains_current
            )
            await self._set_projection(
                self._projection.model_copy(
                    update={
                        "generatedAt": self._now_text(),
                        "sourceStatus": source_status,
                    },
                    deep=True,
                )
            )
        return True

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
            mapped = self._mapped_domains(results, previous)
            all_success = not errors
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
                )
                self._record_domain_errors(errors)
            await self._set_projection(projection)
            return all_success

    def read_status(self) -> PlanningStatusProjection:
        projection = self._read_projection()
        return status_projection(projection)

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
        The adapter therefore scans at most one bounded page per lifecycle state,
        merges by canonical due time/ID, and preserves ``hasMore`` whenever the
        upstream page says that the bounded scan may have more results.
        """

        if view not in {"upcoming", "overdue", "delivery"}:
            raise PlanningUpstreamError("reminder_view_out_of_range")
        client = self._live_client()
        now = self._wall_now()
        windows = self._windows(now)
        # Keep the composed order stable across page requests. A smaller scan
        # for page zero followed by a larger scan for page one would change
        # delivery-priority boundaries and could duplicate items. The fixed
        # upstream cap still makes the derived read bounded and advertises
        # ``hasMore`` when the source continues beyond that cap.
        scan_limit = PLANNING_MAX_UPSTREAM_PAGE
        if view == "delivery":
            requests = [
                client.reminders(
                    state="due",
                    limit=scan_limit,
                    offset=0,
                )
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
            requests = [
                client.reminders(
                    state=state,
                    from_utc=from_utc,
                    to_utc=to_utc,
                    limit=scan_limit,
                    offset=0,
                )
                for state in ("pending", "due")
            ]

        envelopes = await asyncio.gather(*requests)
        selected_source: list[UpstreamReminder] = []
        for envelope in envelopes:
            for item in envelope.items:
                if view == "delivery":
                    if item.status == "due" and item.delivery_state in {"queued", "retrying", "failed"}:
                        selected_source.append(item)
                elif item.status in {"pending", "due"}:
                    selected_source.append(item)

        unique_source = {
            item.id: item for item in selected_source
        }
        if view == "delivery":
            delivery_rank = {"failed": 0, "retrying": 1, "queued": 2}
            ordered_source = sorted(
                unique_source.values(),
                key=lambda item: (
                    delivery_rank.get(item.delivery_state, 3),
                    item.due_at_utc,
                    item.id,
                ),
            )
        else:
            ordered_source = sorted(
                unique_source.values(),
                key=lambda item: (item.due_at_utc, item.id),
            )
        mapped = self._map_reminders(ordered_source)
        page = mapped[offset : offset + limit]
        source_has_more = any(envelope.pagination.has_more for envelope in envelopes)
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
            hasMore=offset + len(page) < len(mapped) or source_has_more,
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
            provider_status="local_only",
        )

    def _mapped_domains(
        self,
        results: list[Any],
        previous: PlanningProjection | None,
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
        event_today = self._map_events(results[task_index + 3], previous.calendar.today)
        event_upcoming = self._map_events(results[task_index + 4], previous.calendar.upcoming)
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
                priority=item.priority,
                status=item.status,
                dueDate=item.due_date,
                dueTime=item.due_time,
                timezone=item.timezone,
                projectId=item.project_id,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in result.items
        ]

    @staticmethod
    def _map_events(
        result: Any,
        fallback: list[CalendarEventProjection],
    ) -> list[CalendarEventProjection]:
        if not isinstance(result, EventListEnvelope):
            return list(fallback)
        return [
            CalendarEventProjection(
                id=item.id,
                version=item.version,
                source=item.source,
                sourceLabel=source_label(item.source),
                title=item.title,
                allDay=item.all_day,
                timezone=item.timezone,
                syncState=item.sync_state,
                startAtUtc=item.start_at_utc,
                endAtUtc=item.end_at_utc,
                startDate=item.start_date,
                endDateExclusive=item.end_date_exclusive,
                createdAt=item.created_at,
                updatedAt=item.updated_at,
            )
            for item in result.items
        ]

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
            capabilities={
                "create": False,
                "edit": False,
                "complete": False,
                "cancel": False,
                "delete": False,
                "voice": False,
                "providerSync": False,
            },
            providerStatuses=[
                {
                    "id": "native-planning",
                    "label": "Local Planning",
                    "status": "local_only",
                    "configured": True,
                    "lastSyncedAt": None,
                }
            ],
        )

    def _live_client(self) -> PlanningClient:
        if not self._enabled or self._client is None:
            raise PlanningReadUnavailable("planning_live_read_unavailable")
        return self._client

    def _read_upstream_envelope(
        self,
        envelope: PlanningListEnvelope,
    ) -> PlanningReadEnvelope:
        if isinstance(envelope, ReminderListEnvelope):
            items = self._map_reminders(envelope.items)
        elif isinstance(envelope, TaskListEnvelope):
            items = self._map_tasks(envelope, [])
        elif isinstance(envelope, EventListEnvelope):
            items = self._map_events(envelope, [])
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
