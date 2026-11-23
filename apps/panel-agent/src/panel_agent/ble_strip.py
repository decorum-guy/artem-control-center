"""Single-owner BLE transport for the verified ELK-BLEDDM profile."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .access_policy import AccessPolicyStore
from .contracts import ServicePresentation, ServiceSnapshot

SERVICE_ID = "living-room-light-strip"
SUFFIX = "-0000-1000-8000-00805f9b34fb"
SERVICE, WRITE, NOTIFY = ("0000" + short + SUFFIX for short in ("fff0", "fff3", "fff4"))
ADDRESS = re.compile(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}")
COLORS = {
    "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255), "yellow": (255, 220, 0),
    "purple": (138, 0, 192), "pink": (255, 0, 83), "sky": (60, 156, 255), "sea": (100, 255, 222),
    "white": (255, 56, 139), "lime": (150, 255, 0),
}
POWER = {"on": bytes.fromhex("7e 04 04 f0 00 01 ff 00 ef"), "off": bytes.fromhex("7e 04 04 00 00 00 ff 00 ef")}
SCAN_SECONDS = 4
ATTEMPT_SECONDS = 14
RETRY_SECONDS = 5
HEALTHY_PROBE_SECONDS = 15


class DeliveryUncertain(Exception):
    """The write was started and must never be replayed."""


class BleStripCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["on", "off", "color", "brightness"]
    color: str | None = None
    percent: int | None = Field(default=None, strict=True, ge=1, le=100)

    @model_validator(mode="after")
    def validate_parameters(self):
        if self.operation == "color":
            if self.color not in COLORS:
                raise ValueError("Unknown color preset")
        elif self.color is not None:
            raise ValueError("Unexpected color preset")
        if (self.operation == "brightness") != (self.percent is not None):
            raise ValueError("Brightness requires a percentage")
        return self

    @property
    def capability(self) -> str:
        action = f"power_{self.operation}" if self.operation in POWER else f"set_{self.operation}"
        return f"home.light_strip.{action}"

    def packet(self) -> bytes:
        if self.operation in POWER:
            return POWER[self.operation]
        if self.color is not None:
            return bytes((126, 0, 5, 3, *COLORS[self.color], 0, 239))
        assert self.percent is not None
        return bytes((126, 4, 1, self.percent, 255, 0, 255, 0, 239))


async def exchange(address: str, packet: bytes | None, before_write: Callable[[], None]) -> None:
    from bleak import BleakClient, BleakScanner

    def matches(device, advertisement) -> bool:
        name = advertisement.local_name or device.name or ""
        return device.address.upper() == address and name.strip().upper() == "ELK-BLEDDM"

    attempted_write = False
    try:
        async with asyncio.timeout(ATTEMPT_SECONDS):
            device = await BleakScanner.find_device_by_filter(matches, timeout=SCAN_SECONDS)
            if device is None:
                raise OSError("Target did not advertise")
            async with BleakClient(device, timeout=8) as client:
                service = client.services.get_service(SERVICE)
                writer = service.get_characteristic(WRITE) if service else None
                reader = service.get_characteristic(NOTIFY) if service else None
                if writer is None or "write-without-response" not in writer.properties or reader is None:
                    raise OSError("Unexpected GATT profile")
                if packet is not None:
                    before_write()
                    attempted_write = True
                    await client.write_gatt_char(writer, packet, response=False)
                    await asyncio.sleep(0.35)
    except Exception as exc:
        if attempted_write:
            raise DeliveryUncertain from exc
        raise


class BleStripManager:
    def __init__(self, address: str, *, transport=exchange):
        if not ADDRESS.fullmatch(address):
            raise ValueError("A verified Windows BLE address is required")
        self.address = address.upper()
        self.transport = transport
        self.lock = asyncio.Lock()
        self.changed: Callable[[], Awaitable[object]] | None = None
        self.available = False
        self.checked_at: str | None = None
        self._probe: asyncio.Task | None = None
        self._wake = asyncio.Event()

    def start(self) -> None:
        if self._probe is None:
            self._probe = asyncio.create_task(self._watch(), name="ble-strip-link")

    async def close(self) -> None:
        if self._probe is not None:
            self._probe.cancel()
            await asyncio.gather(self._probe, return_exceptions=True)
            self._probe = None

    async def _link(self, available: bool) -> None:
        self.available = available
        if available:
            self.checked_at = datetime.now(timezone.utc).isoformat()
        if self.changed:
            await self.changed()

    async def _watch(self) -> None:
        while True:
            async with self.lock:
                self._wake.clear()
                try:
                    await self.transport(self.address, None, lambda: None)
                except Exception:
                    await self._link(False)
                else:
                    await self._link(True)
            delay = HEALTHY_PROBE_SECONDS if self.available else RETRY_SECONDS
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except TimeoutError:
                pass
            else:
                # The previous command failed; leave the controller time to recover.
                await asyncio.sleep(RETRY_SECONDS)

    async def command(self, command: BleStripCommand, allow: Callable[[bool], None]) -> dict:
        allow(self.lock.locked())
        async with self.lock:
            try:
                await self.transport(self.address, command.packet(), lambda: allow(False))
            except HTTPException:
                raise
            except Exception:
                await self._link(False)
                self._wake.set()
                raise
            await self._link(True)
        return {"outcome": "write_completed", "physicalState": "unknown",
                "requested": command.model_dump(exclude_none=True)}

    def snapshot(self) -> ServiceSnapshot:
        summary = "BLE доступна" if self.available else "Поиск BLE-ленты"
        return ServiceSnapshot(
            id=SERVICE_ID, title="Лента в зале", dataContract="home.light-strip.v1",
            health="healthy" if self.available else "offline", source="live" if self.available else "unavailable",
            summary=summary,
            presentation=ServicePresentation(category="home-device", group="Home infrastructure",
                                             overview="quick-control", priority=75, environment="home"),
            data={"provider": "ble", "available": self.available, "state": "unknown", "observedAt": self.checked_at},
        )


def build_ble_strip_router(manager: BleStripManager, load_policy: Callable[[], AccessPolicyStore],
                           write_enabled: Callable[[], bool]) -> APIRouter:
    router = APIRouter(prefix="/api/v1/ble-strip")

    @router.post("/action")
    async def action(command: BleStripCommand, request: Request):
        origin = request.headers.get("origin")
        host = request.headers.get("host")
        if (request.client is None or request.client.host not in {"127.0.0.1", "::1"}
                or request.headers.get("x-panel-intent") != "ble-strip"
                or origin is None
                or origin not in {f"http://{host}", f"https://{host}"}
                or not re.fullmatch(r"(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?", host or "")):
            raise HTTPException(403, "loopback_origin_required")

        def allow(busy: bool) -> None:
            load_policy().require(command.capability, gate_enabled=write_enabled(), busy=busy)

        try:
            result = await manager.command(command, allow)
        except HTTPException:
            raise
        except DeliveryUncertain as exc:
            load_policy().audit_capability(command.capability, result="delivery_uncertain")
            raise HTTPException(503, "delivery_uncertain") from exc
        except Exception as exc:
            load_policy().audit_capability(command.capability, result="ble_unavailable")
            raise HTTPException(503, "ble_unavailable") from exc
        load_policy().audit_capability(command.capability, result="write_completed")
        return result

    return router
