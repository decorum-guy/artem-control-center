"""Typed Control Center dispatch to AliceTG_Bot's canonical Station service."""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Response, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore
from .settings import IntegrationSettings

StationActionId = Literal[
    "media.alice.play", "media.alice.pause", "media.alice.volume_down",
    "media.alice.volume_up", "media.alice.previous", "media.alice.next", "media.alice.like",
]
ACTION_NAMES: dict[StationActionId, str] = {
    "media.alice.play": "play",
    "media.alice.pause": "pause",
    "media.alice.volume_down": "volume_down",
    "media.alice.volume_up": "volume_up",
    "media.alice.previous": "previous",
    "media.alice.next": "next",
    "media.alice.like": "like",
}


class StationActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actionId: StationActionId
    requestId: UUID


class PresetExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presetId: str = Field(pattern=r"^[0-9a-f]{12}$")
    requestId: UUID


class PresetCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedRevision: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=32)
    command: str = Field(min_length=1, max_length=160)


class PresetDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedRevision: str = Field(min_length=1, max_length=64)


class StationActionExecutor:
    def __init__(self, settings: IntegrationSettings, access: AccessPolicyStore,
                 alice_available: Callable[[], bool], *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.access = access
        self.alice_available = alice_available
        self.transport = transport
        self._lock: asyncio.Lock | None = None

    def _busy(self) -> bool:
        return bool(self._lock and self._lock.locked())

    def _integration_available(self) -> bool:
        return bool(self.settings.alice_base_url and self.settings.alice_control_center_token
                    and self.alice_available())

    def availability(self) -> dict[str, Any]:
        enabled = self.settings.writes_enabled and self.settings.alice_station_actions_enabled
        available = self._integration_available()
        busy = self._busy()
        return {"schemaVersion": 1, "actions": {
            action_id: {
                **self.access.authorize(action_id, gate_enabled=enabled,
                                        integration_available=available, busy=busy).as_dict(),
                "gateEnabled": enabled, "integrationAvailable": available, "busy": busy,
            } for action_id in ACTION_NAMES
        }}

    def _require_preset(self, capability: str, *, busy: bool = False) -> None:
        self.access.require(capability,
                            gate_enabled=self.settings.writes_enabled and self.settings.alice_station_actions_enabled,
                            integration_available=self._integration_available(), busy=busy and self._busy())

    async def _preset_call(self, method: str, path: str, *, body: dict[str, Any] | None = None,
                           execution: bool = False) -> tuple[int, dict[str, Any]]:
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.alice_base_url,
                headers={"Authorization": f"Bearer {self.settings.alice_control_center_token}"},
                timeout=self.settings.http_request_timeout_seconds,
                transport=self.transport,
            ) as client:
                response = await client.request(method, path, json=body)
        except (httpx.HTTPError, TimeoutError):
            raise HTTPException(status_code=503, detail="station_dispatch_uncertain" if execution else "station_presets_unavailable") from None
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if not isinstance(payload, dict):
            raise HTTPException(status_code=502, detail="station_invalid_response")
        return response.status_code, payload

    async def presets(self) -> dict[str, Any]:
        if not self._integration_available():
            raise HTTPException(status_code=503, detail="alice_unavailable")
        status, payload = await self._preset_call("GET", "/internal/control-center/station/presets")
        return self._validated_inventory(status, payload)

    @staticmethod
    def _validated_inventory(status: int, payload: dict[str, Any]) -> dict[str, Any]:
        if status != 200:
            raise HTTPException(status_code=502, detail="station_presets_unavailable")
        if (payload.get("schemaVersion") != 1 or not isinstance(payload.get("revision"), str)
                or not isinstance(payload.get("updatedAt"), str)
                or not isinstance(payload.get("presets"), list)
                or len(payload["presets"]) > 20
                or any(not isinstance(item, dict) or set(item) != {"id", "title"}
                       or not isinstance(item["id"], str) or not isinstance(item["title"], str)
                       for item in payload["presets"])):
            raise HTTPException(status_code=502, detail="station_invalid_response")
        return {"schemaVersion": 1, "revision": payload["revision"],
                "updatedAt": payload["updatedAt"], "presets": payload["presets"]}

    async def mutate_preset(self, method: str, preset_id: str | None,
                            body: dict[str, Any]) -> dict[str, Any]:
        self._require_preset("settings.station_presets.manage")
        path = "/internal/control-center/station/presets"
        if preset_id:
            path += f"/{preset_id}"
        status, payload = await self._preset_call(method, path, body=body)
        if status == 409:
            raise HTTPException(status_code=409, detail="station_presets_revision_conflict")
        if status == 404:
            raise HTTPException(status_code=404, detail="unknown_station_preset")
        if status == 400:
            raise HTTPException(status_code=400, detail="invalid_station_preset")
        return self._validated_inventory(status, payload)

    async def execute_preset(self, request: PresetExecutionRequest) -> dict[str, Any]:
        capability = "media.alice.preset.execute"
        correlation = str(request.requestId)
        self._require_preset(capability, busy=True)
        if self._lock is None:
            self._lock = asyncio.Lock()
        if self._lock.locked():
            raise HTTPException(status_code=409, detail="station_action_busy")
        async with self._lock:
            if not self._integration_available():
                raise HTTPException(status_code=503, detail="alice_unavailable")
            status, payload = await self._preset_call(
                "POST", f"/internal/control-center/station/presets/{request.presetId}/execute",
                body={"requestId": correlation}, execution=True)
            if status == 404:
                raise HTTPException(status_code=404, detail="unknown_station_preset")
            if status == 202:
                raise HTTPException(status_code=503, detail="station_dispatch_uncertain")
            if (status != 200 or payload.get("schemaVersion") != 1
                    or payload.get("presetId") != request.presetId
                    or payload.get("requestId") != correlation or payload.get("status") != "dispatched"):
                raise HTTPException(status_code=502, detail="station_dispatch_failed")
        self.access.audit_capability(capability, result="success", correlation_id=correlation)
        return {"schemaVersion": 1, "presetId": request.presetId,
                "requestId": correlation, "status": "dispatched"}

    async def execute(self, request: StationActionRequest) -> dict[str, Any]:
        action_id = request.actionId
        correlation = str(request.requestId)
        try:
            self.access.require(action_id,
                                gate_enabled=self.settings.writes_enabled and self.settings.alice_station_actions_enabled,
                                integration_available=self._integration_available(), busy=self._busy())
        except HTTPException as exc:
            self.access.audit_capability(action_id, result=str(exc.detail), correlation_id=correlation)
            raise
        if self._lock is None:
            self._lock = asyncio.Lock()
        if self._lock.locked():
            self.access.audit_capability(action_id, result="busy", correlation_id=correlation)
            raise HTTPException(status_code=409, detail="station_action_busy")
        self.access.audit_capability(action_id, result="accepted", correlation_id=correlation)
        async with self._lock:
            if not self._integration_available():
                self.access.audit_capability(action_id, result="alice_unavailable", correlation_id=correlation)
                raise HTTPException(status_code=503, detail="alice_unavailable")
            try:
                async with httpx.AsyncClient(
                    base_url=self.settings.alice_base_url,
                    headers={"Authorization": f"Bearer {self.settings.alice_control_center_token}"},
                    timeout=self.settings.http_request_timeout_seconds,
                    transport=self.transport,
                ) as client:
                    response = await client.post(
                        "/internal/control-center/station/action",
                        json={"action": ACTION_NAMES[action_id], "requestId": correlation},
                    )
            except (httpx.HTTPError, TimeoutError):
                self.access.audit_capability(action_id, result="dispatch_uncertain", correlation_id=correlation)
                raise HTTPException(status_code=503, detail="station_dispatch_uncertain") from None
            if response.status_code == 202:
                self.access.audit_capability(action_id, result="dispatch_uncertain", correlation_id=correlation)
                raise HTTPException(status_code=503, detail="station_dispatch_uncertain")
            if response.status_code != 200:
                self.access.audit_capability(action_id, result="dispatch_failed", correlation_id=correlation)
                raise HTTPException(status_code=502, detail="station_dispatch_failed")
            try:
                body = response.json()
            except ValueError:
                body = None
            if (not isinstance(body, dict) or body.get("schemaVersion") != 1
                    or body.get("status") != "dispatched"
                    or body.get("action") != ACTION_NAMES[action_id]
                    or body.get("requestId") != correlation):
                self.access.audit_capability(action_id, result="invalid_response", correlation_id=correlation)
                raise HTTPException(status_code=502, detail="station_invalid_response")
        self.access.audit_capability(action_id, result="success", correlation_id=correlation)
        return {"schemaVersion": 1, "actionId": action_id, "requestId": correlation, "status": "dispatched"}


