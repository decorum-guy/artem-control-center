"""Pinned SSH control of the fixed home-server maintenance helper.

The Home Assistant deployment is a Docker/Compose container. Its lifecycle
belongs to the home server, not Home Assistant's `update.install` service.
Nothing from a browser request selects an SSH target, command, compose path,
container, service, image or tag.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from .access_policy import AccessPolicyStore
from .settings import IntegrationSettings

RESTART_ACTION = "system.home_assistant.restart"
UPDATE_CORE_ACTION = "system.home_assistant.update_core"
RESTART_CADDY_ACTION = "system.home_server.caddy.restart"
RESTART_BOT_ACTION = "system.home_server.bot.restart"
MaintenanceActionId = Literal[
    "system.home_assistant.restart", "system.home_assistant.update_core",
    "system.home_server.caddy.restart", "system.home_server.bot.restart",
]
MAINTENANCE_ACTION_IDS: tuple[MaintenanceActionId, ...] = (
    RESTART_ACTION, UPDATE_CORE_ACTION, RESTART_CADDY_ACTION, RESTART_BOT_ACTION,
)
_OPERATION_BY_ACTION: dict[MaintenanceActionId, str] = {
    RESTART_ACTION: "restart-ha", UPDATE_CORE_ACTION: "update-ha",
    RESTART_CADDY_ACTION: "restart-caddy", RESTART_BOT_ACTION: "restart-bot",
}
_SSH_OPERATIONS = frozenset({"status", *tuple(_OPERATION_BY_ACTION.values())})
_SAFE_FAILURES = frozenset({
    "home_server_not_configured", "ssh_client_unavailable",
    "ssh_identity_file_missing", "ssh_known_hosts_file_missing", "ssh_timeout",
    "ssh_output_too_large", "ssh_transport_failed", "ssh_invalid_response",
    "helper_failed", "configuration_missing", "maintenance_busy", "compose_failed",
    "restart_recovery_timeout", "update_recovery_timeout", "update_failed",
})
_HOST_PATTERN = re.compile(r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$")
_USER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class HomeServerMaintenanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    actionId: MaintenanceActionId
    requestId: UUID


class HomeServerMaintenanceError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code if code in _SAFE_FAILURES else "helper_failed"


def _safe_helper_failure(stdout: bytes) -> str:
    """Accept only the helper's closed, non-secret failure envelope."""
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "helper_failed"
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1 or payload.get("ok") is not False:
        return "helper_failed"
    error = payload.get("error")
    return error if isinstance(error, str) and error in _SAFE_FAILURES else "helper_failed"


def _valid_host(value: str) -> bool:
    return bool(value and "@" not in value and not any(char.isspace() or ord(char) < 32 for char in value) and _HOST_PATTERN.fullmatch(value))


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
            raise HomeServerMaintenanceError("ssh_output_too_large")


@dataclass
class _Execution:
    request_id: str
    action_id: MaintenanceActionId
    status: str = "requested"
    result: str | None = None
    failure_code: str | None = None

    def public(self) -> dict[str, Any]:
        return {"schemaVersion": 1, "requestId": self.request_id, "actionId": self.action_id, "status": self.status, "result": self.result, "failureCode": self.failure_code}


