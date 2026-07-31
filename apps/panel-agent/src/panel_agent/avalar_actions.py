from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Literal, Protocol

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore
from .settings import IntegrationSettings

ActionId = Literal[
    "avalar.main.smoke",
    "avalar.stage.smoke",
    "avalar.main.restart",
    "avalar.stage.restart",
    "avalar.stage.deploy",
    "avalar.main.deploy",
]
ActionStatus = Literal[
    "requested",
    "prechecking",
    "accepted",
    "running",
    "verifying",
    "success",
    "failed",
]

_HOST_PATTERN = re.compile(r"^[A-Za-z0-9._@-]+$")
_SCRIPT_PATTERN = re.compile(r"^[A-Za-z0-9._/~+-]+$")
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class DetailsProvider(Protocol):
    async def refresh(self) -> None: ...
    def details_for(self, service_id: str) -> Dict[str, Any]: ...


_ACTIONS: dict[str, dict[str, Any]] = {
    "avalar.main.smoke": {
        "operation": "smoke-main",
        "environment": "production",
        "service_id": "avalar-site-main",
        "gate": "avalar_smoke_enabled",
        "cooldown": 5,
    },
    "avalar.stage.smoke": {
        "operation": "smoke-stage",
        "environment": "stage",
        "service_id": "avalar-site-stage",
        "gate": "avalar_smoke_enabled",
        "cooldown": 5,
    },
    "avalar.main.restart": {
        "operation": "restart-main",
        "environment": "production",
        "service_id": "avalar-site-main",
        "gate": "avalar_main_restart_enabled",
        "cooldown": 60,
    },
    "avalar.stage.restart": {
        "operation": "restart-stage",
        "environment": "stage",
        "service_id": "avalar-site-stage",
        "gate": "avalar_stage_restart_enabled",
        "cooldown": 60,
    },
    "avalar.stage.deploy": {
        "operation": "deploy-stage",
        "environment": "stage",
        "service_id": "avalar-site-stage",
        "gate": "avalar_stage_deploy_enabled",
        "cooldown": 300,
    },
    "avalar.main.deploy": {
        "operation": "deploy-main",
        "environment": "production",
        "service_id": "avalar-site-main",
        "gate": "avalar_main_deploy_enabled",
        "cooldown": 600,
    },
}

_ALLOWED_RESULT_FIELDS = {
    "ok",
    "operation",
    "environment",
    "status",
    "started_at",
    "finished_at",
    "checks",
    "commit_before",
    "commit_after",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat()


class AvalarActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actionId: ActionId
    expectedRevision: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{40}$",
    )
    confirmation: str | None = Field(default=None, max_length=120)


class AvalarActionExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1] = 1
    correlationId: str
    actionId: ActionId
    environment: Literal["production", "stage"]
    status: ActionStatus
    requestedAt: str
    updatedAt: str
    finishedAt: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


