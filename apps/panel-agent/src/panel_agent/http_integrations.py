from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Callable, Dict, List, Optional, Protocol

import httpx

from .contracts import ActionDescriptor, ServicePresentation, ServiceSnapshot
from .settings import IntegrationSettings


class DetailsProvider(Protocol):
    def details_for(self, service_id: str) -> Dict[str, Any]: ...


class HttpIntegrationAdapter:
    """Managed short-request polling with last-known state and recovery."""

    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        details_provider: DetailsProvider | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._details_provider = details_provider
        self._clock = clock
        self._services = self._unavailable_services()
        self._last_success: Dict[str, tuple[ServiceSnapshot, float, str]] = {}
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        await self.refresh()
        if not self.running:
            self._task = asyncio.create_task(self._poll())

    async def close(self) -> None:
        task = self._task
        self._task = None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def refresh(self) -> bool:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        async with self._lock:
            results = await asyncio.gather(
                self._read_avalar(
                    "avalar-site-main",
                    "AVALAR Main",
                    self._settings.avalar_main_url,
                    "production",
                    90,
                    main=True,
                ),
                self._read_avalar(
                    "avalar-site-stage",
                    "AVALAR Stage",
                    self._settings.avalar_stage_url,
                    "stage",
                    80,
                    main=False,
                ),
                self._read_alice(),
            )
            self._services = [self._with_last_known(result) for result in results]
            return all(service.source == "live" for service in self._services)

    def services(self) -> List[ServiceSnapshot]:
        return list(self._services)

    async def _poll(self) -> None:
        delay = float(self._settings.http_refresh_seconds)
        while True:
            try:
                await asyncio.sleep(delay)
                all_live = await self.refresh()
                delay = (
                    float(self._settings.http_refresh_seconds)
                    if all_live
                    else min(
                        max(delay * 2, self._settings.http_refresh_seconds),
                        self._settings.integration_max_backoff_seconds,
                    )
                )
            except asyncio.CancelledError:
                raise

    def _with_last_known(self, current: ServiceSnapshot) -> ServiceSnapshot:
        now = self._clock()
        if current.source == "live":
            self._last_success[current.id] = (
                current.model_copy(deep=True),
                now,
                datetime.now(timezone.utc).isoformat(),
            )
            return current

        previous = self._last_success.get(current.id)
        if previous is None:
            return current
        snapshot, successful_at, observed_at = previous
        age = now - successful_at
        cached = snapshot.model_copy(deep=True)
        if age <= self._settings.integration_stale_after_seconds:
            cached.source = "cached"
            cached.health = "degraded"
            cached.summary = "Using last known health state"
        elif age <= self._settings.integration_unavailable_after_seconds:
            cached.source = "stale"
            cached.health = "stale"
            cached.summary = "Last known health state is stale"
        else:
            cached.source = "unavailable"
            cached.health = "offline"
            cached.summary = "Integration unavailable"
        cached.data["lastSuccessfulObservedAt"] = observed_at
        if cached.presentation:
            cached.presentation.freshnessLabel = _age_label(age)
            cached.presentation.latencyMs = None
        return cached

    async def _read_avalar(
        self,
        service_id: str,
        title: str,
        base_url: str,
        environment: str,
        priority: int,
        *,
        main: bool,
    ) -> ServiceSnapshot:
        actions = _avalar_actions(main)
        if not base_url:
            return _avalar_unavailable(
                service_id,
                title,
                environment,
                priority,
                actions,
            )
        started = monotonic()
        details = (
            self._details_provider.details_for(service_id)
            if self._details_provider
            else {}
        )
        try:
            async with httpx.AsyncClient(
                base_url=base_url,
                timeout=self._settings.http_request_timeout_seconds,
                transport=self._transport,
            ) as client:
                live_response, ready_response = await asyncio.gather(
                    client.get("/health/live"),
                    client.get("/health/ready"),
                )
            live_payload = live_response.json()
            ready_payload = ready_response.json()
            live = (
                live_response.status_code == 200
                and live_payload.get("status") == "live"
            )
            ready = (
                ready_response.status_code == 200
                and ready_payload.get("status") == "ready"
            )
            health = "healthy" if live and ready else "degraded"
            summary = "Ready" if health == "healthy" else "Readiness check failed"
            source = "live"
        except (httpx.HTTPError, ValueError):
            return _avalar_unavailable(
                service_id,
                title,
                environment,
                priority,
                actions,
                summary="Health endpoint unavailable",
            )
        latency = int((monotonic() - started) * 1000)
        return ServiceSnapshot(
            id=service_id,
            title=title,
            health=health,
            summary=summary,
            dataContract="service.health.v1",
            actions=actions,
            source=source,
            presentation=ServicePresentation(
                category="work",
                group="AVALAR",
                overview="aggregate",
                priority=priority,
                environment=environment,
                freshnessLabel="только что",
                latencyMs=latency,
            ),
            data={
                "environment": environment,
                "version": details.get("version"),
                "commit": details.get("commit"),
                "branch": details.get("branch"),
                "deploymentRevision": details.get("deployment_revision"),
                "deployedAt": details.get("deployed_at"),
                "workingTree": details.get("working_tree"),
                "detailsAvailable": bool(details),
                "detailsSource": details.get("details_source", "disabled"),
                "detailsObservedAt": details.get("details_observed_at"),
                "executor": "disabled",
            },
        )

    async def _read_alice(self) -> ServiceSnapshot:
        base_url = self._settings.alice_health_url
        if not base_url:
            return _alice_unavailable()
        started = monotonic()
        headers = (
            {"X-Internal-Secret": self._settings.alice_details_token}
            if self._settings.alice_details_token
            else {}
        )
        try:
            async with httpx.AsyncClient(
                base_url=base_url,
                timeout=self._settings.http_request_timeout_seconds,
                transport=self._transport,
            ) as client:
                ready_response = await client.get("/health/ready")
                details_response = await client.get(
                    "/health/details",
                    headers=headers,
                )
            ready_payload = ready_response.json()
            ready = (
                ready_response.status_code == 200
                and ready_payload.get("status") == "ready"
            )
            details = (
                details_response.json() if details_response.status_code == 200 else {}
            )
            health = "healthy" if ready else "degraded"
            source = "live"
        except (httpx.HTTPError, ValueError):
            return _alice_unavailable("Health endpoint unavailable")
        return ServiceSnapshot(
            id="alice-tg-bot",
            title="AliceTG Bot",
            health=health,
            summary=(
                "Telegram workflow available"
                if health == "healthy"
                else "Telegram workflow degraded"
            ),
            dataContract="service.health.v1",
            actions=[],
            source=source,
            presentation=ServicePresentation(
                category="personal-infrastructure",
                group="Personal infrastructure",
                overview="incident-only",
                priority=40,
                environment="production",
                freshnessLabel="только что",
                latencyMs=int((monotonic() - started) * 1000),
            ),
            data={
                "role": "telegram-workflow",
                "coffeeDeviceAuthority": False,
                "coffeeTimingAuthority": False,
                "homeAssistant": details.get("home_assistant"),
                "timingHelpers": details.get("timing_helpers"),
                "timingPolicyFetchedAt": details.get("timing_policy_fetched_at"),
                "version": details.get("version"),
                "commit": details.get("commit"),
            },
        )

    def _unavailable_services(self) -> List[ServiceSnapshot]:
        return [
            _avalar_unavailable(
                "avalar-site-main",
                "AVALAR Main",
                "production",
                90,
                _avalar_actions(True),
            ),
            _avalar_unavailable(
                "avalar-site-stage",
                "AVALAR Stage",
                "stage",
                80,
                _avalar_actions(False),
            ),
            _alice_unavailable(),
        ]


