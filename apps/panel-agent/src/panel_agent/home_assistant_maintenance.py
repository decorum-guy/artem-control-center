"""Fixed Home Assistant maintenance actions.

This module intentionally does not share the generic device-action executor.
The browser can request only a restart or installation of the one standard Core
update entity; all service paths, entity IDs, versions and backup choices stay
server owned.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from .access_policy import AccessPolicyStore
from .settings import IntegrationSettings


RESTART_ACTION = "system.home_assistant.restart"
UPDATE_CORE_ACTION = "system.home_assistant.update_core"
MaintenanceActionId = Literal[
    "system.home_assistant.restart",
    "system.home_assistant.update_core",
]
MAINTENANCE_ACTION_IDS: tuple[MaintenanceActionId, ...] = (RESTART_ACTION, UPDATE_CORE_ACTION)
CORE_UPDATE_ENTITY = "update.home_assistant_core_update"
_MAX_OPERATIONS = 32
_TERMINAL = frozenset({"success", "failed"})
_SAFE_FAILURES = frozenset({
    "maintenance_disabled", "maintenance_busy", "ha_not_configured",
    "ha_unreachable", "admin_required", "core_update_unavailable",
    "update_not_available", "update_in_progress", "install_unsupported",
    "maintenance_dispatch_failed", "restart_recovery_timeout",
    "update_recovery_timeout", "update_not_applied",
})


class HomeAssistantMaintenanceRequest(BaseModel):
    """The deliberately fieldless maintenance mutation contract."""

    model_config = ConfigDict(extra="forbid", strict=True)

    actionId: MaintenanceActionId
    requestId: UUID


@dataclass
class _Operation:
    request_id: str
    action_id: MaintenanceActionId
    status: str = "requested"
    failure_code: str | None = None
    installed_before: str | None = None
    latest_expected: str | None = None
    backup_created: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "requestId": self.request_id,
            "actionId": self.action_id,
            "status": self.status,
            "failureCode": self.failure_code,
            "backupCreated": self.backup_created,
        }


AdminChecker = Callable[[], Awaitable[bool]]


class HomeAssistantMaintenanceExecutor:
    def __init__(
        self,
        settings: IntegrationSettings,
        access: AccessPolicyStore,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        admin_checker: AdminChecker | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        recovery_timeout: float = 120.0,
        poll_interval: float = 2.0,
    ) -> None:
        self.settings = settings
        self.access = access
        self._transport = transport
        self._admin_checker = admin_checker or self._check_admin_websocket
        self._sleep = sleep
        self._clock = clock
        self._recovery_timeout = recovery_timeout
        self._poll_interval = poll_interval
        self._operations: dict[str, _Operation] = {}
        self._active_request_id: str | None = None
        self._lock: asyncio.Lock | None = None

    @property
    def configured(self) -> bool:
        return bool(self.settings.ha_url and self.settings.ha_token)

    def _operation_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def _check_admin_websocket(self) -> bool:
        """Project only the current user's admin flag, never its identity."""
        if not self.configured:
            return False
        parsed = urlsplit(self.settings.ha_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return False
        ws_url = urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc, "/api/websocket", "", ""))
        try:
            async with websockets.connect(ws_url, open_timeout=5, close_timeout=2) as socket:
                required = await asyncio.wait_for(socket.recv(), timeout=5)
                if not isinstance(required, str) or '"auth_required"' not in required:
                    return False
                await socket.send('{"type":"auth","access_token":' + json.dumps(self.settings.ha_token) + "}")
                authenticated = await asyncio.wait_for(socket.recv(), timeout=5)
                if not isinstance(authenticated, str) or '"auth_ok"' not in authenticated:
                    return False
                await socket.send('{"id":1,"type":"auth/current_user"}')
                raw = await asyncio.wait_for(socket.recv(), timeout=5)
                payload = json.loads(raw)
                result = payload.get("result") if isinstance(payload, dict) else None
                return bool(isinstance(result, dict) and result.get("is_admin") is True)
        except Exception:
            return False

    async def _get(self, path: str) -> dict[str, Any] | None:
        if not self.configured:
            return None
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.ha_url,
                headers={"Authorization": f"Bearer {self.settings.ha_token}"},
                timeout=10,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.get(path)
                response.raise_for_status()
                payload = response.json()
            return payload if isinstance(payload, dict) else None
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def _post(self, path: str, body: dict[str, Any]) -> bool:
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.ha_url,
                headers={"Authorization": f"Bearer {self.settings.ha_token}"},
                timeout=10,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.post(path, json=body)
                response.raise_for_status()
            return True
        except (httpx.HTTPError, ValueError, TypeError):
            # Restart/update can terminate the requesting transport after HA
            # accepted it. Lifecycle verification, not this response, decides
            # success.
            return False

    @staticmethod
    def _core_update(state: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(state, dict):
            return {"present": False, "available": False, "inProgress": False, "installSupported": False, "backupSupported": False, "installedVersion": None, "latestVersion": None}
        attributes = state.get("attributes")
        attributes = attributes if isinstance(attributes, dict) else {}
        supported = attributes.get("supported_features")
        supported = supported if isinstance(supported, int) and not isinstance(supported, bool) else 0
        installed = attributes.get("installed_version")
        latest = attributes.get("latest_version")
        return {
            "present": True,
            "available": state.get("state") == "on",
            "inProgress": attributes.get("in_progress") is True,
            "installSupported": bool(supported & 1),
            "backupSupported": bool(supported & 2),
            "installedVersion": installed if isinstance(installed, str) else None,
            "latestVersion": latest if isinstance(latest, str) else None,
        }

    async def _probe(self) -> tuple[bool, bool, dict[str, Any]]:
        if not self.configured:
            return False, False, self._core_update(None)
        api, admin, state = await asyncio.gather(
            self._get("/api/"), self._admin_checker(), self._get(f"/api/states/{CORE_UPDATE_ENTITY}"),
        )
        return api is not None, bool(admin), self._core_update(state)

    def _decision(self, action_id: MaintenanceActionId, *, reachable: bool, admin: bool, core: dict[str, Any]) -> dict[str, Any]:
        gate = bool(self.settings.writes_enabled and self.settings.ha_maintenance_actions_enabled)
        precondition = True
        if action_id == UPDATE_CORE_ACTION:
            precondition = bool(core["present"] and core["available"] and core["installSupported"] and not core["inProgress"])
        decision = self.access.authorize(
            action_id,
            gate_enabled=gate,
            integration_available=bool(self.configured and reachable and admin),
            busy=self._active_request_id is not None,
            precondition_ok=precondition,
        )
        return {**decision.as_dict(), "gateEnabled": gate, "integrationAvailable": bool(self.configured and reachable and admin), "busy": self._active_request_id is not None, "preconditionOk": precondition}

    async def availability(self) -> dict[str, Any]:
        reachable, admin, core = await self._probe()
        actions = {action: self._decision(action, reachable=reachable, admin=admin, core=core) for action in MAINTENANCE_ACTION_IDS}
        return {
            "schemaVersion": 1,
            "configured": self.configured,
            "reachable": reachable,
            "adminAuthorized": admin,
            "maintenanceGateEnabled": bool(self.settings.ha_maintenance_actions_enabled),
            "busy": self._active_request_id is not None,
            "installedVersion": core["installedVersion"], "latestVersion": core["latestVersion"],
            "entityPresent": core["present"],
            "updateAvailable": core["available"], "updateInProgress": core["inProgress"],
            "installSupported": core["installSupported"], "backupSupported": core["backupSupported"],
            "actions": actions,
        }

    def operation(self, request_id: str) -> dict[str, Any] | None:
        operation = self._operations.get(request_id)
        return operation.public() if operation else None

    async def submit(self, request: HomeAssistantMaintenanceRequest) -> tuple[dict[str, Any], bool]:
        request_id = str(request.requestId)
        async with self._operation_lock():
            existing = self._operations.get(request_id)
            if existing is not None:
                return existing.public(), False
            available = await self.availability()
            decision = available["actions"][request.actionId]
            if not decision["allowed"]:
                detail = decision["availability"]
                if not available["adminAuthorized"] and available["configured"] and available["reachable"]:
                    detail = "admin_required"
                elif request.actionId == UPDATE_CORE_ACTION:
                    core = available
                    detail = "core_update_unavailable" if not core["installSupported"] and not core["updateAvailable"] else "install_unsupported" if not core["installSupported"] else "update_in_progress" if core["updateInProgress"] else "update_not_available" if not core["updateAvailable"] else detail
                if detail not in _SAFE_FAILURES and detail not in {"profile_blocked", "elevation_required", "gate_disabled"}:
                    detail = "maintenance_dispatch_failed"
                self.access.audit_capability(request.actionId, result=detail, correlation_id=request_id)
                code = 403 if detail in {"profile_blocked", "elevation_required", "admin_required"} else 409 if detail in {"gate_disabled", "maintenance_busy", "busy", "precondition_failed"} else 503
                raise HTTPException(status_code=code, detail=detail)
            core = {key: available[key] for key in ("installedVersion", "latestVersion", "backupSupported")}
            operation = _Operation(request_id, request.actionId, installed_before=core["installedVersion"], latest_expected=core["latestVersion"], backup_created=bool(core["backupSupported"]))
            self._operations[request_id] = operation
            self._active_request_id = request_id
            while len(self._operations) > _MAX_OPERATIONS:
                self._operations.pop(next(iter(self._operations)))
            self.access.audit_capability(request.actionId, result="accepted", correlation_id=request_id)
            asyncio.create_task(self._run(operation))
            return operation.public(), True

    async def _run(self, operation: _Operation) -> None:
        try:
            operation.status = "dispatching"
            if operation.action_id == RESTART_ACTION:
                dispatched = await self._post("/api/services/homeassistant/restart", {})
                await self._recover_restart(operation, dispatched)
            else:
                body: dict[str, Any] = {"entity_id": CORE_UPDATE_ENTITY}
                if operation.backup_created:
                    body["backup"] = True
                await self._post("/api/services/update/install", body)
                await self._recover_update(operation)
            operation.status = "success"
            self.access.audit_capability(operation.action_id, result="success", correlation_id=operation.request_id)
        except _MaintenanceFailure as exc:
            operation.status = "failed"
            operation.failure_code = exc.code
            self.access.audit_capability(operation.action_id, result=exc.code, correlation_id=operation.request_id)
        except Exception:
            operation.status = "failed"
            operation.failure_code = "maintenance_dispatch_failed"
            self.access.audit_capability(operation.action_id, result="maintenance_dispatch_failed", correlation_id=operation.request_id)
        finally:
            if self._active_request_id == operation.request_id:
                self._active_request_id = None

    async def _wait_healthy(self, operation: _Operation, timeout_code: str, *, dispatch_confirmed: bool = True) -> dict[str, Any]:
        deadline = self._clock() + self._recovery_timeout
        saw_outage = False
        while self._clock() <= deadline:
            reachable, admin, core = await self._probe()
            if not reachable or not admin:
                saw_outage = True
                operation.status = "waiting_for_disconnect"
            elif saw_outage:
                operation.status = "waiting_for_recovery"
                return core
            else:
                # HA can handle a command without a visible transport outage.
                if not dispatch_confirmed:
                    raise _MaintenanceFailure("maintenance_dispatch_failed")
                return core
            await self._sleep(self._poll_interval)
        raise _MaintenanceFailure(timeout_code)

    async def _recover_restart(self, operation: _Operation, dispatch_confirmed: bool) -> None:
        operation.status = "waiting_for_recovery"
        await self._wait_healthy(operation, "restart_recovery_timeout", dispatch_confirmed=dispatch_confirmed)
        operation.status = "verifying"

    async def _recover_update(self, operation: _Operation) -> None:
        operation.status = "waiting_for_recovery"
        core = await self._wait_healthy(operation, "update_recovery_timeout")
        operation.status = "verifying"
        if core["inProgress"]:
            deadline = self._clock() + self._recovery_timeout
            while self._clock() <= deadline:
                await self._sleep(self._poll_interval)
                reachable, admin, core = await self._probe()
                if reachable and admin and not core["inProgress"]:
                    break
            else:
                raise _MaintenanceFailure("update_recovery_timeout")
        if not operation.latest_expected or core["installedVersion"] != operation.latest_expected:
            raise _MaintenanceFailure("update_not_applied")


class _MaintenanceFailure(Exception):
    def __init__(self, code: str) -> None:
        self.code = code if code in _SAFE_FAILURES else "maintenance_dispatch_failed"


def build_home_assistant_maintenance_router(executor: HomeAssistantMaintenanceExecutor) -> APIRouter:
    router = APIRouter(prefix="/api/v1/actions/home-assistant", tags=["home-assistant-maintenance"])

    @router.get("/maintenance")
    async def maintenance_availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.availability()

    @router.get("/maintenance/{request_id}")
    def maintenance_operation(request_id: UUID, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        operation = executor.operation(str(request_id))
        if operation is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="maintenance_operation_not_found")
        return operation

    @router.post("/maintenance", status_code=status.HTTP_202_ACCEPTED)
    async def maintenance_execute(payload: HomeAssistantMaintenanceRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        operation, accepted = await executor.submit(payload)
        if not accepted:
            response.status_code = status.HTTP_200_OK
        return operation

    return router