def build_station_action_router(executor: StationActionExecutor) -> APIRouter:
    router = APIRouter(prefix="/api/v1/actions/station", tags=["station-actions"])

    def require_json(request: Request) -> None:
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise HTTPException(status_code=415, detail="invalid_content_type")

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return executor.availability()

    @router.post("")
    async def execute(payload: StationActionRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.execute(payload)

    @router.get("/presets")
    async def presets(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.presets()

    @router.post("/presets/execute")
    async def execute_preset(payload: PresetExecutionRequest, response: Response, request: Request) -> dict[str, Any]:
        require_json(request)
        response.headers["Cache-Control"] = "no-store"
        return await executor.execute_preset(payload)

    @router.post("/presets")
    async def add_preset(payload: PresetCreateRequest, response: Response, request: Request) -> dict[str, Any]:
        require_json(request)
        response.headers["Cache-Control"] = "no-store"
        return await executor.mutate_preset("POST", None, payload.model_dump())

    @router.delete("/presets/{preset_id}")
    async def delete_preset(payload: PresetDeleteRequest, response: Response, request: Request,
                            preset_id: str = Path(pattern=r"^[0-9a-f]{12}$")) -> dict[str, Any]:
        require_json(request)
        response.headers["Cache-Control"] = "no-store"
        return await executor.mutate_preset("DELETE", preset_id, payload.model_dump())

    return router
