"""Exercise the isolated preview with a fake BLE transport."""

import asyncio
import importlib.util
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import ModuleType

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def pilot(monkeypatch):
    directory = Path(__file__).resolve().parents[3] / "scripts" / "diagnostics"
    bleak = ModuleType("bleak")
    bleak.BleakClient = object
    bleak.BleakScanner = object
    monkeypatch.setitem(sys.modules, "bleak", bleak)
    for name, filename in (("ble_strip_pilot", "ble_strip_pilot.py"), ("ble_preview", "ble-strip-preview.py")):
        spec = importlib.util.spec_from_file_location(name, directory / filename)
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
    return module


def test_preview_checks_access_serializes_writes_and_reports_uncertain_delivery(pilot, tmp_path, monkeypatch):
    operations = []
    started = Event()
    release = Event()

    async def operate(operation, address, seconds, percent=None):
        operations.append((operation, percent))
        if operation == "on":
            started.set()
            assert await asyncio.to_thread(release.wait, 5)
        if operation == "off":
            raise pilot.DeliveryUncertain("fixture")
        return {"result": "write_completed", "physical_state": "unverified"}

    monkeypatch.setattr(pilot, "operate", operate)
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"schemaVersion": 1, "baseProfile": "standard"}), encoding="utf-8")
    origin = "http://127.0.0.1:8795"
    headers = {"Origin": origin, "X-Panel-Intent": "ble-pilot"}
    app = pilot.create_app("AA:BB:CC:DD:EE:FF", 8795, policy, tmp_path / "audit", True)
    with TestClient(app, base_url=origin, client=("127.0.0.1", 12345)) as client:
        assert client.get("/").text.count('data-action="/color/') == 10
        assert client.get("/cycle").status_code == 404
        assert client.post("/brightness", headers=headers, json={"percent": 0}).status_code == 422
        assert client.post("/brightness", headers=headers, json={"percent": "20"}).status_code == 422
        assert client.post("/brightness", json={"percent": 20}).status_code == 403
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.post, "/power/on", headers=headers)
            try:
                assert started.wait(3)
                assert client.post("/color/white", headers=headers).status_code == 409
            finally:
                release.set()
            assert pending.result(3).json()["physical_state"] == "unverified"

        assert client.post("/color/white", headers=headers).status_code == 200
        assert client.post("/brightness", headers=headers, json={"percent": 80}).status_code == 200
        result = client.post("/power/off", headers=headers)
        assert result.status_code == 503 and result.json()["detail"] == "delivery_uncertain"
        policy.write_text(json.dumps({"schemaVersion": 1, "baseProfile": "read_only"}), encoding="utf-8")
        assert client.post("/color/sea", headers=headers).status_code == 403
    assert operations == [("on", None), ("white", None), ("brightness", 80), ("off", None)]


def test_inflight_preview_does_not_restore_old_policy_on_expiry(pilot, tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    original_store = pilot.AccessPolicyStore
    now = datetime(2026, 11, 23, tzinfo=timezone.utc)
    clock = [now]
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps({
        "schemaVersion": 1, "revision": 1, "baseProfile": "standard",
        "temporaryFullExpiresAt": (now + timedelta(seconds=1)).isoformat(),
    }), encoding="utf-8")
    owner = original_store(policy_path, now=lambda: clock[0])
    monkeypatch.setattr(pilot, "AccessPolicyStore",
                        lambda *a, **kw: original_store(*a, **kw, now=lambda: clock[0]))

    async def operate(*args, **kwargs):
        owner.set_profile("read_only")
        clock[0] += timedelta(seconds=2)
        return {"result": "write_completed"}

    monkeypatch.setattr(pilot, "operate", operate)
    origin = "http://127.0.0.1:8795"
    headers = {"Origin": origin, "X-Panel-Intent": "ble-pilot"}
    app = pilot.create_app("AA:BB:CC:DD:EE:FF", 8795, policy_path, tmp_path / "preview-audit", True)
    with TestClient(app, base_url=origin, client=("127.0.0.1", 12345)) as client:
        assert client.post("/power/on", headers=headers).status_code == 200
        assert json.loads(policy_path.read_text(encoding="utf-8"))["baseProfile"] == "read_only"
        assert client.post("/power/off", headers=headers).status_code == 403
    assert (tmp_path / "preview-audit" / "access-audit-2026-11-23.jsonl").is_file()
