from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Dict, List, Optional

import httpx

from .contracts import ActionDescriptor, ServicePresentation, ServiceSnapshot
from .settings import IntegrationSettings


class HttpIntegrationAdapter:
    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._services = self._unavailable_services()

    async def refresh(self) -> None:
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
        self._services = list(results)

    def services(self) -> List[ServiceSnapshot]:
        return list(self._services)

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
        if not base_url:
            return _avalar_unavailable(
                service_id,
                title,
                environment,
                priority,
                actions,
            )
        started = monotonic()
        headers = (
            {"X-Health-Token": self._settings.avalar_details_token}
            if self._settings.avalar_details_token
            else {}
        )
        try:
            async with httpx.AsyncClient(
                base_url=base_url,
                timeout=10,
                transport=self._transport,
            ) as client:
                ready_response = await client.get("/health/ready")
                details_response = await client.get(
                    "/health/details",
                    headers=headers,
                )
            ready_payload = ready_response.json()
            details: Dict[str, Any] = (
                details_response.json() if details_response.status_code == 200 else {}
            )
            ready = ready_response.status_code == 200 and ready_payload.get("status") == "ready"
            health = "healthy" if ready else "degraded"
            source = "live"
            summary = "Ready" if ready else "Readiness check failed"
        except (httpx.HTTPError, ValueError):
            details = {}
            health = "offline"
            source = "unavailable"
            summary = "Health endpoint unavailable"
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
                freshnessLabel="только что" if source == "live" else None,
                latencyMs=latency,
            ),
            data={
                "environment": environment,
                "version": details.get("version"),
                "commit": details.get("commit"),
                "deploymentRevision": details.get("deployment_revision"),
                "deployedAt": details.get("deployed_at"),
                "detailsAvailable": bool(details),
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
                timeout=10,
                transport=self._transport,
            ) as client:
                ready_response = await client.get("/health/ready")
                details_response = await client.get(
                    "/health/details",
                    headers=headers,
                )
            ready = ready_response.status_code == 200
            details = (
                details_response.json() if details_response.status_code == 200 else {}
            )
            health = "healthy" if ready else "degraded"
            source = "live"
        except (httpx.HTTPError, ValueError):
            details = {}
            health = "offline"
            source = "unavailable"
        return ServiceSnapshot(
            id="alice-tg-bot",
            title="AliceTG Bot",
            health=health,
            summary=(
                "Telegram workflow available"
                if health == "healthy"
                else "Telegram workflow unavailable"
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
                freshnessLabel="только что" if source == "live" else None,
                latencyMs=int((monotonic() - started) * 1000),
            ),
            data={
                "role": "telegram-workflow",
                "coffeeDeviceAuthority": False,
                "coffeeTimingAuthority": False,
                "homeAssistant": details.get("home_assistant"),
                "timingHelpers": details.get("timing_helpers"),
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
                [
                    ActionDescriptor(
                        id="avalar.main.smoke",
                        title="Smoke check",
                        enabled=False,
                        risk="low",
                    )
                ],
            ),
            _avalar_unavailable(
                "avalar-site-stage",
                "AVALAR Stage",
                "stage",
                80,
                [
                    ActionDescriptor(
                        id="avalar.stage.smoke",
                        title="Smoke check",
                        enabled=False,
                        risk="low",
                    ),
                    ActionDescriptor(
                        id="avalar.stage.deploy",
                        title="Deploy Stage",
                        enabled=False,
                        risk="high",
                    ),
                ],
            ),
            _alice_unavailable(),
        ]


def _avalar_unavailable(
    service_id: str,
    title: str,
    environment: str,
    priority: int,
    actions: List[ActionDescriptor],
) -> ServiceSnapshot:
    return ServiceSnapshot(
        id=service_id,
        title=title,
        health="offline",
        summary="Health adapter not configured",
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
        data={"environment": environment, "executor": "disabled"},
    )


def _alice_unavailable() -> ServiceSnapshot:
    return ServiceSnapshot(
        id="alice-tg-bot",
        title="AliceTG Bot",
        health="offline",
        summary="Health adapter not configured",
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