class AvalarActionExecutor:
    def __init__(
        self,
        settings: IntegrationSettings,
        access: AccessPolicyStore,
        *,
        details_provider: DetailsProvider,
        refresh_callback: Callable[[], Awaitable[None]] | None = None,
        command_runner: Callable[[str], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self.settings = settings
        self.access = access
        self.details_provider = details_provider
        self.refresh_callback = refresh_callback
        self.command_runner = command_runner or self._run_fixed_command
        self.executions: OrderedDict[str, AvalarActionExecution] = OrderedDict()
        self.active_correlation_id: str | None = None
        self.cooldowns: dict[str, datetime] = {}
        self._lock = asyncio.Lock()

    def set_refresh_callback(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self.refresh_callback = callback

    def gate_enabled(self, action_id: str) -> bool:
        descriptor = _ACTIONS[action_id]
        return bool(
            self.settings.writes_enabled
            and self.settings.avalar_actions_enabled
            and getattr(self.settings, descriptor["gate"])
        )

    def availability(self, action_id: str) -> dict[str, Any]:
        descriptor = _ACTIONS[action_id]
        cooldown_until = self.cooldowns.get(action_id)
        cooldown = cooldown_until is not None and cooldown_until > _now()
        decision = self.access.authorize(
            action_id,
            gate_enabled=self.gate_enabled(action_id),
            integration_available=bool(
                self.settings.avalar_action_ssh_host
                and self.settings.avalar_action_remote_script
            ),
            busy=self.active_correlation_id is not None,
            cooldown=cooldown,
        )
        payload = decision.as_dict()
        payload["cooldownUntil"] = _iso(cooldown_until) if cooldown else None
        return payload

    async def start(self, request: AvalarActionRequest) -> AvalarActionExecution:
        action_id = request.actionId
        descriptor = _ACTIONS[action_id]
        self.access.require(
            action_id,
            gate_enabled=self.gate_enabled(action_id),
            integration_available=bool(
                self.settings.avalar_action_ssh_host
                and self.settings.avalar_action_remote_script
            ),
            busy=self.active_correlation_id is not None,
            cooldown=(
                self.cooldowns.get(action_id) is not None
                and self.cooldowns[action_id] > _now()
            ),
        )
        if action_id == "avalar.main.restart" and request.confirmation != "RESTART MAIN":
            raise HTTPException(status_code=409, detail="main_restart_confirmation_required")
        if action_id == "avalar.main.deploy" and request.confirmation != "DEPLOY MAIN":
            raise HTTPException(status_code=409, detail="main_deploy_confirmation_required")

        details = self.details_provider.details_for(descriptor["service_id"])
        current_revision = details.get("deployment_revision") or details.get("commit")
        if request.expectedRevision and current_revision != request.expectedRevision:
            raise HTTPException(status_code=409, detail="revision_conflict")

        correlation_id = str(uuid.uuid4())
        execution = AvalarActionExecution(
            correlationId=correlation_id,
            actionId=action_id,
            environment=descriptor["environment"],
            status="requested",
            requestedAt=_iso(),
            updatedAt=_iso(),
        )
        self.executions[correlation_id] = execution
        while len(self.executions) > 50:
            self.executions.popitem(last=False)
        self.active_correlation_id = correlation_id
        self.access.audit_capability(action_id, result="accepted", correlation_id=correlation_id)
        asyncio.create_task(self._execute(correlation_id, current_revision))
        return execution.model_copy(deep=True)

    def get(self, correlation_id: str) -> AvalarActionExecution:
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
        finished = status_value in {"success", "failed"}
        self.executions[correlation_id] = current.model_copy(
            update={
                "status": status_value,
                "updatedAt": _iso(),
                "finishedAt": _iso() if finished else None,
                "result": result,
                "error": error,
            }
        )

    async def _execute(self, correlation_id: str, revision_before: str | None) -> None:
        execution = self.executions[correlation_id]
        action_id = execution.actionId
        descriptor = _ACTIONS[action_id]
        try:
            async with self._lock:
                self._update(correlation_id, "prechecking")
                self._update(correlation_id, "accepted")
                self._update(correlation_id, "running")
                result = await self.command_runner(descriptor["operation"])
                self._update(correlation_id, "verifying")
                await self._verify_public_health(descriptor["environment"])
                await self.details_provider.refresh()
                details_after = self.details_provider.details_for(descriptor["service_id"])
                revision_after = details_after.get("deployment_revision") or details_after.get("commit")
                if ".restart" in action_id and revision_before and revision_after != revision_before:
                    raise RuntimeError("restart_changed_revision")
                if result.get("environment") != descriptor["environment"]:
                    raise RuntimeError("environment_mismatch")
                sanitized = {key: result.get(key) for key in _ALLOWED_RESULT_FIELDS if key in result}
                sanitized["revisionBefore"] = revision_before
                sanitized["revisionAfter"] = revision_after
                self.cooldowns[action_id] = _now() + timedelta(seconds=descriptor["cooldown"])
                self._update(correlation_id, "success", result=sanitized)
                self.access.audit_capability(
                    action_id,
                    result="success",
                    correlation_id=correlation_id,
                )
                if self.refresh_callback is not None:
                    await self.refresh_callback()
        except Exception as exc:
            error = _sanitize_error(exc)
            self._update(correlation_id, "failed", error=error)
            self.access.audit_capability(
                action_id,
                result=error,
                correlation_id=correlation_id,
            )
        finally:
            if self.active_correlation_id == correlation_id:
                self.active_correlation_id = None

    async def _verify_public_health(self, environment: str) -> None:
        base_url = (
            self.settings.avalar_main_url
            if environment == "production"
            else self.settings.avalar_stage_url
        )
        if not base_url:
            raise RuntimeError("public_health_not_configured")
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=self.settings.http_request_timeout_seconds,
        ) as client:
            live, ready, root = await asyncio.gather(
                client.get("/health/live"),
                client.get("/health/ready"),
                client.get("/"),
            )
        live_payload = live.json()
        ready_payload = ready.json()
        if live.status_code != 200 or live_payload.get("status") != "live":
            raise RuntimeError("live_verification_failed")
        if ready.status_code != 200 or ready_payload.get("status") != "ready":
            raise RuntimeError("ready_verification_failed")
        if root.status_code >= 400:
            raise RuntimeError("root_verification_failed")

    async def _run_fixed_command(self, operation: str) -> dict[str, Any]:
        if operation not in {descriptor["operation"] for descriptor in _ACTIONS.values()}:
            raise RuntimeError("action_not_allowlisted")
        host = self.settings.avalar_action_ssh_host
        script = self.settings.avalar_action_remote_script
        if not _HOST_PATTERN.fullmatch(host) or not _SCRIPT_PATTERN.fullmatch(script):
            raise RuntimeError("unsafe_action_configuration")
        process = await asyncio.create_subprocess_exec(
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={min(15, self.settings.avalar_action_timeout_seconds)}",
            host,
            script,
            operation,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        limit = self.settings.avalar_action_output_limit_bytes
        try:
            stdout, stderr, returncode = await asyncio.wait_for(
                asyncio.gather(
                    _read_limited(process.stdout, limit),
                    _read_limited(process.stderr, limit),
                    process.wait(),
                ),
                timeout=self.settings.avalar_action_timeout_seconds,
            )
        except asyncio.TimeoutError:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise RuntimeError("action_timeout")
        if returncode != 0:
            raise RuntimeError(_map_return_code(returncode))
        try:
            payload = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RuntimeError("invalid_action_response")
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise RuntimeError("action_reported_failure")
        return payload


def build_avalar_action_router(executor: AvalarActionExecutor) -> APIRouter:
    router = APIRouter(prefix="/api/v1/actions/avalar", tags=["avalar-actions"])

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return {
            "schemaVersion": 1,
            "actions": {
                action_id: executor.availability(action_id)
                for action_id in _ACTIONS
            },
        }

    @router.post("", response_model=AvalarActionExecution, status_code=status.HTTP_202_ACCEPTED)
    async def start_action(
        payload: AvalarActionRequest,
        response: Response,
    ) -> AvalarActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return await executor.start(payload)

    @router.get("/{correlation_id}", response_model=AvalarActionExecution)
    def get_action(correlation_id: str, response: Response) -> AvalarActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return executor.get(correlation_id)

    return router


async def _read_limited(stream: asyncio.StreamReader | None, limit: int) -> bytes:
    if stream is None:
        return b""
    data = bytearray()
    while True:
        chunk = await stream.read(min(4096, limit + 1 - len(data)))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > limit:
            raise RuntimeError("action_output_too_large")


def _map_return_code(returncode: int) -> str:
    return {
        64: "invalid_action_request",
        69: "action_dependency_unavailable",
        75: "action_busy_or_cooldown",
        77: "host_gate_disabled",
        124: "action_timeout",
    }.get(returncode, "remote_action_failed")


def _sanitize_error(error: Exception) -> str:
    value = str(error)
    allowed = {
        "action_not_allowlisted",
        "unsafe_action_configuration",
        "action_timeout",
        "invalid_action_response",
        "action_reported_failure",
        "action_output_too_large",
        "invalid_action_request",
        "action_dependency_unavailable",
        "action_busy_or_cooldown",
        "host_gate_disabled",
        "remote_action_failed",
        "public_health_not_configured",
        "live_verification_failed",
        "ready_verification_failed",
        "root_verification_failed",
        "restart_changed_revision",
        "environment_mismatch",
    }
    return value if value in allowed else "action_failed"