class HomeServerSshTransport:
    """One product-control identity and one operation-token remote command."""

    def __init__(self, settings: IntegrationSettings, *, executable_finder=shutil.which) -> None:
        self.host = settings.home_server_ssh_host
        self.user = settings.home_server_ssh_user
        self.port = settings.home_server_ssh_port
        self.identity_file = settings.home_server_ssh_identity_file
        self.known_hosts_file = settings.home_server_ssh_known_hosts_file
        self.connect_timeout = settings.home_server_ssh_connect_timeout_seconds
        self.command_timeout = settings.home_server_ssh_command_timeout_seconds
        self.output_limit = settings.home_server_ssh_output_limit_bytes
        self._executable_finder = executable_finder

    def configured(self) -> bool:
        return bool(_valid_host(self.host) and _USER_PATTERN.fullmatch(self.user) and self.identity_file and self.known_hosts_file and Path(self.identity_file).is_file() and Path(self.known_hosts_file).is_file())

    def argv(self, executable: str, operation: str) -> tuple[str, ...]:
        if operation not in _SSH_OPERATIONS:
            raise HomeServerMaintenanceError("helper_failed")
        # The dedicated `artem-home-control` host key has a forced command;
        # this final one-token argument is all it receives from Panel Agent.
        null_config = os.devnull
        return (executable, "-F", null_config, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={self.known_hosts_file}", "-o", f"GlobalKnownHostsFile={os.devnull}", "-o", f"ConnectTimeout={self.connect_timeout}", "-o", "ConnectionAttempts=1", "-o", "NumberOfPasswordPrompts=0", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-l", self.user, "-i", self.identity_file, "-p", str(self.port), self.host, operation)

    async def run(self, operation: str) -> dict[str, Any]:
        if operation not in _SSH_OPERATIONS:
            raise HomeServerMaintenanceError("helper_failed")
        if not self.configured():
            if not Path(self.identity_file).is_file():
                raise HomeServerMaintenanceError("ssh_identity_file_missing")
            if not Path(self.known_hosts_file).is_file():
                raise HomeServerMaintenanceError("ssh_known_hosts_file_missing")
            raise HomeServerMaintenanceError("home_server_not_configured")
        executable = self._executable_finder("ssh")
        if not executable:
            raise HomeServerMaintenanceError("ssh_client_unavailable")
        try:
            process = await asyncio.create_subprocess_exec(*self.argv(executable, operation), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError:
            raise HomeServerMaintenanceError("ssh_client_unavailable") from None
        except (OSError, ValueError):
            raise HomeServerMaintenanceError("ssh_transport_failed") from None
        reads = (asyncio.create_task(_read_limited(process.stdout, self.output_limit)), asyncio.create_task(_read_limited(process.stderr, self.output_limit)), asyncio.create_task(process.wait()))
        try:
            stdout, _stderr, returncode = await asyncio.wait_for(asyncio.gather(*reads), timeout=self.command_timeout)
        except asyncio.TimeoutError:
            process.kill()
            await asyncio.gather(process.wait(), *reads, return_exceptions=True)
            raise HomeServerMaintenanceError("ssh_timeout") from None
        except HomeServerMaintenanceError:
            process.kill()
            await asyncio.gather(process.wait(), *reads, return_exceptions=True)
            raise
        if returncode != 0:
            raise HomeServerMaintenanceError(_safe_helper_failure(stdout))
        try:
            payload = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HomeServerMaintenanceError("ssh_invalid_response") from None
        if not isinstance(payload, dict):
            raise HomeServerMaintenanceError("ssh_invalid_response")
        return payload


class HomeServerMaintenanceExecutor:
    def __init__(self, settings: IntegrationSettings, access: AccessPolicyStore, *, transport: HomeServerSshTransport | Any | None = None) -> None:
        self.settings, self.access = settings, access
        self.transport = transport or HomeServerSshTransport(settings)
        self.executions: OrderedDict[str, _Execution] = OrderedDict()
        self.active_request_id: str | None = None
        self._lock: asyncio.Lock | None = None

    def _lock_for_loop(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _gate(self) -> bool:
        return bool(self.settings.writes_enabled and self.settings.home_server_maintenance_enabled)

    async def availability(self) -> dict[str, Any]:
        configured = bool(self.transport.configured())
        services: dict[str, Any] = {}
        reachable = False
        if configured:
            try:
                payload = await self.transport.run("status")
                if payload.get("schemaVersion") == 1 and payload.get("ok") is True and payload.get("operation") == "status" and isinstance(payload.get("services"), dict):
                    services, reachable = _safe_services(payload["services"]), True
            except HomeServerMaintenanceError:
                pass
        actions = {}
        for action in MAINTENANCE_ACTION_IDS:
            decision = self.access.authorize(action, gate_enabled=self._gate(), integration_available=configured and reachable, busy=self.active_request_id is not None)
            actions[action] = {**decision.as_dict(), "gateEnabled": self._gate(), "integrationAvailable": configured and reachable, "busy": self.active_request_id is not None, "preconditionOk": True}
        return {"schemaVersion": 1, "configured": configured, "reachable": reachable, "maintenanceGateEnabled": self.settings.home_server_maintenance_enabled, "busy": self.active_request_id is not None, "services": services, "actions": actions}

    async def submit(self, request: HomeServerMaintenanceRequest) -> tuple[dict[str, Any], bool]:
        request_id = str(request.requestId)
        async with self._lock_for_loop():
            previous = self.executions.get(request_id)
            if previous:
                return previous.public(), False
            availability = await self.availability()
            decision = availability["actions"][request.actionId]
            if not decision["allowed"]:
                code = decision["availability"]
                self.access.audit_capability(request.actionId, result=code, correlation_id=request_id)
                raise HTTPException(status_code=403 if code in {"profile_blocked", "elevation_required"} else 409 if code in {"gate_disabled", "busy"} else 503, detail=code)
            execution = _Execution(request_id, request.actionId)
            self.executions[request_id] = execution
            self.active_request_id = request_id
            while len(self.executions) > 32:
                self.executions.popitem(last=False)
            self.access.audit_capability(request.actionId, result="accepted", correlation_id=request_id)
            asyncio.create_task(self._run(execution))
            return execution.public(), True

    async def _run(self, execution: _Execution) -> None:
        try:
            execution.status = "dispatching"
            operation = _OPERATION_BY_ACTION[execution.action_id]
            payload = await self.transport.run(operation)
            if payload.get("schemaVersion") != 1 or payload.get("ok") is not True or payload.get("operation") != operation or payload.get("status") not in {"success", "up_to_date"}:
                raise HomeServerMaintenanceError("helper_failed")
            execution.status, execution.result = "success", payload["status"]
            self.access.audit_capability(execution.action_id, result=payload["status"], correlation_id=execution.request_id)
        except HomeServerMaintenanceError as error:
            execution.status, execution.failure_code = "failed", error.code
            self.access.audit_capability(execution.action_id, result=error.code, correlation_id=execution.request_id)
        finally:
            if self.active_request_id == execution.request_id:
                self.active_request_id = None

    def operation(self, request_id: str) -> dict[str, Any] | None:
        item = self.executions.get(request_id)
        return item.public() if item else None


def _safe_services(raw: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in ("homeAssistant", "caddy", "bot"):
        value = raw.get(key)
        if not isinstance(value, dict):
            continue
        item: dict[str, Any] = {"running": value.get("running") is True, "healthy": value.get("healthy") if value.get("healthy") in {True, False, None} else None}
        if key == "homeAssistant":
            for name in ("installedVersion", "configuredImage"):
                if isinstance(value.get(name), str) and len(value[name]) <= 160:
                    item[name] = value[name]
        safe[key] = item
    return safe


def build_home_assistant_maintenance_router(executor: HomeServerMaintenanceExecutor) -> APIRouter:
    router = APIRouter(prefix="/api/v1/actions/home-assistant", tags=["home-server-maintenance"])

    @router.get("/maintenance")
    async def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.availability()

    @router.get("/maintenance/{request_id}")
    def operation(request_id: UUID, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        item = executor.operation(str(request_id))
        if item is None:
            raise HTTPException(status_code=404, detail="maintenance_operation_not_found")
        return item

    @router.post("/maintenance", status_code=status.HTTP_202_ACCEPTED)
    async def execute(payload: HomeServerMaintenanceRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        item, accepted = await executor.submit(payload)
        if not accepted:
            response.status_code = status.HTTP_200_OK
        return item

    return router
