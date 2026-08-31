from __future__ import annotations

import importlib
import json

from fastapi.testclient import TestClient
from pydantic import ValidationError


def load_app(monkeypatch, path, *, writes=True):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_DEVICE_VISIBILITY_PATH", str(path))
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def patch_visibility(client, revision, visible):
    return client.patch("/api/v1/settings/device-visibility", json={
        "expectedRevision": revision,
        "deviceKey": "kettle",
        "visible": visible,
    })


def test_default_is_visible_and_valid_update_survives_reload(tmp_path, monkeypatch):
    path = tmp_path / "device-visibility.json"
    module = load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        initial = client.get("/api/v1/settings/device-visibility").json()
        assert initial["revision"] == 0
        assert initial["available"] is True
        assert initial["devices"] == [{"key": "kettle", "label": "Чайник", "defaultVisible": True, "visible": True}]
        hidden = patch_visibility(client, 0, False)
        assert hidden.status_code == 200
        assert hidden.json()["devices"][0]["visible"] is False
        registered = {entry["id"]: entry for entry in client.get("/api/v1/snapshot?scenario=kettle-on").json()["services"]}["kettle"]
        assert registered["data"]["entityId"] == "water_heater.chainik"
        assert registered["dataContract"] == "home.kettle.v1"
        assert registered["actions"] == []
        shown = patch_visibility(client, 1, True)
        assert shown.status_code == 200
    module = load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        assert client.get("/api/v1/settings/device-visibility").json()["devices"][0]["visible"] is True


def test_unknown_key_malformed_state_and_revision_conflict_fail_safely(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "device-visibility.json")
    with TestClient(module.app) as client:
        unknown = client.patch("/api/v1/settings/device-visibility", json={"expectedRevision": 0, "deviceKey": "switch.random", "visible": False})
        assert unknown.status_code == 422
        assert client.get("/api/v1/settings/device-visibility").json()["devices"][0]["visible"] is True
        assert patch_visibility(client, 4, False).status_code == 409

    path = tmp_path / "malformed.json"
    path.write_text(json.dumps({"schemaVersion": "device.visibility.v1", "revision": 1, "updatedAt": "now", "visibility": {"switch.random": False}}), encoding="utf-8")
    module = load_app(monkeypatch, path)
    with TestClient(module.app) as client:
        recovered = client.get("/api/v1/settings/device-visibility").json()
        assert recovered["available"] is False
        assert recovered["devices"][0]["visible"] is True
        assert patch_visibility(client, 0, False).status_code == 503


def test_writes_disabled_and_registration_contract_remain_intact(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "device-visibility.json", writes=False)
    with TestClient(module.app) as client:
        assert client.get("/api/v1/settings/device-visibility").json()["writesEnabled"] is False
        assert patch_visibility(client, 0, False).status_code == 403
        services = {entry["id"]: entry for entry in client.get("/api/v1/snapshot?scenario=kettle-on").json()["services"]}
        assert services["kettle"]["data"]["entityId"] == "water_heater.chainik"
        assert services["kettle"]["dataContract"] == "home.kettle.v1"
        assert services["kettle"]["actions"] == []


def test_patch_contract_is_closed_to_extra_fields():
    from panel_agent.contracts import DeviceVisibilityPatch

    try:
        DeviceVisibilityPatch(expectedRevision=0, deviceKey="switch.random", visible=False)
    except ValidationError:
        pass
    else:
        raise AssertionError("unknown device key was accepted")
    try:
        DeviceVisibilityPatch(expectedRevision=0, deviceKey="kettle", visible=False, route="/home")
    except ValidationError:
        pass
    else:
        raise AssertionError("arbitrary routing field was accepted")
