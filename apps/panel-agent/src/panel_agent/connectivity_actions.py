from __future__ import annotations

import asyncio
import os
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Protocol
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from .access_policy import CAPABILITIES, AccessPolicyStore
from .settings import IntegrationSettings

ActionId = Literal["system.connectivity.restart"]
ActionStatus = Literal[
    "requested",
    "restarting",
    "waiting_for_forwards",
    "verifying",
    "connected",
    "degraded",
    "failed",
]

_TERMINAL_STATUSES = {"connected", "degraded", "failed"}

# Connectivity recovery is a routine Standard-level operation. Register it before
# the access router materialises its capability snapshot in production.py.
CAPABILITIES.setdefault("system.connectivity.restart", "standard")


class HomeAssistantRuntime(Protocol):
    async def fetch_initial_snapshot(self) -> None: ...
    def services(self) -> list[Any]: ...


class HttpRuntime(Protocol):
    async def refresh(self) -> bool: ...
    def services(self) -> list[Any]: ...


class RuntimeProtocol(Protocol):
    home_assistant: HomeAssistantRuntime
    http: HttpRuntime


class ConnectivityActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actionId: ActionId


class ConnectivityActionExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1] = 1
    correlationId: str
    actionId: ActionId
    status: ActionStatus
    requestedAt: str
    updatedAt: str
    finishedAt: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


def _utc_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _default_restart_script() -> Path:
    return Path(__file__).resolve().parents[4] / "scripts" / "windows" / "restart-connectivity-tunnel.ps1"


def _loopback_target(url: str) -> tuple[str, int] | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, port


