from __future__ import annotations

import asyncio
import inspect
import ipaddress
import json
import re
import socket
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Literal, Protocol

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from .access_policy import CAPABILITIES, AccessPolicyStore
from .contracts import ActionDescriptor, ServiceSnapshot
from .settings import IntegrationSettings

ROG_G703_TARGET_ID = "rog_g703gi"
ROG_G703_WAKE_ACTION = "system.rog_g703.wake"
ROG_G703_HIBERNATE_ACTION = "system.rog_g703.hibernate"
ROG_G703_SLEEP_ACTION = "system.rog_g703.sleep"

RogActionId = Literal[
    ROG_G703_WAKE_ACTION,
    ROG_G703_HIBERNATE_ACTION,
    ROG_G703_SLEEP_ACTION,
]
RogDeviceStatus = Literal[
    "online",
    "offline",
    "waking",
    "sleeping",
    "hibernating",
    "unavailable",
]
RogActionStatus = Literal[
    "requested",
    "waking",
    "verifying",
    "online",
    "wake_timeout",
    "sleeping",
    "hibernating",
    "offline",
    "failed",
]

CAPABILITIES.setdefault(ROG_G703_WAKE_ACTION, "standard")
CAPABILITIES.setdefault(ROG_G703_HIBERNATE_ACTION, "standard")
CAPABILITIES.setdefault(ROG_G703_SLEEP_ACTION, "standard")

_MAC_SEPARATOR_PATTERN = re.compile(r"[-:.]")
_SAFE_ERROR_CODES = {
    "companion_health_failed",
    "companion_hibernate_failed",
    "companion_sleep_failed",
    "companion_response_too_large",
    "hibernate_timeout",
    "health_unreachable",
    "invalid_companion_response",
    "rog_g703_not_configured",
    "sleep_timeout",
    "wake_timeout",
    "wol_send_failed",
}


def parse_mac(value: str) -> bytes:
    """Parse the configured MAC without accepting browser-provided values."""

    compact = _MAC_SEPARATOR_PATTERN.sub("", value.strip())
    if not re.fullmatch(r"[0-9a-fA-F]{12}", compact):
        raise ValueError("invalid_rog_g703_mac")
    parsed = bytes.fromhex(compact)
    if parsed == b"\x00" * 6 or parsed[0] & 1:
        raise ValueError("invalid_rog_g703_mac")
    return parsed


def build_magic_packet(mac: str | bytes) -> bytes:
    mac_bytes = parse_mac(mac) if isinstance(mac, str) else mac
    if len(mac_bytes) != 6 or mac_bytes == b"\x00" * 6 or mac_bytes[0] & 1:
        raise ValueError("invalid_rog_g703_mac")
    return b"\xff" * 6 + mac_bytes * 16


class WakeOnLanSender:
    """The only UDP sender used by the ROG integration."""

    def __init__(
        self,
        *,
        mac: bytes,
        broadcast_address: str,
        broadcast_interface: str,
        repeats: int,
        port: int = 9,
    ) -> None:
        self.packet = build_magic_packet(mac)
        self.broadcast_address = str(ipaddress.IPv4Address(broadcast_address))
        self.broadcast_interface = broadcast_interface
        self.repeats = min(3, max(1, repeats))
        self.port = port

    def send(self) -> int:
        sent = 0
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            if self.broadcast_interface:
                connection.bind((self.broadcast_interface, 0))
            for _ in range(self.repeats):
                connection.sendto(self.packet, (self.broadcast_address, self.port))
                sent += 1
        return sent


class RogCompanion(Protocol):
    async def health(self) -> bool: ...

    async def hibernate(self) -> None: ...

    async def sleep(self) -> None: ...


