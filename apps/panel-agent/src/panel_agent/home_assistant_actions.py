from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, StrictInt, model_validator

from .access_policy import AccessPolicyStore
from .home_assistant import (
    CLIMATE_ENTITY,
    CLIMATE_HVAC_MODES,
    PSU_1_ENTITY,
    PSU_2_ENTITY,
    HomeAssistantAdapter,
)
from .settings import IntegrationSettings


ClimateActionId = Literal[
    "home.climate.power_on",
    "home.climate.power_off",
    "home.climate.set_temperature",
    "home.climate.set_mode",
    "home.climate.set_fan_mode",
]
PsuActionId = Literal[
    "system.rog_g703.psu.mode.normal",
    "system.rog_g703.psu.mode.full",
    "system.rog_g703.psu.bp1.on",
    "system.rog_g703.psu.bp1.off",
    "system.rog_g703.psu.bp2.on",
    "system.rog_g703.psu.bp2.off",
]
HomeAssistantActionId = Literal[
    "home.climate.power_on",
    "home.climate.power_off",
    "home.climate.set_temperature",
    "home.climate.set_mode",
    "home.climate.set_fan_mode",
    "system.rog_g703.psu.mode.normal",
    "system.rog_g703.psu.mode.full",
    "system.rog_g703.psu.bp1.on",
    "system.rog_g703.psu.bp1.off",
    "system.rog_g703.psu.bp2.on",
    "system.rog_g703.psu.bp2.off",
]

ALL_ACTION_IDS: tuple[str, ...] = (
    "home.climate.power_on",
    "home.climate.power_off",
    "home.climate.set_temperature",
    "home.climate.set_mode",
    "home.climate.set_fan_mode",
    "system.rog_g703.psu.mode.normal",
    "system.rog_g703.psu.mode.full",
    "system.rog_g703.psu.bp1.on",
    "system.rog_g703.psu.bp1.off",
    "system.rog_g703.psu.bp2.on",
    "system.rog_g703.psu.bp2.off",
)
CLIMATE_ACTION_IDS = frozenset(ALL_ACTION_IDS[:5])
PSU_ACTION_IDS = frozenset(ALL_ACTION_IDS[5:])
CLIMATE_ON_STATES = frozenset({"cool", "heat", "fan_only", "dry", "auto"})
NO_VALUE_ACTIONS = frozenset(
    {
        "home.climate.power_on",
        "home.climate.power_off",
        *PSU_ACTION_IDS,
    }
)


class HomeAssistantActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actionId: Literal[
        "home.climate.power_on",
        "home.climate.power_off",
        "home.climate.set_temperature",
        "home.climate.set_mode",
        "home.climate.set_fan_mode",
        "system.rog_g703.psu.mode.normal",
        "system.rog_g703.psu.mode.full",
        "system.rog_g703.psu.bp1.on",
        "system.rog_g703.psu.bp1.off",
        "system.rog_g703.psu.bp2.on",
        "system.rog_g703.psu.bp2.off",
    ]
    requestId: UUID
    temperature: StrictInt | None = None
    mode: Literal["cool", "heat", "fan_only", "dry", "auto", "off"] | None = None
    fanMode: Literal["one", "two", "three", "four", "five"] | None = None

    @model_validator(mode="after")
    def validate_action_shape(self) -> "HomeAssistantActionRequest":
        values = (self.temperature, self.mode, self.fanMode)
        if self.actionId in NO_VALUE_ACTIONS:
            if any(value is not None for value in values):
                raise ValueError("action does not accept a value")
        elif self.actionId == "home.climate.set_temperature":
            if self.temperature is None or self.mode is not None or self.fanMode is not None:
                raise ValueError("temperature action requires only temperature")
            if not 16 <= self.temperature <= 32:
                raise ValueError("temperature must be between 16 and 32")
        elif self.actionId == "home.climate.set_mode":
            if self.mode is None or self.temperature is not None or self.fanMode is not None:
                raise ValueError("mode action requires only mode")
        elif self.actionId == "home.climate.set_fan_mode":
            if self.fanMode is None or self.temperature is not None or self.mode is not None:
                raise ValueError("fan mode action requires only fanMode")
        return self


