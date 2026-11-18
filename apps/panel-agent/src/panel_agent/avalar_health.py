"""Shared, bounded AVALAR live/ready health semantics.

The legacy HTTP integration and the declarative project bridge deliberately
share this reader.  AVALAR's public health contract is two fixed JSON GETs and its rendered homepage;
the project registry only selects the registered adapter and backend-owned
environment variable, it never supplies a resolved URL to the browser.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
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

AVALAR_HEALTH_REASONS = {
    "avalar_health_forbidden": "Доступ к проверке приложения ограничен (HTTP 403)",
    "avalar_health_missing": "Маршрут проверки приложения отсутствует (HTTP 404)",
    "avalar_page_failed": "Главная страница AVALAR не прошла проверку",
    "avalar_stage_not_ready": "Приложение закрытого Stage не прошло проверку готовности по SSH",
}


@dataclass(frozen=True)
class AvalarHealthProbeResult:
    """A browser-safe result of the fixed live/ready contract."""

    outcome: AvalarHealthOutcome
    health: Literal["healthy", "degraded"] | None = None
    summary: str = "Health endpoint unavailable"
    latency_ms: int | None = None
    error_code: str | None = None
    http_status: int | None = None
    private_routes_forbidden: bool = False
    page_status: int | None = None
    page_valid: bool = False


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


class _HomepageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_title = False
        self.title = ""
        self.site_header = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag == "header" and dict(attrs).get("id") == "mainHeader":
            self.site_header = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data

    @property
    def valid(self) -> bool:
        return self.title.strip().upper().split(" ", 1)[0] == "AVALAR" and self.site_header


async def _homepage(client: httpx.AsyncClient) -> tuple[int | None, bool]:
    # Ignore redirects, hosting placeholders and status pages. Read only the
    # opening markup and never retain the page or expose it in diagnostics.
    try:
        async with client.stream("GET", "/") as response:
            if response.status_code != 200 or response.headers.get("content-type", "").split(";")[0].strip().lower() != "text/html":
                return response.status_code, False
            parser = _HomepageParser()
            remaining = 64 * 1024
            async for chunk in response.aiter_bytes(chunk_size=4096):
                parser.feed(chunk[:remaining].decode("latin-1"))
                if parser.valid:
                    return 200, True
                remaining -= len(chunk)
                if remaining <= 0:
                    break
            return 200, False
    except (httpx.HTTPError, ValueError):
        return None, False


def private_stage_status(details: dict, refresh_seconds: int) -> str | None:
    if details.get("details_source") != "live" or details.get("environment") != "stage":
        return None
    for key in ("details_observed_at", "observed_at"):
        try:
            stamp = datetime.fromisoformat(details[key].replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - stamp).total_seconds()
        except (KeyError, AttributeError, TypeError, ValueError):
            return None
        if not -30 <= age <= min(600, refresh_seconds * 2):
            return None
    if details.get("application_readiness") == "not_ready":
        return "avalar_stage_not_ready"
    if details.get("page_readiness") == "not_ready":
        return "avalar_page_failed"
    if details.get("application_readiness") == details.get("page_readiness") == "ready":
        return "ready"
    return None


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
            live_response, ready_response, (page_status, page_valid) = await asyncio.gather(
                client.get("/health/live"),
                client.get("/health/ready"),
                _homepage(client),
            )
        statuses = {live_response.status_code, ready_response.status_code}
        for status, reason in ((403, "avalar_health_forbidden"), (404, "avalar_health_missing")):
            if status in statuses:
                return AvalarHealthProbeResult(
                    "live", health="degraded", summary=AVALAR_HEALTH_REASONS[reason],
                    latency_ms=_bounded_latency_ms(started, clock), error_code=reason,
                    http_status=status, private_routes_forbidden=statuses == {403} and page_status == 403,
                    page_status=page_status, page_valid=page_valid,
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
    health: Literal["healthy", "degraded"] = "healthy" if live and ready and page_valid else "degraded"
    page_error = live and ready and not page_valid
    return AvalarHealthProbeResult(
        "live",
        health=health,
        summary="Главная страница и приложение доступны" if health == "healthy" else (
            AVALAR_HEALTH_REASONS["avalar_page_failed"] if page_error else "Readiness check failed"
        ),
        error_code="avalar_page_failed" if page_error else None,
        page_status=page_status, page_valid=page_valid,
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
