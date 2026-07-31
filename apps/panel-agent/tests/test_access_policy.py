from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore, build_access_router


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 31, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.value

    def advance(self, **kwargs) -> None:
        self.value += timedelta(**kwargs)


def test_policy_fails_closed_and_temporary_full_expires(tmp_path):
    clock = Clock()
    path = tmp_path / "access-policy.json"
    store = AccessPolicyStore(path, audit_dir=tmp_path / "audit", now=clock)

    assert store.status()["effectiveProfile"] == "read_only"
    assert store.authorize("home.coffee.control").allowed is False

    store.set_pin("2468")
    store.set_profile("standard")
    assert store.authorize("home.coffee.control").allowed is True
    assert store.authorize("avalar.main.restart").availability == "elevation_required"

    with pytest.raises(PermissionError, match="invalid_pin"):
        store.unlock_temporary("0000")

    unlocked = store.unlock_temporary("2468")
    assert unlocked["temporaryFull"] is True
    assert store.authorize("avalar.main.restart").allowed is True

    clock.advance(minutes=31)
    assert store.status()["effectiveProfile"] == "standard"
    assert store.status()["temporaryFull"] is False


def test_manual_full_persists_but_corruption_falls_back_to_read_only(tmp_path):
    path = tmp_path / "access-policy.json"
    store = AccessPolicyStore(path)
    store.set_pin("1357")
    store.set_profile("full", pin="1357")

    reloaded = AccessPolicyStore(path)
    assert reloaded.status()["baseProfile"] == "full"
    assert reloaded.status()["temporaryFull"] is False

    path.write_text('{"schemaVersion":1,"baseProfile":"full","pin":"plaintext"}', encoding="utf-8")
    recovered = AccessPolicyStore(path)
    assert recovered.status()["effectiveProfile"] == "read_only"
    assert recovered.status()["pinConfigured"] is False


def test_access_api_requires_pin_for_full_and_rejects_direct_bypass(tmp_path):
    store = AccessPolicyStore(tmp_path / "access-policy.json")
    store.set_pin("9876")
    store.set_profile("standard")
    app = FastAPI()
    app.include_router(build_access_router(store))
    client = TestClient(app)

    status_response = client.get("/api/v1/access")
    assert status_response.status_code == 200
    assert status_response.headers["cache-control"] == "no-store"

    rejected = client.patch(
        "/api/v1/access/profile",
        json={"profile": "full", "pin": "0000"},
    )
    assert rejected.status_code == 403
    assert store.status()["baseProfile"] == "standard"

    accepted = client.patch(
        "/api/v1/access/profile",
        json={"profile": "full", "pin": "9876"},
    )
    assert accepted.status_code == 200
    assert accepted.json()["baseProfile"] == "full"

    payload = json.loads((tmp_path / "access-policy.json").read_text(encoding="utf-8"))
    assert "9876" not in json.dumps(payload)
    assert payload["pin"]["algorithm"] == "pbkdf2_sha256"