def _avalar_actions(main: bool) -> List[ActionDescriptor]:
    actions = [
        ActionDescriptor(
            id=f"avalar.{'main' if main else 'stage'}.smoke",
            title="Smoke check",
            enabled=False,
            risk="low",
        )
    ]
    if not main:
        actions.append(
            ActionDescriptor(
                id="avalar.stage.deploy",
                title="Deploy Stage",
                enabled=False,
                risk="high",
            )
        )
    return actions


def _avalar_unavailable(
    service_id: str,
    title: str,
    environment: str,
    priority: int,
    actions: List[ActionDescriptor],
    *,
    summary: str = "Health adapter not configured",
) -> ServiceSnapshot:
    return ServiceSnapshot(
        id=service_id,
        title=title,
        health="offline",
        summary=summary,
        dataContract="service.health.v1",
        actions=actions,
        source="unavailable",
        presentation=ServicePresentation(
            category="work",
            group="AVALAR",
            overview="aggregate",
            priority=priority,
            environment=environment,
        ),
        data={
            "environment": environment,
            "detailsSource": "disabled",
            "executor": "disabled",
        },
    )


def _alice_unavailable(summary: str = "Health adapter not configured") -> ServiceSnapshot:
    return ServiceSnapshot(
        id="alice-tg-bot",
        title="AliceTG Bot",
        health="offline",
        summary=summary,
        dataContract="service.health.v1",
        actions=[],
        source="unavailable",
        presentation=ServicePresentation(
            category="personal-infrastructure",
            group="Personal infrastructure",
            overview="incident-only",
            priority=40,
            environment="production",
        ),
        data={
            "role": "telegram-workflow",
            "coffeeDeviceAuthority": False,
            "coffeeTimingAuthority": False,
        },
    )


def _age_label(age_seconds: float) -> str:
    seconds = max(0, int(age_seconds))
    if seconds < 60:
        return f"{seconds} с назад"
    return f"{seconds // 60} мин назад"
