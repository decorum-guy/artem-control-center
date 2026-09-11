"""Bounded monitoring for the closed project capability registry."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from time import monotonic
from typing import Awaitable, Callable, Dict, Iterable, List, Literal, Optional
from urllib.parse import urlsplit

import httpx

from .avalar_actions import avalar_action_descriptor
from .avalar_health import probe_avalar_health
from .contracts import ActionDescriptor, ServicePresentation, ServiceSnapshot
from .project_registry import (
    ProjectDetailsConfig,
    ProjectMonitorConfig,
    ProjectRegistry,
    stable_service_snapshot_id,
)
from .settings import IntegrationSettings


MAX_DECLARATIVE_REQUEST_TIMEOUT_SECONDS = 30.0
MAX_DECLARATIVE_LATENCY_MS = int(MAX_DECLARATIVE_REQUEST_TIMEOUT_SECONDS * 1000)

_SAFE_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_SAFE_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
_SAFE_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)

DeclarativeHttpProbeCode = Literal[
    "reachable",
    "endpoint_not_configured",
    "endpoint_invalid",
    "http_error",
    "unreachable",
]


@dataclass(frozen=True)
class DeclarativeHttpProbeResult:
    """Safe, bounded result of one declarative HTTP health probe."""

    result: DeclarativeHttpProbeCode
    http_status: int | None = None
    latency_ms: int | None = None


ActionAvailabilityProvider = Callable[[str], bool]


@dataclass(frozen=True)
class _MonitorTarget:
    project_id: str
    project_name: str
    environment_id: str
    service_id: str
    monitor: ProjectMonitorConfig
    details: ProjectDetailsConfig | None
    action_ids: tuple[str, ...]
    category: Literal["external", "work"]
    snapshot_id: str
    title: str


async def probe_declarative_http_monitor(
    monitor: ProjectMonitorConfig,
    settings: IntegrationSettings,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> DeclarativeHttpProbeResult:
    """Execute the fixed read-only HTTP semantics used by project monitoring."""

    resolution, endpoint = _resolve_endpoint(monitor.url_env)
    if endpoint is None:
        return DeclarativeHttpProbeResult(
            "endpoint_not_configured"
            if resolution == "endpoint_not_configured"
            else "endpoint_invalid"
        )

    if monitor.adapter == "avalar":
        probe = await probe_avalar_health(
            endpoint,
            settings.http_request_timeout_seconds,
            transport=transport,
        )
        if probe.outcome == "unavailable":
            return DeclarativeHttpProbeResult("unreachable")
        # The connection-test contract reports reachability.  The full
        # healthy/degraded mapping is materialized by DeclarativeProjectMonitor.
        return DeclarativeHttpProbeResult(
            "reachable",
            http_status=200,
            latency_ms=probe.latency_ms,
        )

    started = monotonic()
    try:
        async with httpx.AsyncClient(
            timeout=min(
                MAX_DECLARATIVE_REQUEST_TIMEOUT_SECONDS,
                max(1.0, float(settings.http_request_timeout_seconds)),
            ),
            transport=transport,
            follow_redirects=False,
        ) as client:
            # A fixed GET is intentional. The response body is not read or
            # forwarded; this adapter is a health probe, not a proxy.
            async with client.stream("GET", endpoint) as response:
                status_code = int(response.status_code)

        latency_ms = _bounded_latency_ms(started)
        bounded_status = (
            status_code if 100 <= status_code <= 599 else None
        )
        if 200 <= status_code < 300:
            return DeclarativeHttpProbeResult(
                "reachable",
                http_status=bounded_status,
                latency_ms=latency_ms,
            )
        return DeclarativeHttpProbeResult(
            "http_error",
            http_status=bounded_status,
            latency_ms=latency_ms,
        )
    except httpx.HTTPError:
        # Preserve the monitor's established HTTPX failure boundary without
        # exposing transport, DNS, socket or upstream exception details.
        return DeclarativeHttpProbeResult("unreachable")


class DeclarativeProjectMonitor:
    """Poll only validated, enabled project services with fixed HTTP GETs."""

    def __init__(
        self,
        registry: ProjectRegistry,
        settings: IntegrationSettings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        clock: Callable[[], float] = monotonic,
        on_change: Callable[[], Awaitable[None]] | None = None,
        details_provider: object | None = None,
        action_availability_provider: ActionAvailabilityProvider | None = None,
    ) -> None:
        self._registry = registry
        self._settings = settings
        self._transport = transport
        self._clock = clock
        self._on_change = on_change
        self._details_provider = details_provider
        self._action_availability_provider = action_availability_provider
        self._targets = self._build_targets(registry)
        self._services: Dict[str, ServiceSnapshot] = {
            target.snapshot_id: self._unavailable(target, "Health endpoint not configured")
            for target in self._targets
        }
        self._last_success: Dict[str, tuple[ServiceSnapshot, float, str]] = {}
        self._last_refresh_live: Dict[str, bool] = {}
        self._next_due: Dict[str, float] = {}
        self._backoff: Dict[str, float] = {}
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def registry(self) -> ProjectRegistry:
        return self._registry

    def set_on_change(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self._on_change = callback

    def set_details_provider(self, provider: object | None) -> None:
        self._details_provider = provider

    def set_action_availability_provider(
        self,
        provider: ActionAvailabilityProvider | None,
    ) -> None:
        self._action_availability_provider = provider

    async def start(self) -> None:
        if self.running or not self._targets:
            return

        await self.refresh()
        now = self._clock()
        for target in self._targets:
            self._backoff[target.snapshot_id] = float(target.monitor.interval_seconds)
            self._next_due[target.snapshot_id] = now + target.monitor.interval_seconds
        if not self.running:
            self._task = asyncio.create_task(
                self._poll(),
                name="declarative-project-monitor",
            )

    async def close(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def refresh(self, service_ids: Iterable[str] | None = None) -> bool:
        """Refresh selected services under one lock; no overlapping requests."""

        targets = self._targets_for(service_ids)
        if not targets:
            return True

        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop

        async with self._lock:
            results = await asyncio.gather(
                *(self._read_target(target) for target in targets)
            )
            for target, (current, request_succeeded, allow_last_known) in zip(
                targets,
                results,
            ):
                self._services[target.snapshot_id] = self._with_last_known(
                    target,
                    current,
                    allow_last_known=allow_last_known,
                )
                self._last_refresh_live[target.snapshot_id] = request_succeeded

            if self._on_change is not None:
                await self._on_change()

            return all(request_succeeded for _, request_succeeded, _ in results)

    def services(self) -> List[ServiceSnapshot]:
        return [
            self._services[target.snapshot_id].model_copy(deep=True)
            for target in self._targets
        ]

    async def _poll(self) -> None:
        while True:
            try:
                if not self._next_due:
                    return
                now = self._clock()
                next_due = min(self._next_due.values())
                await asyncio.sleep(max(0.0, next_due - now))

                now = self._clock()
                due_ids = [
                    target.snapshot_id
                    for target in self._targets
                    if self._next_due.get(target.snapshot_id, now + 1) <= now
                ]
                if not due_ids:
                    continue

                await self.refresh(due_ids)
                now = self._clock()
                for target in self._targets:
                    if target.snapshot_id not in due_ids:
                        continue
                    if self._last_refresh_live.get(target.snapshot_id, False):
                        delay = float(target.monitor.interval_seconds)
                        self._backoff[target.snapshot_id] = delay
                    else:
                        current = self._backoff.get(
                            target.snapshot_id,
                            float(target.monitor.interval_seconds),
                        )
                        delay = min(
                            max(current * 2, float(target.monitor.interval_seconds)),
                            max(
                                float(target.monitor.interval_seconds),
                                float(self._settings.integration_max_backoff_seconds),
                            ),
                        )
                        self._backoff[target.snapshot_id] = delay
                    self._next_due[target.snapshot_id] = now + delay
            except asyncio.CancelledError:
                raise
            except Exception:
                # A callback or unexpected transport failure must not turn a
                # monitor task into a silent one-shot. The next scheduled
                # refresh remains bounded by the configured backoff.
                now = self._clock()
                for target in self._targets:
                    current = self._backoff.get(
                        target.snapshot_id,
                        float(target.monitor.interval_seconds),
                    )
                    delay = min(
                        max(current * 2, float(target.monitor.interval_seconds)),
                        max(
                            float(target.monitor.interval_seconds),
                            float(self._settings.integration_max_backoff_seconds),
                        ),
                    )
                    self._backoff[target.snapshot_id] = delay
                    self._next_due[target.snapshot_id] = now + delay

    def _targets_for(
        self,
        service_ids: Iterable[str] | None,
    ) -> list[_MonitorTarget]:
        if service_ids is None:
            return list(self._targets)
        requested = set(service_ids)
        return [target for target in self._targets if target.snapshot_id in requested]

    async def _read_target(
        self,
        target: _MonitorTarget,
    ) -> tuple[ServiceSnapshot, bool, bool]:
        if target.monitor.adapter == "avalar":
            return await self._read_avalar_target(target)

        probe = await probe_declarative_http_monitor(
            target.monitor,
            self._settings,
            transport=self._transport,
        )
        if probe.result in {"endpoint_not_configured", "endpoint_invalid"}:
            # A missing or unsafe env value is a configuration boundary, not a
            # transient outage eligible for last-known success.
            return (
                self._unavailable(target, "Health endpoint not configured"),
                False,
                False,
            )
        if probe.result == "reachable":
            return (
                self._healthy(target, probe.latency_ms or 0),
                True,
                True,
            )
        return self._failed(target), False, True

    async def _read_avalar_target(
        self,
        target: _MonitorTarget,
    ) -> tuple[ServiceSnapshot, bool, bool]:
        _, endpoint = _resolve_endpoint(target.monitor.url_env)
        if endpoint is None:
            return (
                self._unavailable(target, "Health endpoint not configured"),
                False,
                False,
            )

        probe = await probe_avalar_health(
            endpoint,
            self._settings.http_request_timeout_seconds,
            transport=self._transport,
            clock=self._clock,
        )
        if probe.outcome == "unavailable":
            return self._failed(target), False, True
        return (
            self._avalar_snapshot(
                target,
                health=probe.health or "degraded",
                summary=probe.summary,
                latency_ms=probe.latency_ms or 0,
            ),
            True,
            True,
        )

    def _with_last_known(
        self,
        target: _MonitorTarget,
        current: ServiceSnapshot,
        *,
        allow_last_known: bool,
    ) -> ServiceSnapshot:
        if current.source == "live":
            current = self._refresh_action_descriptors(target, current)
            now = self._clock()
            self._last_success[target.snapshot_id] = (
                current.model_copy(deep=True),
                now,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            return current

        if not allow_last_known:
            return self._refresh_action_descriptors(target, current)

        previous = self._last_success.get(target.snapshot_id)
        if previous is None:
            return self._refresh_action_descriptors(target, current)

        snapshot, successful_at, observed_at = previous
        age = max(0.0, self._clock() - successful_at)
        cached = snapshot.model_copy(deep=True)
        stale_after = float(target.monitor.stale_after_seconds)
        unavailable_after = max(
            stale_after,
            float(self._settings.integration_unavailable_after_seconds),
        )
        if age <= stale_after:
            cached.source = "cached"
            cached.health = "degraded"
            cached.summary = "Using last known health state"
        elif age <= unavailable_after:
            cached.source = "stale"
            cached.health = "stale"
            cached.summary = "Last known health state is stale"
        else:
            cached.source = "unavailable"
            cached.health = "offline"
            cached.summary = "Health monitor unavailable"
        cached.data["lastSuccessfulObservedAt"] = observed_at
        cached = self._refresh_action_descriptors(target, cached)
        if cached.presentation:
            cached.presentation.freshnessLabel = _age_label(age)
            cached.presentation.latencyMs = None
        return cached

    @staticmethod
    def _build_targets(registry: ProjectRegistry) -> tuple[_MonitorTarget, ...]:
        targets: list[_MonitorTarget] = []
        for project in registry.active_projects:
            for environment in project.environments:
                for service in environment.services:
                    snapshot_id = stable_service_snapshot_id(
                        project.id,
                        environment.id,
                        service.id,
                    )
                    title = f"{project.name} · {environment.id} · {service.id}"
                    targets.append(
                        _MonitorTarget(
                            project_id=project.id,
                            project_name=project.name,
                            environment_id=environment.id,
                            service_id=service.id,
                            monitor=service.capabilities.monitor,
                            details=service.capabilities.details,
                            action_ids=tuple(service.capabilities.actions),
                            category=project.category,
                            snapshot_id=snapshot_id,
                            title=title[:100],
                        )
                    )
        return tuple(targets)

    @staticmethod
    def _presentation(target: _MonitorTarget) -> ServicePresentation:
        return ServicePresentation(
            category=target.category,
            group="External services",
            overview="aggregate",
            priority=0,
            environment=target.environment_id,
        )

    @staticmethod
    def _metadata(target: _MonitorTarget) -> dict[str, str]:
        return {
            "projectId": target.project_id,
            "environmentId": target.environment_id,
            "serviceId": target.service_id,
        }

    def _healthy(self, target: _MonitorTarget, latency_ms: int) -> ServiceSnapshot:
        return ServiceSnapshot(
            id=target.snapshot_id,
            title=target.title,
            enabled=True,
            dataContract="service.health.v1",
            health="healthy",
            source="live",
            summary="Healthy",
            actions=[],
            data=self._metadata(target),
            presentation=self._presentation(target).model_copy(
                update={"freshnessLabel": "только что", "latencyMs": latency_ms}
            ),
        )

    def _avalar_snapshot(
        self,
        target: _MonitorTarget,
        *,
        health: Literal["healthy", "degraded", "offline"],
        summary: str,
        latency_ms: int | None = None,
        source: Literal["live", "unavailable"] = "live",
        details: dict[str, object] | None = None,
    ) -> ServiceSnapshot:
        target_details = (
            self._safe_avalar_details(details)
            if details is not None
            else self._details_for_target(target)
        )
        details_source = str(
            target_details.get(
                "details_source",
                "unavailable" if target.details is not None else "disabled",
            )
        )
        details_available = details_source in {"live", "stale"}
        data: dict[str, object] = self._metadata(target)
        data.update(
            {
                "environment": target.environment_id,
                "version": target_details.get("version"),
                "commit": target_details.get("commit"),
                "branch": target_details.get("branch"),
                "deploymentRevision": target_details.get("deployment_revision"),
                "deployedAt": target_details.get("deployed_at"),
                "workingTree": target_details.get("working_tree"),
                "detailsAvailable": details_available,
                "detailsSource": details_source,
                "detailsObservedAt": target_details.get("details_observed_at"),
                "executor": "avalar-fixed" if target.action_ids else "disabled",
            }
        )
        return ServiceSnapshot(
            id=target.snapshot_id,
            title=target.title,
            enabled=True,
            dataContract="service.health.v1",
            health=health,
            summary=summary,
            actions=self._avalar_action_descriptors(target),
            source=source,
            presentation=ServicePresentation(
                category="work",
                group="AVALAR",
                overview="aggregate",
                priority=90 if target.environment_id in {"main", "production"} else 80,
                environment=target.environment_id,
                freshnessLabel="только что" if source == "live" else None,
                latencyMs=latency_ms,
            ),
            data=data,
        )

    def _failed(self, target: _MonitorTarget) -> ServiceSnapshot:
        return self._unavailable(target, "Health endpoint unavailable")

    def _unavailable(self, target: _MonitorTarget, summary: str) -> ServiceSnapshot:
        if target.monitor.adapter == "avalar":
            return self._avalar_snapshot(
                target,
                health="offline",
                summary=summary,
                source="unavailable",
                details={},
            )
        return ServiceSnapshot(
            id=target.snapshot_id,
            title=target.title,
            enabled=True,
            dataContract="service.health.v1",
            health="offline",
            source="unavailable",
            summary=summary,
            actions=[],
            data=self._metadata(target),
            presentation=self._presentation(target),
        )

    def _details_for_target(self, target: _MonitorTarget) -> dict[str, object]:
        if target.details is None or self._details_provider is None:
            return {}
        resolver = getattr(self._details_provider, "details_for_url_env", None)
        if not callable(resolver):
            return {}
        try:
            details = resolver(target.monitor.url_env)
        except Exception:
            return {}
        return self._safe_avalar_details(details)

    @staticmethod
    def _safe_avalar_details(details: object) -> dict[str, object]:
        if not isinstance(details, dict):
            return {}
        clean: dict[str, object] = {}
        version = details.get("version")
        if isinstance(version, str) and _SAFE_VERSION_PATTERN.fullmatch(version):
            clean["version"] = version
        for key in ("commit", "deployment_revision"):
            value = details.get(key)
            if isinstance(value, str) and _SAFE_COMMIT_PATTERN.fullmatch(value):
                clean[key] = value
        branch = details.get("branch")
        if branch in {"main", "stage", "detached"}:
            clean["branch"] = branch
        working_tree = details.get("working_tree")
        if working_tree in {"clean", "dirty"}:
            clean["working_tree"] = working_tree
        for key in ("deployed_at", "details_observed_at"):
            value = details.get(key)
            if isinstance(value, str) and _SAFE_TIMESTAMP_PATTERN.fullmatch(value):
                clean[key] = value
        source = details.get("details_source")
        if source in {"live", "stale", "unavailable", "disabled"}:
            clean["details_source"] = source
        return clean

    def _avalar_action_descriptors(
        self,
        target: _MonitorTarget,
    ) -> list[ActionDescriptor]:
        return [
            avalar_action_descriptor(
                action_id,
                enabled=self._action_is_available(action_id),
            )
            for action_id in target.action_ids
        ]

    def _action_is_available(self, action_id: str) -> bool:
        if self._action_availability_provider is None:
            return False
        try:
            return bool(self._action_availability_provider(action_id))
        except Exception:
            return False

    def _refresh_action_descriptors(
        self,
        target: _MonitorTarget,
        snapshot: ServiceSnapshot,
    ) -> ServiceSnapshot:
        if target.monitor.adapter != "avalar":
            return snapshot
        refreshed = snapshot.model_copy(deep=True)
        refreshed.actions = self._avalar_action_descriptors(target)
        return refreshed


def _resolve_endpoint(
    url_env: str,
) -> tuple[Literal["valid", "endpoint_not_configured", "endpoint_invalid"], str | None]:
    raw_value = os.environ.get(url_env)
    if raw_value is None:
        return "endpoint_not_configured", None

    raw = raw_value.strip()
    if not raw or any(character.isspace() or ord(character) < 32 for character in raw):
        return "endpoint_invalid", None
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return "endpoint_invalid", None
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            return "endpoint_invalid", None
        _ = parsed.port
    except ValueError:
        return "endpoint_invalid", None
    return "valid", raw


def _bounded_latency_ms(started: float) -> int:
    elapsed_ms = max(0.0, (monotonic() - started) * 1000)
    return min(MAX_DECLARATIVE_LATENCY_MS, int(elapsed_ms))


def _age_label(age_seconds: float) -> str:
    seconds = max(0, int(age_seconds))
    if seconds < 60:
        return f"{seconds} с назад"
    return f"{seconds // 60} мин назад"
