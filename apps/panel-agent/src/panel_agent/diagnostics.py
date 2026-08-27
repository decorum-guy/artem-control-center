"""Fixed, browser-safe diagnostics collection for owner support reports.

This module intentionally derives diagnostics from already-normalized contracts.
It does not read logs, environment files, process state, or arbitrary upstream
payloads.  The transition ring is process-local and bounded; it is useful for
short-lived flicker without becoming a second persistence system.
"""

from __future__ import annotations

import os
import re
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Dict, Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .contracts import (
    DashboardSnapshot,
    DiagnosticsCalendarQuery,
    DiagnosticsCollectorStatus,
    DiagnosticsMutationGates,
    DiagnosticsPlanningSummary,
    DiagnosticsProblem,
    DiagnosticsProviderSummary,
    DiagnosticsReport,
    DiagnosticsTransition,
)
from .settings import IntegrationSettings


_SAFE_REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_SAFE_OPAQUE_ID = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,127}$")
_SAFE_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T[^\s]{1,48}$")

_SERVICE_LABELS = {
    "home-assistant": "Home Assistant",
    "coffee-machine": "Кофемашина",
    "kettle": "Чайник",
    "alice-tg-bot": "AliceTG",
    "avalar-site-main": "AVALAR Main",
    "avalar-site-stage": "AVALAR Stage",
    "rog_g703gi": "ROG",
    "panel-runtime": "Control Center runtime",
}