class ConnectivityActionExecutor:
    def __init__(
        self,
        settings: IntegrationSettings,
        access: AccessPolicyStore,
        *,
        runtime: RuntimeProtocol,
        restart_runner: Callable[[], Awaitable[None]] | None = None,
        port_probe: Callable[[str, int], Awaitable[bool]] | None = None,
        script_path: str | Path | None = None,
        forwards_timeout_seconds: float = 45.0,
        verification_timeout_seconds: float = 45.0,
    ) -> None:
        self.settings = settings
        self.access = access
        self.runtime = runtime
        self.script_path = Path(script_path) if script_path else _default_restart_script()
        self._custom_restart_runner = restart_runner is not None
        self.restart_runner = restart_runner or self._run_fixed_restart
        self.port_probe = port_probe or self._probe_port
        self.forwards_timeout_seconds = max(1.0, forwards_timeout_seconds)
        self.verification_timeout_seconds = max(1.0, verification_timeout_seconds)
        self.executions: OrderedDict[str, ConnectivityActionExecution] = OrderedDict()
        self.active_correlation_id: str | None = None
        self._lock = asyncio.Lock()

    def _targets(self) -> tuple[tuple[str, int], tuple[str, int]] | None:
        ha = _loopback_target(self.settings.ha_url)
        alice = _loopback_target(self.settings.alice_health_url)
        if ha is None or alice is None:
            return None
        return ha, alice

    def integration_available(self) -> bool:
        return bool(
            self._targets()
            and (
                self._custom_restart_runner
                or (os.name == "nt" and self.script_path.is_file())
            )
        )

    def availability(self) -> dict[str, Any]:
        decision = self.access.authorize(
            "system.connectivity.restart",
            integration_available=self.integration_available(),
            busy=self.active_correlation_id is not None,
        )
        payload = decision.as_dict()
        payload["activeCorrelationId"] = self.active_correlation_id
        return payload

    async def start(self, request: ConnectivityActionRequest) -> ConnectivityActionExecution:
        self.access.require(
            request.actionId,
            integration_available=self.integration_available(),
            busy=self.active_correlation_id is not None,
        )
        correlation_id = str(uuid.uuid4())
        execution = ConnectivityActionExecution(
            correlationId=correlation_id,
            actionId=request.actionId,
            status="requested",
            requestedAt=_utc_iso(),
            updatedAt=_utc_iso(),
        )
        self.executions[correlation_id] = execution
        while len(self.executions) > 50:
            self.executions.popitem(last=False)
        self.active_correlation_id = correlation_id
        self.access.audit_capability(
            request.actionId,
            result="accepted",
            correlation_id=correlation_id,
        )
        asyncio.create_task(self._execute(correlation_id))
        return execution.model_copy(deep=True)

    def get(self, correlation_id: str) -> ConnectivityActionExecution:
        execution = self.executions.get(correlation_id)
        if execution is None:
            raise HTTPException(status_code=404, detail="action_not_found")
        return execution.model_copy(deep=True)

    def _update(
        self,
        correlation_id: str,
        status_value: ActionStatus,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        current = self.executions[correlation_id]
        finished = status_value in _TERMINAL_STATUSES
        self.executions[correlation_id] = current.model_copy(
            update={
                "status": status_value,
                "updatedAt": _utc_iso(),
                "finishedAt": _utc_iso() if finished else None,
                "result": result,
                "error": error,
            }
        )

    async def _execute(self, correlation_id: str) -> None:
        try:
            async with self._lock:
                self._update(correlation_id, "restarting")
                await self.restart_runner()

                self._update(correlation_id, "waiting_for_forwards")
                ha_forward, alice_forward = await self._wait_for_forwards()
                forward_result = {
                    "homeAssistantForwardReady": ha_forward,
                    "aliceForwardReady": alice_forward,
                }
                if not ha_forward or not alice_forward:
                    status_value: ActionStatus = "degraded" if (ha_forward or alice_forward) else "failed"
                    error = "partial_forward_recovery" if status_value == "degraded" else "forwards_unavailable"
                    self._update(
                        correlation_id,
                        status_value,
                        result=forward_result,
                        error=error,
                    )
                    self.access.audit_capability(
                        "system.connectivity.restart",
                        result=error,
                        correlation_id=correlation_id,
                    )
                    return

                self._update(correlation_id, "verifying")
                verification = await self._verify_downstreams()
                result = {**forward_result, **verification}
                if verification["homeAssistantLive"] and verification["aliceLive"]:
                    self._update(correlation_id, "connected", result=result)
                    self.access.audit_capability(
                        "system.connectivity.restart",
                        result="success",
                        correlation_id=correlation_id,
                    )
                else:
                    self._update(
                        correlation_id,
                        "degraded",
                        result=result,
                        error="downstream_verification_incomplete",
                    )
                    self.access.audit_capability(
                        "system.connectivity.restart",
                        result="downstream_verification_incomplete",
                        correlation_id=correlation_id,
                    )
        except Exception as exc:
            error = _sanitize_error(exc)
            self._update(correlation_id, "failed", error=error)
            self.access.audit_capability(
                "system.connectivity.restart",
                result=error,
                correlation_id=correlation_id,
            )
        finally:
            if self.active_correlation_id == correlation_id:
                self.active_correlation_id = None

    async def _wait_for_forwards(self) -> tuple[bool, bool]:
        targets = self._targets()
        if targets is None:
            raise RuntimeError("connectivity_not_configured")
        ha_target, alice_target = targets
        deadline = asyncio.get_running_loop().time() + self.forwards_timeout_seconds
        ha_ready = False
        alice_ready = False
        while asyncio.get_running_loop().time() < deadline:
            ha_ready, alice_ready = await asyncio.gather(
                self.port_probe(*ha_target),
                self.port_probe(*alice_target),
            )
            if ha_ready and alice_ready:
                return True, True
            await asyncio.sleep(0.75)
        return ha_ready, alice_ready

    async def _verify_downstreams(self) -> dict[str, bool]:
        deadline = asyncio.get_running_loop().time() + self.verification_timeout_seconds
        last = {
            "homeAssistantLive": False,
            "homeAssistantWebSocket": False,
            "homeAssistantSnapshotConfirmed": False,
            "aliceLive": False,
            "aliceHealthy": False,
        }
        while asyncio.get_running_loop().time() < deadline:
            try:
                await self.runtime.home_assistant.fetch_initial_snapshot()
            except Exception:
                pass
            try:
                await self.runtime.http.refresh()
            except Exception:
                pass

            ha = next(
                (
                    service
                    for service in self.runtime.home_assistant.services()
                    if getattr(service, "id", None) == "home-assistant"
                ),
                None,
            )
            alice = next(
                (
                    service
                    for service in self.runtime.http.services()
                    if getattr(service, "id", None) == "alice-tg-bot"
                ),
                None,
            )
            transport = getattr(ha, "data", {}).get("transport", {}) if ha else {}
            last = {
                "homeAssistantLive": bool(
                    ha
                    and getattr(ha, "source", None) == "live"
                    and transport.get("snapshotConfirmed") is True
                    and transport.get("websocketConnected") is True
                ),
                "homeAssistantWebSocket": transport.get("websocketConnected") is True,
                "homeAssistantSnapshotConfirmed": transport.get("snapshotConfirmed") is True,
                "aliceLive": bool(
                    alice
                    and getattr(alice, "source", None) == "live"
                    and getattr(alice, "health", None) == "healthy"
                ),
                "aliceHealthy": bool(alice and getattr(alice, "health", None) == "healthy"),
            }
            if last["homeAssistantLive"] and last["aliceLive"]:
                return last
            await asyncio.sleep(1.0)
        return last

    async def _probe_port(self, host: str, port: int) -> bool:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=1.0,
            )
            del reader
            writer.close()
            await writer.wait_closed()
            return True
        except (OSError, asyncio.TimeoutError):
            return False

    async def _run_fixed_restart(self) -> None:
        if os.name != "nt" or not self.script_path.is_file():
            raise RuntimeError("connectivity_restart_unavailable")
        process = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.script_path),
            "-Json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=20)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError("connectivity_restart_timeout")
        if len(stdout) > 16_384 or len(stderr) > 16_384:
            raise RuntimeError("connectivity_restart_output_too_large")
        if process.returncode != 0:
            raise RuntimeError("connectivity_restart_failed")


def build_connectivity_action_router(executor: ConnectivityActionExecutor) -> APIRouter:
    router = APIRouter(prefix="/api/v1/actions/system/connectivity", tags=["connectivity-actions"])

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return {
            "schemaVersion": 1,
            "action": executor.availability(),
        }

    @router.post("", response_model=ConnectivityActionExecution, status_code=status.HTTP_202_ACCEPTED)
    async def start_action(
        payload: ConnectivityActionRequest,
        response: Response,
    ) -> ConnectivityActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return await executor.start(payload)

    @router.get("/{correlation_id}", response_model=ConnectivityActionExecution)
    def get_action(correlation_id: str, response: Response) -> ConnectivityActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return executor.get(correlation_id)

    return router


def _sanitize_error(error: Exception) -> str:
    value = str(error)
    allowed = {
        "connectivity_not_configured",
        "connectivity_restart_unavailable",
        "connectivity_restart_timeout",
        "connectivity_restart_output_too_large",
        "connectivity_restart_failed",
        "forwards_unavailable",
        "partial_forward_recovery",
        "downstream_verification_incomplete",
    }
    return value if value in allowed else "connectivity_restart_failed"
