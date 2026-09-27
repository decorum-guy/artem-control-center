"""Typed Control Center dispatch to AliceTG_Bot's canonical Station service."""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict

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

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return executor.availability()

    @router.post("")
    async def execute(payload: StationActionRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.execute(payload)

    return router