class CompanionRequestError(RuntimeError):
    def __init__(self, code: str, *, unreachable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.unreachable = unreachable


async def _read_bounded_response(response: httpx.Response, limit: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            raise CompanionRequestError("companion_response_too_large")
    return bytes(body)


class HttpRogCompanion:
    """Fixed-origin, fixed-route client for the ASUS companion."""

    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = settings.rog_g703_companion_base_url
        self.secret = settings.rog_g703_companion_secret
        self.timeout = settings.rog_g703_http_timeout_seconds
        self.response_limit = settings.rog_g703_response_limit_bytes
        self.transport = transport

    async def health(self) -> bool:
        payload = await self._request("GET", "/health", expected_status=200)
        if payload.get("ok") is not True or payload.get("status") != "online":
            raise CompanionRequestError("invalid_companion_response")
        return True

    async def hibernate(self) -> None:
        payload = await self._request(
            "POST",
            "/hibernate",
            expected_status=202,
            failure_code="companion_hibernate_failed",
        )
        if payload.get("accepted") is not True or payload.get("operation") != "hibernate":
            raise CompanionRequestError("companion_hibernate_failed")

    async def sleep(self) -> None:
        payload = await self._request(
            "POST",
            "/sleep",
            expected_status=202,
            failure_code="companion_sleep_failed",
        )
        if payload.get("accepted") is not True or payload.get("operation") != "sleep":
            raise CompanionRequestError("companion_sleep_failed")

    async def _request(
        self,
        method: Literal["GET", "POST"],
        path: Literal["/health", "/hibernate", "/sleep"],
        *,
        expected_status: int,
        failure_code: str | None = None,
    ) -> dict[str, Any]:
        # The origin and the two paths are constants. No browser input reaches
        # this client, and redirects are deliberately not followed.
        headers = {"Authorization": f"Bearer {self.secret}"}
        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                follow_redirects=False,
                limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
                transport=self.transport,
            ) as client:
                async with client.stream(method, path, headers=headers) as response:
                    body = await _read_bounded_response(response, self.response_limit)
                    if response.status_code != expected_status:
                        raise CompanionRequestError(
                            "companion_health_failed" if method == "GET" else failure_code or "companion_request_failed"
                        )
        except CompanionRequestError:
            raise
        except (httpx.TimeoutException, httpx.NetworkError, OSError, TimeoutError) as exc:
            del exc
            raise CompanionRequestError("companion_unreachable", unreachable=True) from None
        except httpx.HTTPError as exc:
            del exc
            raise CompanionRequestError(
                "companion_health_failed" if method == "GET" else failure_code or "companion_request_failed"
            ) from None

        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            del exc
            raise CompanionRequestError("invalid_companion_response") from None
        if not isinstance(payload, dict):
            raise CompanionRequestError("invalid_companion_response")
        return payload


ChangeCallback = Callable[[], Awaitable[None]]


class RogG703Device:
    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        companion: RogCompanion | None = None,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self.settings = settings
        self.companion = companion or HttpRogCompanion(settings)
        self._clock = clock or time.monotonic
        self._sleep = sleep or asyncio.sleep
        self.status: RogDeviceStatus = "offline"
        self.last_error: str | None = None
        self.observed_at = _iso()
        self.last_transition_at = self.observed_at
        self._on_change: ChangeCallback | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._poll_loop: asyncio.AbstractEventLoop | None = None

    @property
    def enabled(self) -> bool:
        return self.settings.rog_g703_enabled

    @property
    def configured(self) -> bool:
        return bool(
            self.enabled
            and self.settings.rog_g703_target_id == ROG_G703_TARGET_ID
            and self.settings.rog_g703_companion_base_url
            and self.settings.rog_g703_companion_secret
        )

    def set_on_change(self, callback: ChangeCallback | None) -> None:
        self._on_change = callback

    async def start(self) -> None:
        if not self.enabled:
            return
        await self.refresh()
        loop = asyncio.get_running_loop()
        self._poll_loop = loop
        self._poll_task = asyncio.create_task(self._poll_forever())

    async def close(self) -> None:
        task = self._poll_task
        self._poll_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def refresh(self) -> bool:
        if not self.enabled or self.status in {"waking", "sleeping", "hibernating"}:
            return self.status == "online"
        try:
            online = await self.companion.health()
        except Exception:
            online = False
        await self.set_status(
            "online" if online else "offline",
            error=None if online else "health_unreachable",
        )
        return online

    async def set_status(
        self,
        value: RogDeviceStatus,
        *,
        error: str | None = None,
    ) -> None:
        changed = self.status != value or self.last_error != error
        if self.status != value:
            self.last_transition_at = _iso()
        self.status = value
        self.last_error = error if error in _SAFE_ERROR_CODES or error is None else "action_failed"
        self.observed_at = _iso()
        if changed and self._on_change is not None:
            await self._on_change()

    async def wait_until_online(self, timeout_seconds: int) -> bool:
        deadline = self._clock() + timeout_seconds
        delay = 0.25
        while self._clock() < deadline:
            try:
                if await self.companion.health():
                    await self.set_status("online")
                    return True
            except Exception:
                pass
            remaining = deadline - self._clock()
            if remaining <= 0:
                break
            await self._sleep(min(delay, remaining))
            delay = min(2.0, delay * 2)
        await self.set_status("offline", error="wake_timeout")
        return False

    async def wait_until_offline(self, timeout_seconds: int) -> bool:
        deadline = self._clock() + timeout_seconds
        delay = 0.25
        while self._clock() < deadline:
            try:
                if not await self.companion.health():
                    await self.set_status("offline")
                    return True
            except CompanionRequestError as exc:
                if exc.unreachable:
                    await self.set_status("offline")
                    return True
            except (ConnectionError, OSError, TimeoutError):
                await self.set_status("offline")
                return True
            remaining = deadline - self._clock()
            if remaining <= 0:
                break
            await self._sleep(min(delay, remaining))
            delay = min(2.0, delay * 2)
        return False

    def public_state(self) -> dict[str, Any]:
        return {
            "targetId": ROG_G703_TARGET_ID,
            "status": self.status,
            "observedAt": self.observed_at,
            "lastTransitionAt": self.last_transition_at,
            "lastError": self.last_error,
        }

    def service_snapshot(self) -> ServiceSnapshot:
        status_to_health = {
            "online": "healthy",
            "offline": "offline",
            "waking": "degraded",
            "sleeping": "degraded",
            "hibernating": "degraded",
            "unavailable": "offline",
        }
        summaries = {
            "online": "В сети",
            "offline": "Не отвечает · сон или гибернация",
            "waking": "Проверяем появление ASUS в сети",
            "sleeping": "Переходит в сон Windows",
            "hibernating": "Переходит в гибернацию Windows S4",
            "unavailable": "Исполнитель ASUS недоступен",
        }
        write_enabled = self.settings.writes_enabled and self.enabled and self.configured
        actions = [
            ActionDescriptor(
                id=ROG_G703_WAKE_ACTION,
                title="Включить",
                enabled=write_enabled and self.status in {"offline", "unavailable"},
                risk="low",
            ),
            ActionDescriptor(
                id=ROG_G703_HIBERNATE_ACTION,
                title="Гибернация",
                enabled=write_enabled and self.status == "online",
                risk="medium",
            ),
            ActionDescriptor(
                id=ROG_G703_SLEEP_ACTION,
                title="Сон",
                enabled=write_enabled and self.status == "online",
                risk="medium",
            ),
        ]
        return ServiceSnapshot(
            id=ROG_G703_TARGET_ID,
            title="ASUS ROG G703GI",
            enabled=True,
            dataContract="system.rog-g703.v1",
            health=status_to_health[self.status],
            source="live" if self.status != "unavailable" else "unavailable",
            summary=summaries[self.status],
            actions=actions,
            data=self.public_state(),
            presentation={
                "category": "system",
                "group": "System",
                "overview": "none",
                "priority": 85,
                "environment": "LAN",
                "freshnessLabel": "только что",
                "incidents": 0 if self.status == "online" else 1,
            },
        )

    async def _poll_forever(self) -> None:
        while True:
            await asyncio.sleep(self.settings.rog_g703_health_poll_seconds)
            if self.status not in {"waking", "sleeping", "hibernating"}:
                await self.refresh()


class RogG703ActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actionId: RogActionId


class RogG703ActionExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    correlationId: str
    targetId: Literal[ROG_G703_TARGET_ID] = ROG_G703_TARGET_ID
    actionId: RogActionId
    status: RogActionStatus
    requestedAt: str
    updatedAt: str
    finishedAt: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


class RogG703ActionExecutor:
    def __init__(
        self,
        settings: IntegrationSettings,
        access: AccessPolicyStore,
        *,
        device: RogG703Device,
        wol_sender: Callable[[], int | Awaitable[int]] | None = None,
    ) -> None:
        self.settings = settings
        self.access = access
        self.device = device
        self._wol_sender = wol_sender
        if self._wol_sender is None and settings.rog_g703_enabled:
            sender = WakeOnLanSender(
                mac=parse_mac(settings.rog_g703_mac),
                broadcast_address=settings.rog_g703_broadcast_address,
                broadcast_interface=settings.rog_g703_broadcast_interface,
                repeats=settings.rog_g703_wol_repeats,
            )
            self._wol_sender = sender.send
        self.executions: OrderedDict[str, RogG703ActionExecution] = OrderedDict()
        self.cooldowns: dict[str, datetime] = {}
        self.active_correlation_id: str | None = None
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None

    def gate_enabled(self, action_id: str) -> bool:
        del action_id
        return bool(self.settings.writes_enabled and self.settings.rog_g703_enabled)

    def _integration_available(self, action_id: str) -> bool:
        if not self.device.configured:
            return False
        if action_id == ROG_G703_WAKE_ACTION:
            return self._wol_sender is not None
        return action_id in {ROG_G703_HIBERNATE_ACTION, ROG_G703_SLEEP_ACTION}

    def _precondition_ok(self, action_id: str) -> bool:
        if action_id in {ROG_G703_HIBERNATE_ACTION, ROG_G703_SLEEP_ACTION}:
            return self.device.status == "online"
        return self.device.status in {"offline", "unavailable"}

    def availability(self, action_id: RogActionId) -> dict[str, Any]:
        cooldown_until = self.cooldowns.get(action_id)
        cooldown = cooldown_until is not None and cooldown_until > _now()
        decision = self.access.authorize(
            action_id,
            gate_enabled=self.gate_enabled(action_id),
            integration_available=self._integration_available(action_id),
            busy=self.active_correlation_id is not None,
            cooldown=cooldown,
            precondition_ok=self._precondition_ok(action_id),
        )
        payload = decision.as_dict()
        payload["cooldownUntil"] = _iso(cooldown_until) if cooldown else None
        payload["targetId"] = ROG_G703_TARGET_ID
        payload["status"] = self.device.status
        return payload

    async def start(self, request: RogG703ActionRequest) -> RogG703ActionExecution:
        action_id = request.actionId
        self.access.require(
            action_id,
            gate_enabled=self.gate_enabled(action_id),
            integration_available=self._integration_available(action_id),
            busy=self.active_correlation_id is not None,
            cooldown=(
                self.cooldowns.get(action_id) is not None
                and self.cooldowns[action_id] > _now()
            ),
            precondition_ok=self._precondition_ok(action_id),
        )
        correlation_id = str(uuid.uuid4())
        execution = RogG703ActionExecution(
            correlationId=correlation_id,
            actionId=action_id,
            status="requested",
            requestedAt=_iso(),
            updatedAt=_iso(),
        )
        self.executions[correlation_id] = execution
        while len(self.executions) > 50:
            self.executions.popitem(last=False)
        self.active_correlation_id = correlation_id
        self.access.audit_capability(
            action_id,
            result="accepted",
            correlation_id=correlation_id,
        )
        asyncio.create_task(self._execute(correlation_id))
        return execution.model_copy(deep=True)

    def get(self, correlation_id: str) -> RogG703ActionExecution:
        execution = self.executions.get(correlation_id)
        if execution is None:
            raise HTTPException(status_code=404, detail="action_not_found")
        return execution.model_copy(deep=True)

    def _update(
        self,
        correlation_id: str,
        status_value: RogActionStatus,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        current = self.executions[correlation_id]
        finished = status_value in {"online", "offline", "wake_timeout", "failed"}
        self.executions[correlation_id] = current.model_copy(
            update={
                "status": status_value,
                "updatedAt": _iso(),
                "finishedAt": _iso() if finished else None,
                "result": result,
                "error": error,
            }
        )

    async def _execute(self, correlation_id: str) -> None:
        execution = self.executions[correlation_id]
        action_id = execution.actionId
        try:
            loop = asyncio.get_running_loop()
            if self._lock is None or self._lock_loop is not loop:
                self._lock = asyncio.Lock()
                self._lock_loop = loop
            async with self._lock:
                if action_id == ROG_G703_WAKE_ACTION:
                    await self._execute_wake(correlation_id)
                elif action_id == ROG_G703_HIBERNATE_ACTION:
                    await self._execute_hibernate(correlation_id)
                elif action_id == ROG_G703_SLEEP_ACTION:
                    await self._execute_sleep(correlation_id)
                else:
                    raise RuntimeError("rog_g703_action_failed")
        except Exception as exc:
            error = _sanitize_error(exc)
            self._update(correlation_id, "failed", error=error)
            await self.device.set_status(
                "offline" if action_id == ROG_G703_WAKE_ACTION else "online",
                error=error,
            )
            self.access.audit_capability(
                action_id,
                result=error,
                correlation_id=correlation_id,
            )
        finally:
            if self.active_correlation_id == correlation_id:
                self.active_correlation_id = None

    async def _execute_wake(self, correlation_id: str) -> None:
        self._update(correlation_id, "waking")
        await self.device.set_status("waking")
        try:
            assert self._wol_sender is not None
            result = self._wol_sender()
            packets_sent = await result if inspect.isawaitable(result) else result
            if not isinstance(packets_sent, int) or not 1 <= packets_sent <= 3:
                raise RuntimeError("wol_send_failed")
        except Exception as exc:
            raise RuntimeError("wol_send_failed") from exc

        self.cooldowns[ROG_G703_WAKE_ACTION] = _now() + timedelta(
            seconds=self.settings.rog_g703_wol_cooldown_seconds
        )
        self._update(
            correlation_id,
            "verifying",
            result={"packetsSent": packets_sent},
        )
        online = await self.device.wait_until_online(
            self.settings.rog_g703_health_timeout_seconds
        )
        if not online:
            self._update(
                correlation_id,
                "wake_timeout",
                result={"packetsSent": packets_sent, "onlineConfirmed": False},
                error="wake_timeout",
            )
            self.access.audit_capability(
                ROG_G703_WAKE_ACTION,
                result="wake_timeout",
                correlation_id=correlation_id,
            )
            return

        self._update(
            correlation_id,
            "online",
            result={"packetsSent": packets_sent, "onlineConfirmed": True},
        )
        self.access.audit_capability(
            ROG_G703_WAKE_ACTION,
            result="success",
            correlation_id=correlation_id,
        )

    async def _execute_hibernate(self, correlation_id: str) -> None:
        self._update(correlation_id, "hibernating")
        await self.device.set_status("hibernating")
        try:
            await self.device.companion.hibernate()
        except Exception as exc:
            raise RuntimeError("companion_hibernate_failed") from exc

        self.cooldowns[ROG_G703_HIBERNATE_ACTION] = _now() + timedelta(
            seconds=self.settings.rog_g703_hibernate_cooldown_seconds
        )
        offline = await self.device.wait_until_offline(
            self.settings.rog_g703_hibernate_timeout_seconds
        )
        if not offline:
            self._update(
                correlation_id,
                "failed",
                result={"offlineConfirmed": False},
                error="hibernate_timeout",
            )
            await self.device.set_status("online", error="hibernate_timeout")
            self.access.audit_capability(
                ROG_G703_HIBERNATE_ACTION,
                result="hibernate_timeout",
                correlation_id=correlation_id,
            )
            return

        self._update(
            correlation_id,
            "offline",
            result={"offlineConfirmed": True},
        )
        self.access.audit_capability(
            ROG_G703_HIBERNATE_ACTION,
            result="success",
            correlation_id=correlation_id,
        )

    async def _execute_sleep(self, correlation_id: str) -> None:
        self._update(correlation_id, "sleeping")
        await self.device.set_status("sleeping")
        try:
            await self.device.companion.sleep()
        except Exception as exc:
            raise RuntimeError("companion_sleep_failed") from exc

        self.cooldowns[ROG_G703_SLEEP_ACTION] = _now() + timedelta(
            seconds=self.settings.rog_g703_sleep_cooldown_seconds
        )
        offline = await self.device.wait_until_offline(
            self.settings.rog_g703_sleep_timeout_seconds
        )
        if not offline:
            self._update(
                correlation_id,
                "failed",
                result={"offlineConfirmed": False},
                error="sleep_timeout",
            )
            await self.device.set_status("online", error="sleep_timeout")
            self.access.audit_capability(
                ROG_G703_SLEEP_ACTION,
                result="sleep_timeout",
                correlation_id=correlation_id,
            )
            return

        self._update(
            correlation_id,
            "offline",
            result={"offlineConfirmed": True},
        )
        self.access.audit_capability(
            ROG_G703_SLEEP_ACTION,
            result="success",
            correlation_id=correlation_id,
        )


def build_rog_g703_action_router(executor: RogG703ActionExecutor) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/actions/system/rog-g703",
        tags=["rog-g703-actions"],
    )

    @router.get("/availability")
    def availability(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return {
            "schemaVersion": 1,
            "targetId": ROG_G703_TARGET_ID,
            "status": executor.device.public_state(),
            "actions": {
                ROG_G703_WAKE_ACTION: executor.availability(ROG_G703_WAKE_ACTION),
                ROG_G703_HIBERNATE_ACTION: executor.availability(
                    ROG_G703_HIBERNATE_ACTION
                ),
                ROG_G703_SLEEP_ACTION: executor.availability(ROG_G703_SLEEP_ACTION),
            },
        }

    @router.post("", response_model=RogG703ActionExecution, status_code=status.HTTP_202_ACCEPTED)
    async def start_action(
        payload: RogG703ActionRequest,
        response: Response,
    ) -> RogG703ActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return await executor.start(payload)

    @router.get("/{correlation_id}", response_model=RogG703ActionExecution)
    def get_action(correlation_id: str, response: Response) -> RogG703ActionExecution:
        response.headers["Cache-Control"] = "no-store"
        return executor.get(correlation_id)

    return router


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat()


def _sanitize_error(error: Exception) -> str:
    value = str(error)
    return value if value in _SAFE_ERROR_CODES else "rog_g703_action_failed"
