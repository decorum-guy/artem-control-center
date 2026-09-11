"""Shared, bounded AVALAR live/ready health semantics.

The legacy HTTP integration and the declarative project bridge deliberately
share this reader.  AVALAR's public health contract is two fixed JSON GETs;
the project registry only selects the registered adapter and backend-owned
environment variable, it never supplies a resolved URL to the browser.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from time import monotonic
from typing import Literal, Optional

import httpx


MAX_AVALAR_REQUEST_TIMEOUT_SECONDS = 30.0
MAX_AVALAR_LATENCY_MS = int(MAX_AVALAR_REQUEST_TIMEOUT_SECONDS * 1000)

AVALAR_URL_ENV_BY_TARGET = {
    "main": "PANEL_AVALAR_MAIN_URL",
    "stage": "PANEL_AVALAR_STAGE_URL",
}

AVALAR_LEGACY_SERVICE_ID_BY_TARGET = {
    "main": "avalar-site-main",
    "stage": "avalar-site-stage",
}

AvalarTarget = Literal["main", "stage"]
AvalarHealthOutcome = Literal["live", "unavailable"]


@dataclass(frozen=True)
class AvalarHealthProbeResult:
    """A browser-safe result of the fixed live/ready contract."""

    outcome: AvalarHealthOutcome
    health: Literal["healthy", "degraded"] | None = None
    summary: str = "Health endpoint unavailable"
    latency_ms: int | None = None


def avalar_target_for_url_env(url_env: str) -> AvalarTarget | None:
    for target, candidate in AVALAR_URL_ENV_BY_TARGET.items():
        if url_env == candidate:
            return target  # type: ignore[return-value]
    return None


def avalar_target_for_environment(environment_id: str) -> AvalarTarget | None:
    """Normalize only the stable Main/Stage environment spellings."""

    if environment_id in {"main", "production"}:
        return "main"
    if environment_id == "stage":
        return "stage"
    return None


def legacy_avalar_service_id(target: AvalarTarget) -> str:
    """Return the compatibility identity used by the pre-registry adapters."""

    return AVALAR_LEGACY_SERVICE_ID_BY_TARGET[target]


async def probe_avalar_health(
    base_url: str,
    request_timeout_seconds: float,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    clock=monotonic,
) -> AvalarHealthProbeResult:
    """Read AVALAR live/ready endpoints using the established semantics.

    A valid HTTP/JSON response with a failed live or ready status is a
    degraded live observation.  Transport failures and malformed response
    bodies are unavailable observations and remain eligible for the caller's
    last-known/cached policy.
    """

    started = clock()
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=min(
                MAX_AVALAR_REQUEST_TIMEOUT_SECONDS,
                max(1.0, float(request_timeout_seconds)),
            ),
            transport=transport,
            follow_redirects=False,
        ) as client:
            live_response, ready_response = await asyncio.gather(
                client.get("/health/live"),
                client.get("/health/ready"),
            )
        live_payload = _json_object(live_response)
        ready_payload = _json_object(ready_response)
    except (asyncio.TimeoutError, httpx.HTTPError, ValueError, TypeError):
        return AvalarHealthProbeResult("unavailable")

    live = (
        live_response.status_code == 200
        and live_payload.get("status") == "live"
    )
    ready = (
        ready_response.status_code == 200
        and ready_payload.get("status") == "ready"
    )
    health: Literal["healthy", "degraded"] = "healthy" if live and ready else "degraded"
    return AvalarHealthProbeResult(
        "live",
        health=health,
        summary="Ready" if health == "healthy" else "Readiness check failed",
        latency_ms=_bounded_latency_ms(started, clock),
    )


def _json_object(response: httpx.Response) -> dict:
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("health response must be an object")
    return payload


def _bounded_latency_ms(started: float, clock=monotonic) -> int:
    elapsed_ms = max(0.0, (clock() - started) * 1000)
    return min(MAX_AVALAR_LATENCY_MS, int(elapsed_ms))