class HomeAssistantActionError(Exception):
    def __init__(self, code: str, http_status: int) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status


class HomeAssistantActionExecutor:
    """Owns the fixed, typed Home Assistant mutations for this product slice."""

    def __init__(
        self,
        settings: IntegrationSettings,
        access: AccessPolicyStore,
        home_assistant: HomeAssistantAdapter,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        verification_interval: float = 0.25,
        verification_timeout: float = 5.0,
    ) -> None:
        self.settings = settings
        self.access = access
        self.home_assistant = home_assistant
        self._transport = transport
        self._sleep = sleep
        self._clock = clock
        self._verification_interval = verification_interval
        self._verification_timeout = verification_timeout
        # Python 3.9 binds asyncio.Lock to the current loop at construction;
        # create each independent lock lazily on the first async request so
        # production import and synchronous availability reads remain safe.
        self._climate_lock: asyncio.Lock | None = None
        self._psu_lock: asyncio.Lock | None = None

    def _gate_enabled(self, action_id: str) -> bool:
        if action_id in CLIMATE_ACTION_IDS:
            return bool(
                self.settings.writes_enabled
                and self.settings.home_climate_actions_enabled
            )
        return bool(
            self.settings.writes_enabled
            and self.settings.rog_g703_psu_actions_enabled
        )

    def _lock_for(self, action_id: str) -> asyncio.Lock:
        if action_id in CLIMATE_ACTION_IDS:
            if self._climate_lock is None:
                self._climate_lock = asyncio.Lock()
            return self._climate_lock
        if self._psu_lock is None:
            self._psu_lock = asyncio.Lock()
        return self._psu_lock

    def _busy_for(self, action_id: str) -> bool:
        lock = self._climate_lock if action_id in CLIMATE_ACTION_IDS else self._psu_lock
        return bool(lock and lock.locked())

    def _integration_available(self, action_id: str) -> bool:
        if not self.home_assistant.mutation_transport_available():
            return False
        if action_id in CLIMATE_ACTION_IDS:
            return self.home_assistant.mutation_entity_current(CLIMATE_ENTITY)
        if action_id.endswith(".bp1.on") or action_id.endswith(".bp1.off"):
            return self.home_assistant.mutation_entity_current(PSU_1_ENTITY)
        if action_id.endswith(".bp2.on") or action_id.endswith(".bp2.off"):
            return self.home_assistant.mutation_entity_current(PSU_2_ENTITY)
        return (
            self.home_assistant.mutation_entity_current(PSU_1_ENTITY)
            and self.home_assistant.mutation_entity_current(PSU_2_ENTITY)
        )

    def _precondition_ok(self, action_id: str) -> bool:
        if action_id == "system.rog_g703.psu.bp1.off":
            return self.home_assistant.mutation_entity_state(PSU_2_ENTITY) == "on"
        if action_id == "system.rog_g703.psu.bp2.off":
            return self.home_assistant.mutation_entity_state(PSU_1_ENTITY) == "on"
        return True

    def availability(self) -> dict[str, Any]:
        actions: dict[str, Any] = {}
        for action_id in ALL_ACTION_IDS:
            integration_available = self._integration_available(action_id)
            precondition_ok = self._precondition_ok(action_id)
            decision = self.access.authorize(
                action_id,
                gate_enabled=self._gate_enabled(action_id),
                integration_available=integration_available,
                busy=self._busy_for(action_id),
                precondition_ok=precondition_ok,
            )
            actions[action_id] = {
                **decision.as_dict(),
                "gateEnabled": self._gate_enabled(action_id),
                "integrationAvailable": integration_available,
                "busy": self._busy_for(action_id),
                "preconditionOk": precondition_ok,
            }
        return {"schemaVersion": 1, "actions": actions}

    def _require(self, action_id: str, *, integration_available: bool) -> None:
        try:
            self.access.require(
                action_id,
                gate_enabled=self._gate_enabled(action_id),
                integration_available=integration_available,
                # A queued request must re-read inside the lock instead of
                # treating advisory availability as a stale safety decision.
                precondition_ok=True,
            )
        except HTTPException as exc:
            detail = str(exc.detail)
            mapped = {
                "gate_disabled": "ha_action_disabled",
                "integration_unavailable": "ha_integration_unavailable",
                "busy": "ha_action_busy",
            }.get(detail, detail)
            if mapped != detail:
                raise HTTPException(status_code=exc.status_code, detail=mapped) from None
            raise

    async def execute(self, request: HomeAssistantActionRequest) -> dict[str, Any]:
        action_id = request.actionId
        accepted = False
        try:
            self._require(
                action_id,
                integration_available=self._integration_available(action_id),
            )
            self.access.audit_capability(
                action_id,
                result="accepted",
                correlation_id=str(request.requestId),
            )
            accepted = True
            async with self._lock_for(action_id):
                # The lock is deliberately queued. The fresh read below makes
                # a duplicate request idempotent after an earlier request wins.
                if not self.home_assistant.mutation_transport_available():
                    raise HomeAssistantActionError("ha_integration_unavailable", 503)
                result = await self._execute_locked(request)
            self.access.audit_capability(
                action_id,
                result="success",
                correlation_id=str(request.requestId),
            )
            return result
        except HomeAssistantActionError as exc:
            if accepted:
                self.access.audit_capability(
                    action_id,
                    result=exc.code,
                    correlation_id=str(request.requestId),
                )
            raise HTTPException(status_code=exc.http_status, detail=exc.code) from None
        except HTTPException as exc:
            self.access.audit_capability(
                action_id,
                result=str(exc.detail),
                correlation_id=str(request.requestId),
            )
            raise
        except Exception:
            if accepted:
                self.access.audit_capability(
                    action_id,
                    result="ha_integration_unavailable",
                    correlation_id=str(request.requestId),
                )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ha_integration_unavailable",
            ) from None

    async def _execute_locked(self, request: HomeAssistantActionRequest) -> dict[str, Any]:
        if request.actionId in CLIMATE_ACTION_IDS:
            return await self._execute_climate(request)
        return await self._execute_psu(request)

    async def _fresh(self, entity_id: str) -> dict[str, Any]:
        try:
            state = await self.home_assistant.fetch_entity(entity_id)
        except httpx.HTTPStatusError as exc:
            code = "ha_entity_unavailable" if exc.response.status_code == 404 else "ha_integration_unavailable"
            raise HomeAssistantActionError(code, 503) from None
        except (httpx.HTTPError, ValueError, TypeError):
            raise HomeAssistantActionError("ha_integration_unavailable", 503) from None
        if not isinstance(state, dict):
            raise HomeAssistantActionError("ha_entity_unavailable", 503)
        return state

    async def _call_service(self, path: str, body: dict[str, Any]) -> None:
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
        except (httpx.HTTPError, ValueError, TypeError):
            raise HomeAssistantActionError("ha_service_failed", 502) from None

    async def _verify(
        self,
        entity_id: str,
        predicate: Callable[[dict[str, Any]], bool],
    ) -> dict[str, Any]:
        deadline = self._clock() + self._verification_timeout
        while True:
            state = await self._fresh(entity_id)
            if predicate(state):
                return state
            if self._clock() >= deadline:
                raise HomeAssistantActionError("ha_verification_timeout", 504)
            await self._sleep(self._verification_interval)

    async def _execute_climate(self, request: HomeAssistantActionRequest) -> dict[str, Any]:
        current = await self._fresh(CLIMATE_ENTITY)
        current_state = current.get("state")
        if current_state not in set(CLIMATE_HVAC_MODES):
            raise HomeAssistantActionError("ha_invalid_state", 409)

        if request.actionId == "home.climate.power_on":
            if current_state in CLIMATE_ON_STATES:
                return self._climate_result(request.requestId, request.actionId, current)
            await self._call_service(
                "/api/services/climate/turn_on",
                {"entity_id": CLIMATE_ENTITY},
            )
            confirmed = await self._verify(
                CLIMATE_ENTITY,
                lambda state: state.get("state") in CLIMATE_ON_STATES,
            )
        elif request.actionId == "home.climate.power_off":
            if current_state == "off":
                return self._climate_result(request.requestId, request.actionId, current)
            await self._call_service(
                "/api/services/climate/turn_off",
                {"entity_id": CLIMATE_ENTITY},
            )
            confirmed = await self._verify(
                CLIMATE_ENTITY,
                lambda state: state.get("state") == "off",
            )
        elif request.actionId == "home.climate.set_temperature":
            assert request.temperature is not None
            await self._call_service(
                "/api/services/climate/set_temperature",
                {"entity_id": CLIMATE_ENTITY, "temperature": request.temperature},
            )
            confirmed = await self._verify(
                CLIMATE_ENTITY,
                lambda state: state.get("attributes", {}).get("temperature")
                == request.temperature,
            )
        elif request.actionId == "home.climate.set_mode":
            assert request.mode is not None
            if request.mode == "off":
                await self._call_service(
                    "/api/services/climate/turn_off",
                    {"entity_id": CLIMATE_ENTITY},
                )
                confirmed = await self._verify(
                    CLIMATE_ENTITY,
                    lambda state: state.get("state") == "off",
                )
            else:
                await self._call_service(
                    "/api/services/climate/set_hvac_mode",
                    {"entity_id": CLIMATE_ENTITY, "hvac_mode": request.mode},
                )
                confirmed = await self._verify(
                    CLIMATE_ENTITY,
                    lambda state: state.get("state") == request.mode,
                )
        else:
            assert request.fanMode is not None
            await self._call_service(
                "/api/services/climate/set_fan_mode",
                {"entity_id": CLIMATE_ENTITY, "fan_mode": request.fanMode},
            )
            confirmed = await self._verify(
                CLIMATE_ENTITY,
                lambda state: state.get("attributes", {}).get("fan_mode")
                == request.fanMode,
            )
        return self._climate_result(request.requestId, request.actionId, confirmed)

    async def _fresh_psu_pair(
        self,
        *,
        require_known: bool = True,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        first = await self._fresh(PSU_1_ENTITY)
        second = await self._fresh(PSU_2_ENTITY)
        if require_known and (
            first.get("state") not in {"on", "off"}
            or second.get("state") not in {"on", "off"}
        ):
            raise HomeAssistantActionError("ha_entity_unavailable", 503)
        return first, second

    async def _verify_psu(self, entity_id: str, expected: str) -> dict[str, Any]:
        return await self._verify(
            entity_id,
            lambda state: state.get("state") == expected,
        )

    async def _switch(self, entity_id: str, service: Literal["on", "off"]) -> None:
        await self._call_service(
            f"/api/services/switch/turn_{service}",
            {"entity_id": entity_id},
        )

    async def _execute_psu(self, request: HomeAssistantActionRequest) -> dict[str, Any]:
        first = await self._fresh(PSU_1_ENTITY)
        second = await self._fresh(PSU_2_ENTITY)
        bp1 = first.get("state")
        bp2 = second.get("state")
        individual_action = request.actionId in {
            "system.rog_g703.psu.bp1.on",
            "system.rog_g703.psu.bp1.off",
            "system.rog_g703.psu.bp2.on",
            "system.rog_g703.psu.bp2.off",
        }
        if individual_action:
            target_state = bp1 if ".bp1." in request.actionId else bp2
            if target_state not in {"on", "off"}:
                raise HomeAssistantActionError("ha_entity_unavailable", 503)
        if not individual_action and (
            bp1 not in {"on", "off"} or bp2 not in {"on", "off"}
        ):
            raise HomeAssistantActionError("ha_entity_unavailable", 503)

        if request.actionId == "system.rog_g703.psu.mode.full":
            if bp1 == "off":
                await self._switch(PSU_1_ENTITY, "on")
                await self._verify_psu(PSU_1_ENTITY, "on")
            if bp2 == "off":
                await self._switch(PSU_2_ENTITY, "on")
                await self._verify_psu(PSU_2_ENTITY, "on")
        elif request.actionId == "system.rog_g703.psu.mode.normal":
            if bp1 != "on":
                await self._switch(PSU_1_ENTITY, "on")
                await self._verify_psu(PSU_1_ENTITY, "on")
            # Never turn BP2 off until the preferred BP1 has been freshly
            # confirmed on, including when BP1 started off.
            second = await self._fresh(PSU_2_ENTITY)
            if second.get("state") == "on":
                await self._switch(PSU_2_ENTITY, "off")
                await self._verify_psu(PSU_2_ENTITY, "off")
        elif request.actionId.endswith(".bp1.on"):
            if bp1 == "off":
                await self._switch(PSU_1_ENTITY, "on")
                await self._verify_psu(PSU_1_ENTITY, "on")
        elif request.actionId.endswith(".bp2.on"):
            if bp2 == "off":
                await self._switch(PSU_2_ENTITY, "on")
                await self._verify_psu(PSU_2_ENTITY, "on")
        elif request.actionId.endswith(".bp1.off"):
            if bp1 not in {"on", "off"}:
                raise HomeAssistantActionError("ha_entity_unavailable", 503)
            if bp1 == "on":
                if bp2 != "on":
                    raise HomeAssistantActionError("last_psu_off_blocked", 409)
                await self._switch(PSU_1_ENTITY, "off")
                await self._verify_psu(PSU_1_ENTITY, "off")
        elif request.actionId.endswith(".bp2.off"):
            if bp2 not in {"on", "off"}:
                raise HomeAssistantActionError("ha_entity_unavailable", 503)
            if bp2 == "on":
                if bp1 != "on":
                    raise HomeAssistantActionError("last_psu_off_blocked", 409)
                await self._switch(PSU_2_ENTITY, "off")
                await self._verify_psu(PSU_2_ENTITY, "off")

        final_first, final_second = await self._fresh_psu_pair(
            require_known=not individual_action,
        )
        return self._psu_result(
            request.requestId,
            request.actionId,
            final_first.get("state"),
            final_second.get("state"),
        )

    @staticmethod
    def _climate_result(
        request_id: UUID,
        action_id: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        attributes = state.get("attributes", {})
        return {
            "schemaVersion": 1,
            "requestId": str(request_id),
            "actionId": action_id,
            "status": "confirmed",
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "climate": {
                "state": state.get("state"),
                "targetTemperature": attributes.get("temperature"),
                "fanMode": attributes.get("fan_mode"),
            },
            "psu": None,
        }

    @staticmethod
    def _psu_result(
        request_id: UUID,
        action_id: str,
        bp1: Any,
        bp2: Any,
    ) -> dict[str, Any]:
        mode = (
            "full"
            if bp1 == "on" and bp2 == "on"
            else "normal"
            if bp1 == "on" and bp2 == "off"
            else "secondary_only"
            if bp1 == "off" and bp2 == "on"
            else "off"
            if bp1 == "off" and bp2 == "off"
            else "unavailable"
        )
        return {
            "schemaVersion": 1,
            "requestId": str(request_id),
            "actionId": action_id,
            "status": "confirmed",
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "climate": None,
            "psu": {
                "mode": mode,
                "psu1State": bp1 if bp1 in {"on", "off"} else "unavailable",
                "psu2State": bp2 if bp2 in {"on", "off"} else "unavailable",
            },
        }


def build_home_assistant_action_router(
    executor: HomeAssistantActionExecutor,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/actions/home-assistant",
        tags=["home-assistant-actions"],
    )

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return executor.availability()

    @router.post("", response_model=dict[str, Any])
    async def execute(
        payload: HomeAssistantActionRequest,
        response: Response,
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return await executor.execute(payload)

    return router
