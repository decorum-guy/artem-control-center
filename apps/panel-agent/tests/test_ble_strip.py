import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from panel_agent import ble_strip
from panel_agent.access_policy import AccessPolicyStore
from panel_agent.ble_strip import BleStripCommand, BleStripManager, DeliveryUncertain, build_ble_strip_router


TARGET = "00:11:22:33:44:55"
LOOPBACK = {"Origin": "http://127.0.0.1:8797", "X-Panel-Intent": "ble-strip"}


def test_gatt_failure_recovers_without_replay(monkeypatch):
    monkeypatch.setattr(ble_strip, "RETRY_SECONDS", 0.01)
    monkeypatch.setattr(ble_strip, "HEALTHY_PROBE_SECONDS", 0.015)

    async def scenario():
        calls = []
        recovered = asyncio.Event()
        available = False
        uncertain = False

        async def transport(address, packet, before_write):
            assert address == TARGET
            if not available:
                raise OSError
            if packet is not None:
                before_write()
                calls.append(packet)
                if uncertain:
                    raise DeliveryUncertain

        manager = BleStripManager(TARGET, transport=transport)

        async def changed():
            if manager.available:
                recovered.set()

        manager.changed = changed
        manager.start()
        try:
            await asyncio.sleep(0.025)
            assert not manager.available
            with pytest.raises(OSError):
                await manager.command(BleStripCommand(operation="on"), lambda _busy: None)
            assert calls == []
            available = True
            await asyncio.wait_for(recovered.wait(), timeout=1)
            assert manager.checked_at
            recovered.clear()
            uncertain = True
            with pytest.raises(DeliveryUncertain):
                await manager.command(BleStripCommand(operation="off"), lambda _busy: None)
            assert not manager.available
            await asyncio.wait_for(recovered.wait(), timeout=1)
            assert len(calls) == 1
            uncertain = False
            assert (await manager.command(BleStripCommand(operation="color", color="sea"),
                                          lambda _busy: None))["physicalState"] == "unknown"
            assert len(calls) == 2
        finally:
            await manager.close()
        assert manager._probe is None

    asyncio.run(scenario())


def test_route_rechecks_gate_after_connection(tmp_path: Path):
    writes = []
    allowed = True

    async def transport(_address, packet, before_write):
        nonlocal allowed
        allowed = False
        before_write()
        writes.append(packet)

    policy = AccessPolicyStore(tmp_path / "access.json")
    policy.set_profile("standard")
    app = FastAPI()
    app.include_router(build_ble_strip_router(BleStripManager(TARGET, transport=transport), lambda: policy, lambda: allowed))
    with TestClient(app, base_url="http://127.0.0.1:8797", client=("127.0.0.1", 5000)) as client:
        forbidden = client.post("/api/v1/ble-strip/action", json={"operation": "on"})
        assert forbidden.status_code == 403
        blocked = client.post("/api/v1/ble-strip/action", json={"operation": "on"}, headers=LOOPBACK)
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == "gate_disabled"
        assert writes == []
        rejected = client.post("/api/v1/ble-strip/action", json={"operation": "brightness", "percent": 101},
                               headers=LOOPBACK)
        assert rejected.status_code == 422


def test_controller_gate_rejection_does_not_mark_link_down():
    async def scenario():
        async def transport(_address, _packet, before_write):
            before_write()

        def allow(busy):
            if len(calls) == 1:
                raise HTTPException(403, "profile_blocked")
            calls.append(busy)

        calls = []
        manager = BleStripManager(TARGET, transport=transport)
        await manager._link(True)
        with pytest.raises(HTTPException):
            await manager.command(BleStripCommand(operation="on"), allow)
        assert manager.available

    asyncio.run(scenario())