_HEALTH_STATE = {
    "offline": "offline",
    "degraded": "degraded",
    "stale": "stale",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_revision() -> str:
    for key in ("PANEL_AGENT_BUILD_REVISION", "PANEL_BUILD_REVISION"):
        value = os.getenv(key, "").strip()
        if _SAFE_REVISION.fullmatch(value):
            return value
    return "unknown"


def _safe_timestamp(value: object) -> Optional[str]:
    if not isinstance(value, str) or not _SAFE_TIMESTAMP.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat()


def _configured_timezone(settings: IntegrationSettings) -> str:
    value = str(getattr(settings, "panel_planning_timezone", "")).strip()
    if not value:
        return "unknown"
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError:
        return "unknown"
    return value


def _local_date_for_timestamp(value: object, time_zone: str) -> str:
    normalized = _safe_timestamp(value)
    if normalized is None or time_zone == "unknown":
        return "unknown"
    try:
        return datetime.fromisoformat(normalized).astimezone(ZoneInfo(time_zone)).date().isoformat()
    except (ValueError, ZoneInfoNotFoundError):
        return "unknown"


def _service_label(service_id: str) -> str:
    return _SERVICE_LABELS.get(service_id, "Сервис")


def _problem_summary(label: str, state: str) -> str:
    return {
        "offline": f"{label} недоступен",
        "degraded": f"{label} работает с ограничениями",
        "stale": f"{label} показывает устаревшее состояние",
        "error": f"{label} сообщил об ошибке",
    }.get(state, f"{label} требует внимания")


def _severity(state: str) -> str:
    return "error" if state in {"offline", "error"} else "warning"


def _provider_label(provider: str) -> str:
    return "iCloud Calendar" if provider == "icloud" else "Local Planning"


def _provider_id(value: object) -> str:
    if isinstance(value, str) and _SAFE_OPAQUE_ID.fullmatch(value):
        return value
    return "redacted"


def _provider_problem_state(status: str) -> str | None:
    if status == "error":
        return "error"
    if status == "stale":
        return "stale"
    return None


def _problem_from_service(
    service,
    *,
    observed_at: str,
    first_observed_at: str,
) -> DiagnosticsProblem | None:
    if not service.enabled or service.health == "healthy":
        return None
    state = _HEALTH_STATE.get(service.health, "degraded")
    data = service.data if isinstance(service.data, dict) else {}
    return DiagnosticsProblem(
        id=f"service:{service.id}",
        subsystem=_service_label(service.id),
        severity=_severity(state),
        state=state,
        current=True,
        summary=_problem_summary(_service_label(service.id), state),
        firstObservedAt=first_observed_at,
        lastObservedAt=observed_at,
        lastHealthyAt=_safe_timestamp(data.get("lastSuccessfulObservedAt")),
        freshness=(
            service.presentation.freshnessLabel
            if service.presentation is not None
            and isinstance(service.presentation.freshnessLabel, str)
            and len(service.presentation.freshnessLabel) <= 120
            else None
        ),
        correlationCode=f"service_health_{state}",
    )


def _problems_for_snapshot(
    snapshot: DashboardSnapshot,
    first_observed: Dict[str, str],
) -> dict[str, DiagnosticsProblem]:
    observed_at = snapshot.generatedAt
    result: dict[str, DiagnosticsProblem] = {}
    for service in snapshot.services:
        problem_id = f"service:{service.id}"
        problem = _problem_from_service(
            service,
            observed_at=observed_at,
            first_observed_at=first_observed.get(problem_id, observed_at),
        )
        if problem is not None:
            first_observed.setdefault(problem_id, observed_at)
            problem = problem.model_copy(update={"firstObservedAt": first_observed[problem_id]})
            result[problem.id] = problem

    planning = snapshot.planning
    if planning is not None:
        if planning.sourceStatus != "current":
            problem_id = "planning:source"
            first_observed.setdefault(problem_id, observed_at)
            state = planning.sourceStatus
            result[problem_id] = DiagnosticsProblem(
                id=problem_id,
                subsystem="Planning",
                severity=_severity(state),
                state=state,
                current=True,
                summary=_problem_summary("Planning", state),
                firstObservedAt=first_observed[problem_id],
                lastObservedAt=observed_at,
                lastHealthyAt=_safe_timestamp(planning.lastSyncedAt),
                freshness=planning.lastSyncedAt,
                correlationCode=f"planning_source_{state}",
            )
        for provider in planning.providerStatuses:
            provider_state = _provider_problem_state(provider.status)
            if provider_state is None:
                continue
            provider_id = _provider_id(provider.id)
            problem_id = f"calendar-provider:{provider_id}"
            first_observed.setdefault(problem_id, observed_at)
            label = _provider_label(provider.provider)
            result[problem_id] = DiagnosticsProblem(
                id=problem_id,
                subsystem=label,
                severity=_severity(provider_state),
                state=provider_state,
                current=True,
                summary=_problem_summary(label, provider_state),
                firstObservedAt=first_observed[problem_id],
                lastObservedAt=observed_at,
                lastHealthyAt=_safe_timestamp(provider.lastSyncedAt),
                freshness=_safe_timestamp(provider.lastSyncedAt),
                correlationCode=f"provider_{provider_state}",
            )
    for problem_id in list(first_observed):
        if (
            problem_id.startswith("service:")
            or problem_id == "planning:source"
            or problem_id.startswith("calendar-provider:")
        ) and problem_id not in result:
            first_observed.pop(problem_id, None)
    return result

def _problem_state(problem: DiagnosticsProblem | None) -> str | None:
    return problem.state if problem is not None else None


def _transition_summary(subsystem: str, state: str, current: bool) -> str:
    if not current:
        return f"{subsystem} восстановлен"
    return _problem_summary(subsystem, state)


class DiagnosticsCollector:
    """Collects only allow-listed state and keeps bounded problem/read history."""

    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        history_size: int = 32,
        build_revision: str | None = None,
    ) -> None:
        self._settings = settings
        self._history: Deque[DiagnosticsTransition] = deque(maxlen=max(1, history_size))
        self._calendar_reads: Deque[DiagnosticsCalendarQuery] = deque(maxlen=max(1, history_size))
        self._first_observed: dict[str, str] = {}
        self._current: dict[str, DiagnosticsProblem] = {}
        self._latest_source_status: str | None = None
        self._latest_provider_summaries: list[DiagnosticsProviderSummary] = []
        self._build_revision = build_revision or _safe_revision()

    @property
    def history_size(self) -> int:
        return self._history.maxlen or 0

    def observe(self, snapshot: DashboardSnapshot) -> None:
        next_problems = _problems_for_snapshot(snapshot, self._first_observed)
        planning = snapshot.planning
        self._latest_source_status = planning.sourceStatus if planning is not None else None
        self._latest_provider_summaries = self._provider_summaries(
            planning.providerStatuses if planning is not None else []
        )
        previous = self._current
        for problem_id, problem in next_problems.items():
            previous_problem = previous.get(problem_id)
            if previous_problem is None or previous_problem.state != problem.state:
                self._history.append(
                    DiagnosticsTransition(
                        problemId=problem_id,
                        subsystem=problem.subsystem,
                        fromState=_problem_state(previous_problem),
                        toState=problem.state,
                        current=True,
                        observedAt=problem.lastObservedAt,
                        summary=_transition_summary(problem.subsystem, problem.state, True),
                    )
                )
        for problem_id, previous_problem in previous.items():
            if problem_id in next_problems:
                continue
            self._history.append(
                DiagnosticsTransition(
                    problemId=problem_id,
                    subsystem=previous_problem.subsystem,
                    fromState=previous_problem.state,
                    toState="recovered",
                    current=False,
                    observedAt=snapshot.generatedAt,
                    summary=_transition_summary(previous_problem.subsystem, "recovered", False),
                )
            )
        self._current = next_problems

    def observe_calendar_read(
        self,
        *,
        from_utc: str,
        to_utc: str,
        view: str | None = None,
        result_status: str | None = None,
        item_count: int = 0,
        source_status: str | None = None,
        last_synced_at: str | None = None,
        providers: Iterable[object] | None = None,
        cache_used: bool = False,
        fallback_used: bool = False,
        projection_status: str | None = None,
        observed_at: str | None = None,
    ) -> None:
        """Record one real browser calendar read without retaining event content."""

        safe_items = max(0, min(100, int(item_count)))
        provider_summaries = (
            self._provider_summaries(providers)
            if providers is not None
            else list(self._latest_provider_summaries)
        )
        effective_source_status = source_status or self._latest_source_status
        provider_error = any(provider.status == "error" for provider in provider_summaries)
        provider_degraded = any(
            provider.status not in {"current", "not_configured", "disabled"}
            for provider in provider_summaries
        )
        if result_status is None:
            if provider_error:
                result_status = "error"
            elif effective_source_status not in {None, "current"} or provider_degraded:
                result_status = "degraded"
            elif safe_items:
                result_status = "success_nonempty"
            else:
                result_status = "success_empty"
        if result_status not in {"success_nonempty", "success_empty", "degraded", "error", "unavailable"}:
            result_status = "unavailable"
        if projection_status not in {"current", "cached", "empty", "unavailable"}:
            projection_status = (
                "unavailable"
                if result_status == "unavailable"
                else "cached"
                if effective_source_status in {"stale", "offline", "degraded"}
                else "current"
                if safe_items
                else "empty"
            )
        time_zone = _configured_timezone(self._settings)
        observation = DiagnosticsCalendarQuery(
            scopeType="ACTUAL_REQUEST_RANGE",
            fromDate=_local_date_for_timestamp(from_utc, time_zone),
            toDate=_local_date_for_timestamp(to_utc, time_zone),
            requestFromUtc=_safe_timestamp(from_utc),
            requestToUtc=_safe_timestamp(to_utc),
            view=view if view in {"today", "agenda"} else None,
            timezone=time_zone,
            observedAt=_safe_timestamp(observed_at) or _now(),
            lastSyncedAt=_safe_timestamp(last_synced_at),
            resultStatus=result_status,
            itemCount=safe_items,
            sourceCount=len(provider_summaries),
            calendarCount=sum(provider.calendarCount for provider in provider_summaries),
            sourceStatus=effective_source_status,
            cacheUsed=bool(cache_used),
            fallbackUsed=bool(fallback_used),
            projectionStatus=projection_status,
            providers=provider_summaries,
        )
        self._calendar_reads.append(observation)

    def report(self, snapshot: DashboardSnapshot) -> DiagnosticsReport:
        # The endpoint can be called before a lifespan rebuild in tests or in a
        # just-started process.  Observing here also makes fixture scenarios
        # deterministic without exposing any raw fixture payload.
        self.observe(snapshot)
        collector_status: list[DiagnosticsCollectorStatus] = []
        try:
            planning = self._planning_summary(snapshot)
            collector_status.append(DiagnosticsCollectorStatus(collector="planning", status="ok"))
        except Exception:
            planning = DiagnosticsPlanningSummary(
                remindersCount=0,
                tasksCount=0,
                calendarCount=0,
            )
            collector_status.append(
                DiagnosticsCollectorStatus(
                    collector="planning",
                    status="error",
                    code="planning_projection_unavailable",
                )
            )
        try:
            calendar = self._calendar_query(snapshot)
            collector_status.append(
                DiagnosticsCollectorStatus(
                    collector="calendar",
                    status="error" if calendar.resultStatus in {"error", "unavailable"} else "ok",
                    code=(
                        "calendar_read_unavailable"
                        if calendar.resultStatus == "unavailable"
                        else "calendar_read_error"
                        if calendar.resultStatus == "error"
                        else None
                    ),
                )
            )
        except Exception:
            calendar = DiagnosticsCalendarQuery(
                scopeType="PROJECTION_SCOPE",
                fromDate="unknown",
                toDate="unknown",
                timezone=_configured_timezone(self._settings),
                observedAt=_now(),
                lastSyncedAt=None,
                resultStatus="unavailable",
                itemCount=0,
                sourceCount=0,
                calendarCount=0,
                projectionStatus="unavailable",
                projectionScope="unknown",
            )
            collector_status.append(
                DiagnosticsCollectorStatus(
                    collector="calendar",
                    status="error",
                    code="calendar_projection_unavailable",
                )
            )
        collector_status.insert(0, DiagnosticsCollectorStatus(collector="snapshot", status="ok"))
        collector_status.append(DiagnosticsCollectorStatus(collector="transitions", status="ok"))
        return DiagnosticsReport(
            schemaVersion="diagnostics.v1",
            generatedAt=_now(),
            buildRevision=self._build_revision,
            mode=snapshot.mode,
            snapshotRevision=snapshot.revision,
            problems=list(self._current.values()),
            recentTransitions=list(self._history),
            collectorStatus=collector_status,
            planning=planning,
            calendar=calendar,
            calendarReads=list(self._calendar_reads),
            mutationGates=DiagnosticsMutationGates(
                writesEnabled=self._settings.writes_enabled,
                coffeeActionsEnabled=self._settings.coffee_actions_enabled,
                coffeeTimingWritesEnabled=self._settings.coffee_timing_writes_enabled,
                coffeeNotificationWritesEnabled=self._settings.coffee_notification_writes_enabled,
                planningReminderMutationsEnabled=self._settings.panel_planning_reminder_mutations_enabled,
                planningTaskMutationsEnabled=self._settings.panel_planning_task_mutations_enabled,
                planningCalendarMutationsEnabled=self._settings.panel_planning_calendar_mutations_enabled,
            ),
        )

    def _planning_summary(self, snapshot: DashboardSnapshot) -> DiagnosticsPlanningSummary:
        planning = snapshot.planning
        if planning is None:
            return DiagnosticsPlanningSummary(
                sourceStatus="offline",
                remindersCount=0,
                tasksCount=0,
                calendarCount=0,
                cacheUsed=False,
            )
        providers = [
            DiagnosticsProviderSummary(
                id=_provider_id(provider.id),
                kind=provider.kind,
                provider=provider.provider,
                label=_provider_label(provider.provider),
                status=provider.status,
                configured=provider.configured,
                lastSyncedAt=_safe_timestamp(provider.lastSyncedAt),
                observedAt=_safe_timestamp(provider.observedAt),
                calendarCount=len(provider.calendars),
            )
            for provider in planning.providerStatuses
        ]
        return DiagnosticsPlanningSummary(
            schemaVersion=planning.schemaVersion,
            sourceStatus=planning.sourceStatus,
            lastSyncedAt=_safe_timestamp(planning.lastSyncedAt),
            staleAfter=_safe_timestamp(planning.staleAfter),
            remindersCount=(
                len(planning.reminders.upcoming)
                + len(planning.reminders.overdue)
                + len(planning.reminders.deliveryFailures)
            ),
            tasksCount=(
                len(planning.tasks.today)
                + len(planning.tasks.overdue)
                + len(planning.tasks.upcoming)
                + len(planning.tasks.undated)
            ),
            calendarCount=len(_unique_events(snapshot)),
            cacheUsed=planning.sourceStatus in {"stale", "offline"},
            providers=providers,
        )

    @staticmethod
    def _provider_summaries(providers: Iterable[object]) -> list[DiagnosticsProviderSummary]:
        result: list[DiagnosticsProviderSummary] = []
        for provider in list(providers)[:4]:
            provider_name = getattr(provider, "provider", None)
            if provider_name not in {"local", "icloud"}:
                continue
            calendars = getattr(provider, "calendars", [])
            result.append(
                DiagnosticsProviderSummary(
                    id=_provider_id(getattr(provider, "id", None)),
                    kind=(
                        getattr(provider, "kind", None)
                        if getattr(provider, "kind", None) in {"native", "external"}
                        else "external"
                    ),
                    provider=provider_name,
                    label=_provider_label(provider_name),
                    status=str(getattr(provider, "status", "unknown"))[:32] or "unknown",
                    configured=bool(getattr(provider, "configured", False)),
                    lastSyncedAt=_safe_timestamp(getattr(provider, "lastSyncedAt", None)),
                    observedAt=_safe_timestamp(getattr(provider, "observedAt", None)),
                    calendarCount=max(0, min(32, len(calendars))),
                )
            )
        return result

    def _calendar_query(self, snapshot: DashboardSnapshot) -> DiagnosticsCalendarQuery:
        if self._calendar_reads:
            return self._calendar_reads[-1]

        events = _unique_events(snapshot)
        planning = snapshot.planning
        provider_error = bool(
            planning
            and any(provider.status == "error" for provider in planning.providerStatuses)
        )
        provider_degraded = bool(
            planning
            and any(
                provider.status not in {"current", "not_configured", "disabled"}
                for provider in planning.providerStatuses
            )
        )
        source_status = planning.sourceStatus if planning is not None else None
        if planning is None:
            result_status = "unavailable"
            projection_status = "unavailable"
        elif provider_error:
            result_status = "error"
            projection_status = "cached" if planning.sourceStatus in {"stale", "offline"} else "current"
        elif planning.sourceStatus != "current" or provider_degraded:
            result_status = "degraded"
            projection_status = "cached" if events else "empty"
        elif events:
            result_status = "success_nonempty"
            projection_status = "current"
        else:
            result_status = "success_empty"
            projection_status = "empty"
        source_ids = {
            _provider_id(event.calendarIdentity.providerId)
            for event in events
        }
        calendar_ids = {
            (
                _provider_id(event.calendarIdentity.providerId),
                _provider_id(event.calendarIdentity.calendarId),
            )
            for event in events
        }
        cache_used = bool(planning and planning.sourceStatus in {"stale", "offline"})
        return DiagnosticsCalendarQuery(
            scopeType="PROJECTION_SCOPE",
            fromDate="unknown",
            toDate="unknown",
            timezone=_configured_timezone(self._settings),
            observedAt=_safe_timestamp(snapshot.generatedAt) or _now(),
            lastSyncedAt=_safe_timestamp(planning.lastSyncedAt) if planning is not None else None,
            resultStatus=result_status,
            itemCount=len(events),
            sourceCount=len(source_ids),
            calendarCount=len(calendar_ids),
            sourceStatus=source_status,
            cacheUsed=cache_used,
            fallbackUsed=cache_used,
            projectionStatus=projection_status,
            projectionScope="planning_snapshot_calendar_today_upcoming",
            providers=self._provider_summaries(
                planning.providerStatuses if planning is not None else []
            ),
        )


def _unique_events(snapshot: DashboardSnapshot) -> list:
    if snapshot.planning is None:
        return []
    result = []
    seen: set[str] = set()
    for event in snapshot.planning.calendar.today + snapshot.planning.calendar.upcoming:
        if event.id in seen:
            continue
        seen.add(event.id)
        result.append(event)
    return result
