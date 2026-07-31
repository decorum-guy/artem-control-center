from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_middleware import AccessPolicyMiddleware
from panel_agent.access_policy import AccessPolicyStore


def build_client(tmp_path):
    store = AccessPolicyStore(tmp_path / "access-policy.json")
    app = FastAPI()
    app.add_middleware(AccessPolicyMiddleware, store=store)

    @app.post("/api/v1/actions/home/coffee")
    def mutate():
        return {"ok": True}

    return store, TestClient(app)


def test_direct_mutation_is_structured_denial_not_server_error(tmp_path):
    store, client = build_client(tmp_path)

    denied = client.post("/api/v1/actions/home/coffee")
    assert denied.status_code == 403
    assert denied.json() == {"detail": "profile_blocked"}
    assert denied.headers["cache-control"] == "no-store"

    store.set_pin("2468")
    store.set_profile("standard")
    accepted = client.post("/api/v1/actions/home/coffee")
    assert accepted.status_code == 200
    assert accepted.json() == {"ok": True}
