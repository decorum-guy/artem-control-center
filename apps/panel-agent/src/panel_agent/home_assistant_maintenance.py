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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

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
    "restart_recovery_timeout", "update_recovery_timeout", "update_failed", "update_not_applied",
    "maintenance_disabled", "release_feed_unavailable",
})
_STABLE_IMAGE = "ghcr.io/home-assistant/home-assistant:stable"
_STABLE_VERSION = re.compile(r"[0-9]{4}\.(?:[1-9]|1[0-2])\.[0-9]{1,4}")
_STABLE_FEEDS = (
    "https://version.home-assistant.io/stable.json",
    "https://raw.githubusercontent.com/home-assistant/version/master/stable.json",
)
_HOST_PATTERN = re.compile(r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$")
_USER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class HomeServerMaintenanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    actionId: MaintenanceActionId
    requestId: UUID = Field(strict=False)


class HomeServerMaintenanceError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code if code in _SAFE_FAILURES else "helper_failed"
        super().__init__(self.code)


async def _read_stable_version() -> str:
    async with httpx.AsyncClient(timeout=5, headers={"User-Agent": "Artem-Control-Center/1.0", "Accept": "application/json"}) as client:
        for url in _STABLE_FEEDS:
            try:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    source = bytearray()
                    async for chunk in response.aiter_bytes(4096):
                        source.extend(chunk)
                        if len(source) > 32_768:
                            raise ValueError("release feed exceeds size limit")
                data = json.loads(source)
                if not isinstance(data, dict) or data.get("channel") != "stable":
                    continue
                core = data.get("homeassistant")
                version = core.get("default") if isinstance(core, dict) else None
                if isinstance(version, str) and _STABLE_VERSION.fullmatch(version):
                    return version
            except (httpx.HTTPError, ValueError):
                continue
    raise HomeServerMaintenanceError("release_feed_unavailable")


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


async def _terminal_status(stream: asyncio.StreamReader, operation: str, limit: int) -> int | None:
    # Compose can print progress for many image layers. Diagnostics are drained
    # one line at a time. Only the helper's exit record is interpreted.
    remaining = max(limit, 4 * 1024 * 1024) if operation == "update-ha" else limit
    while line := await stream.readline():
        remaining -= len(line)
        if remaining < 0:
            raise HomeServerMaintenanceError("ssh_output_too_large")
        if line.startswith(b"__ARTEM_HOME_RESULT__"):
            parts = line.split()
            if (len(parts) != 3 or parts[0] != b"__ARTEM_HOME_RESULT__" or parts[1] != operation.encode()
                    or not re.fullmatch(rb"[0-9]{1,3}", parts[2]) or int(parts[2]) > 255 or not line.endswith(b"\n")):
                raise HomeServerMaintenanceError("ssh_invalid_response")
            return int(parts[2])
    return None


async def _read_ssh_result(process, operation: str, limit: int) -> tuple[bytes, int]:
    # The old helper relies on EOF and the SSH exit code. A newer host can
    # attest completion before the Windows SSH process releases its pipes.
    readers = [asyncio.create_task(process.stdout.readline()),
               asyncio.create_task(_terminal_status(process.stderr, operation, limit))]
    try:
        stdout, code = await asyncio.gather(*readers)
        if len(stdout) > limit:
            raise HomeServerMaintenanceError("ssh_output_too_large")
        if code is None:
            stdout += await _read_limited(process.stdout, limit - len(stdout))
            code = await process.wait()
        return stdout, code
    except (ValueError, asyncio.LimitOverrunError):
        raise HomeServerMaintenanceError("ssh_output_too_large") from None
    finally:
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)


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
            process = await asyncio.create_subprocess_exec(*self.argv(executable, operation), stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=self.output_limit + 1)
        except FileNotFoundError:
            raise HomeServerMaintenanceError("ssh_client_unavailable") from None
        except (OSError, ValueError):
            raise HomeServerMaintenanceError("ssh_transport_failed") from None
        try:
            timeout = min(20, self.command_timeout) if operation == "status" else self.command_timeout
            stdout, returncode = await asyncio.wait_for(_read_ssh_result(process, operation, self.output_limit), timeout)
        except asyncio.TimeoutError:
            raise HomeServerMaintenanceError("ssh_timeout") from None
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
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
    def __init__(self, settings: IntegrationSettings, access: AccessPolicyStore, *, transport: HomeServerSshTransport | Any | None = None, stable_version: Callable[[], Awaitable[str]] = _read_stable_version) -> None:
        self.settings, self.access = settings, access
        self.transport = transport or HomeServerSshTransport(settings)
        self.stable_version = stable_version
        self.executions: OrderedDict[str, _Execution] = OrderedDict()
        self.active_request_id: str | None = None
        self._lock: asyncio.Lock | None = None

    def _lock_for_loop(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _gate(self) -> bool:
        return bool(self.settings.writes_enabled and self.settings.home_server_maintenance_enabled)

    async def _services(self) -> dict[str, Any]:
        payload = await self.transport.run("status")
        if payload.get("schemaVersion") != 1 or payload.get("ok") is not True or payload.get("operation") != "status" or not isinstance(payload.get("services"), dict):
            raise HomeServerMaintenanceError("ssh_invalid_response")
        return _safe_services(payload["services"])

    async def check_update(self) -> dict[str, Any]:
        if not self.transport.configured():
            raise HTTPException(503, detail="home_server_not_configured")
        try:
            ha = (await self._services()).get("homeAssistant", {})
            installed = ha.get("installedVersion") or ""
            if not ha.get("running"):
                raise HTTPException(503, detail="installed_version_unknown")
            if ha.get("configuredImage") != _STABLE_IMAGE:
                raise HTTPException(409, detail="unsupported_release_channel")
            if not _STABLE_VERSION.fullmatch(installed):
                raise HTTPException(503, detail="installed_version_unknown")
            latest = await self.stable_version()
        except HomeServerMaintenanceError as error:
            raise HTTPException(503, detail=error.code) from None
        current_parts = tuple(map(int, installed.split(".")))
        latest_parts = tuple(map(int, latest.split(".")))
        comparison = "up_to_date"
        if latest_parts > current_parts:
            comparison = "available"
        elif latest_parts < current_parts:
            comparison = "ahead"
        return {"installedVersion": installed, "latestVersion": latest, "state": comparison,
                "checkedAt": datetime.now(timezone.utc).isoformat()}

    async def availability(self) -> dict[str, Any]:
        configured = bool(self.transport.configured())
        services: dict[str, Any] = {}
        reachable = False
        reason = None if configured else "home_server_not_configured"
        if configured:
            try:
                services, reachable = await self._services(), True
            except HomeServerMaintenanceError as error:
                reason = error.code
        actions = {}
        for action in MAINTENANCE_ACTION_IDS:
            gate = self._gate() and (action != RESTART_CADDY_ACTION or self.settings.home_server_caddy_restart_enabled)
            decision = self.access.authorize(action, gate_enabled=gate, integration_available=configured and reachable, busy=self.active_request_id is not None)
            actions[action] = {**decision.as_dict(), "gateEnabled": gate, "integrationAvailable": configured and reachable, "busy": self.active_request_id is not None, "preconditionOk": True}
        active = self.executions.get(self.active_request_id) if self.active_request_id else None
        return {"schemaVersion": 1, "configured": configured, "reachable": reachable, "statusReason": reason,
                "maintenanceGateEnabled": self.settings.home_server_maintenance_enabled, "busy": active is not None,
                "activeOperation": active.public() if active else None, "services": services, "actions": actions}

    async def submit(self, request: HomeServerMaintenanceRequest) -> tuple[dict[str, Any], bool]:
        request_id = str(request.requestId)
        async with self._lock_for_loop():
            previous = self.executions.get(request_id)
            if previous:
                if previous.action_id != request.actionId:
                    raise HTTPException(409, detail="request_id_conflict")
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

    @router.get("/maintenance/update-check")
    async def check_update(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.check_update()

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
