import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent import host_battery


@pytest.mark.parametrize(
    ("ac", "flags", "percentage", "expected"),
    [
        (1, 9, 86, {"percentage": 86, "charging": True, "pluggedIn": True}),
        (1, 1, 100, {"percentage": 100, "charging": False, "pluggedIn": True}),
        (0, 4, 0, {"percentage": 0, "charging": False, "pluggedIn": False}),
        (255, 255, 60, {"percentage": 60, "charging": None, "pluggedIn": None}),
        (1, 8, 255, {"percentage": None, "charging": True, "pluggedIn": True}),
        (1, 128, 255, None),
        (255, 255, 255, None),
    ],
)
def test_decode_battery(ac, flags, percentage, expected):
    status = host_battery.SystemPowerStatus(ac, flags, percentage, 0, 0, 0)
    result = host_battery.decode_battery(status)
    assert (result.model_dump() if result else None) == expected


def test_battery_route_is_read_only_and_uncached(monkeypatch):
    sample = host_battery.BatteryStatus(percentage=21, charging=False, pluggedIn=False)
    monkeypatch.setattr(host_battery, "read_battery", lambda: sample)
    app = FastAPI()
    app.include_router(host_battery.router)
    client = TestClient(app)

    response = client.get("/api/v1/system/battery")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == sample.model_dump()
    assert client.post("/api/v1/system/battery").status_code == 405

    monkeypatch.setattr(host_battery, "read_battery", lambda: None)
    assert client.get("/api/v1/system/battery").json() is None
