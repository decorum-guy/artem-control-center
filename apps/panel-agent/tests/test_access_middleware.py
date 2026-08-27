from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_middleware import AccessPolicyMiddleware, capability_for_request
from panel_agent.access_policy import CAPABILITIES, AccessPolicyStore


def build_client(tmp_path):
    store = AccessPolicyStore(tmp_path / "access-policy.json")
    app = FastAPI()
    app.add_middleware(AccessPolicyMiddleware, store=store)

    @app.post("/api/v1/actions/home/coffee")
    def mutate():
        return {"ok": True}

    @app.patch("/api/v1/settings/ai/selection")
    def ai_selection():
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


def test_ai_provider_settings_are_a_registered_standard_capability(tmp_path):
    store, client = build_client(tmp_path)
    denied = client.patch("/api/v1/settings/ai/selection")
    assert denied.status_code == 403
    store.set_pin("2468")
    store.set_profile("standard")
    assert client.patch("/api/v1/settings/ai/selection").status_code == 200
    assert capability_for_request("PATCH", "/api/v1/settings/ai/providers/gigachat/credential") == "settings.ai.providers"


def build_planning_client(tmp_path):
    store = AccessPolicyStore(tmp_path / "access-policy.json", audit_dir=tmp_path / "audit")
    calls: list[tuple[str, str]] = []
    app = FastAPI()
    app.add_middleware(AccessPolicyMiddleware, store=store)

    @app.post("/api/v1/planning/reminders")
    def create():
        calls.append(("POST", "/api/v1/planning/reminders"))
        return {"ok": True}

    @app.patch("/api/v1/planning/reminders/{reminder_id}")
    def edit(reminder_id: str):
        calls.append(("PATCH", reminder_id))
        return {"ok": True}

    @app.post("/api/v1/planning/reminders/{reminder_id}/complete")
    def complete(reminder_id: str):
        calls.append(("POST", f"{reminder_id}/complete"))
        return {"ok": True}

    @app.post("/api/v1/planning/reminders/{reminder_id}/cancel")
    def cancel(reminder_id: str):
        calls.append(("POST", f"{reminder_id}/cancel"))
        return {"ok": True}

    @app.post("/api/v1/planning/tasks")
    def create_task():
        calls.append(("POST", "/api/v1/planning/tasks"))
        return {"ok": True}

    @app.patch("/api/v1/planning/tasks/{task_id}")
    def edit_task(task_id: str):
        calls.append(("PATCH", task_id))
        return {"ok": True}

    @app.post("/api/v1/planning/tasks/{task_id}/complete")
    def complete_task(task_id: str):
        calls.append(("POST", f"{task_id}/complete"))
        return {"ok": True}

    @app.delete("/api/v1/planning/tasks/{task_id}")
    def archive_task(task_id: str):
        calls.append(("DELETE", task_id))
        return {"ok": True}

    @app.post("/api/v1/planning/events")
    def create_event():
        calls.append(("POST", "/api/v1/planning/events"))
        return {"ok": True}

    @app.patch("/api/v1/planning/events/{event_id}")
    def edit_event(event_id: str):
        calls.append(("PATCH", event_id))
        return {"ok": True}

    @app.delete("/api/v1/planning/events/{event_id}")
    def delete_event(event_id: str):
        calls.append(("DELETE", event_id))
        return {"ok": True}

    return store, calls, TestClient(app)


def _audit_records(tmp_path):
    return [
        json.loads(line)
        for audit_file in (tmp_path / "audit").glob("access-audit-*.jsonl")
        for line in audit_file.read_text(encoding="utf-8").splitlines()
    ]


def test_planning_capabilities_are_fixed_standard_catalog_entries():
    capabilities = {
        "planning.reminders.create",
        "planning.reminders.edit",
        "planning.reminders.complete",
        "planning.reminders.cancel",
        "planning.tasks.create",
        "planning.tasks.edit",
        "planning.tasks.complete",
        "planning.tasks.archive",
        "planning.calendar.create",
        "planning.calendar.edit",
        "planning.calendar.delete",
    }
    assert capabilities <= CAPABILITIES.keys()
    assert all(CAPABILITIES[capability] == "standard" for capability in capabilities)


def test_capability_settings_are_a_fixed_full_access_mutation():
    assert CAPABILITIES["settings.capabilities.manage"] == "full"
    assert capability_for_request("PATCH", "/api/v1/settings/capabilities") == "settings.capabilities.manage"
    assert capability_for_request("POST", "/api/v1/system/runtime/apply-capabilities") == "settings.capabilities.manage"


def test_calendar_source_refresh_is_a_standard_owner_action():
    assert CAPABILITIES["planning.calendar_sources.refresh"] == "standard"
    assert capability_for_request("POST", "/api/v1/planning/calendar-sources/refresh") == "planning.calendar_sources.refresh"


def test_planning_route_matching_is_fixed_and_unknown_actions_are_unregistered():
    reminder_id = "not-a-uuid-but-one-path-segment"
    assert capability_for_request("POST", "/api/v1/planning/reminders") == "planning.reminders.create"
    assert capability_for_request("PATCH", f"/api/v1/planning/reminders/{reminder_id}") == "planning.reminders.edit"
    assert capability_for_request("POST", f"/api/v1/planning/reminders/{reminder_id}/complete") == "planning.reminders.complete"
    assert capability_for_request("POST", f"/api/v1/planning/reminders/{reminder_id}/cancel") == "planning.reminders.cancel"
    assert capability_for_request("POST", f"/api/v1/planning/reminders/{reminder_id}/snooze") is None
    assert capability_for_request("POST", f"/api/v1/planning/reminders/{reminder_id}/complete/extra") is None
    assert capability_for_request("PATCH", "/api/v1/planning/reminders/a/b") is None
    assert capability_for_request("POST", "/api/v1/planning/tasks") == "planning.tasks.create"
    assert capability_for_request("POST", "/api/v1/planning/events") == "planning.calendar.create"
    assert capability_for_request("PATCH", "/api/v1/planning/events/not-a-uuid") == "planning.calendar.edit"
    assert capability_for_request("DELETE", "/api/v1/planning/events/not-a-uuid") == "planning.calendar.delete"
    assert capability_for_request("GET", "/api/v1/planning/events/not-a-uuid") is None
    assert capability_for_request("POST", "/api/v1/planning/events/not-a-uuid/extra") is None
    assert capability_for_request("PATCH", f"/api/v1/planning/tasks/{reminder_id}") == "planning.tasks.edit"
    assert capability_for_request("POST", f"/api/v1/planning/tasks/{reminder_id}/complete") == "planning.tasks.complete"
    assert capability_for_request("DELETE", f"/api/v1/planning/tasks/{reminder_id}") == "planning.tasks.archive"
    assert capability_for_request("GET", f"/api/v1/planning/tasks/{reminder_id}") is None
    assert capability_for_request("POST", f"/api/v1/planning/tasks/{reminder_id}/archive") is None


def test_read_only_blocks_every_task_writer_before_handler(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    task_id = "not-a-uuid-but-one-path-segment"
    responses = [
        client.post("/api/v1/planning/tasks", json={}),
        client.patch(f"/api/v1/planning/tasks/{task_id}", json={}),
        client.post(f"/api/v1/planning/tasks/{task_id}/complete", json={}),
        client.delete(f"/api/v1/planning/tasks/{task_id}"),
    ]
    assert [response.status_code for response in responses] == [403, 403, 403, 403]
    assert calls == []
    audited = [record for record in _audit_records(tmp_path) if record["event"] == "capability_execution"]
    assert {record["capability"] for record in audited} == {
        "planning.tasks.create",
        "planning.tasks.edit",
        "planning.tasks.complete",
        "planning.tasks.archive",
    }


def test_standard_profile_allows_task_access_layer_without_manufacturing_canonical_capability(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    store.set_profile("standard")
    task_id = "not-a-uuid-but-one-path-segment"
    responses = [
        client.post("/api/v1/planning/tasks", json={}),
        client.patch(f"/api/v1/planning/tasks/{task_id}", json={}),
        client.post(f"/api/v1/planning/tasks/{task_id}/complete", json={}),
        client.delete(f"/api/v1/planning/tasks/{task_id}"),
    ]
    assert [response.status_code for response in responses] == [200, 200, 200, 200]
    assert len(calls) == 4
    assert all(
        store.status()["capabilities"][capability]["allowed"]
        for capability in {
            "planning.tasks.create",
            "planning.tasks.edit",
            "planning.tasks.complete",
            "planning.tasks.archive",
        }
    )


def test_read_only_blocks_every_planning_writer_before_handler_and_audits(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    reminder_id = "not-a-uuid-but-one-path-segment"
    requests = [
        ("post", "/api/v1/planning/reminders", {"json": {}}),
        ("patch", f"/api/v1/planning/reminders/{reminder_id}", {"json": {}}),
        ("post", f"/api/v1/planning/reminders/{reminder_id}/complete", {"json": {}}),
        ("post", f"/api/v1/planning/reminders/{reminder_id}/cancel", {"json": {}}),
    ]
    responses = [getattr(client, method)(path, **kwargs) for method, path, kwargs in requests]

    assert [response.status_code for response in responses] == [403, 403, 403, 403]
    assert [response.json() for response in responses] == [{"detail": "profile_blocked"}] * 4
    assert calls == []
    audited = [record for record in _audit_records(tmp_path) if record["event"] == "capability_execution"]
    assert {record["capability"] for record in audited} == {
        "planning.reminders.create",
        "planning.reminders.edit",
        "planning.reminders.complete",
        "planning.reminders.cancel",
    }
    assert {record["result"] for record in audited} == {"profile_blocked"}


def test_standard_allows_registered_planning_capabilities_without_manufacturing_gate(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    store.set_profile("standard")
    reminder_id = "not-a-uuid-but-one-path-segment"
    responses = [
        client.post("/api/v1/planning/reminders", json={}),
        client.patch(f"/api/v1/planning/reminders/{reminder_id}", json={}),
        client.post(f"/api/v1/planning/reminders/{reminder_id}/complete", json={}),
        client.post(f"/api/v1/planning/reminders/{reminder_id}/cancel", json={}),
    ]

    assert [response.status_code for response in responses] == [200, 200, 200, 200]
    assert len(calls) == 4
    status = store.status()
    assert all(status["capabilities"][capability]["allowed"] for capability in {
        "planning.reminders.create",
        "planning.reminders.edit",
        "planning.reminders.complete",
        "planning.reminders.cancel",
    })
    audited = [record for record in _audit_records(tmp_path) if record["event"] == "capability_execution"]
    assert {record["capability"] for record in audited} >= {
        "planning.reminders.create",
        "planning.reminders.edit",
        "planning.reminders.complete",
        "planning.reminders.cancel",
    }
    assert {record["result"] for record in audited} >= {"success"}


def test_read_only_blocks_calendar_writers_before_handler_and_keeps_read_by_id_unregistered(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    event_id = "not-a-uuid-but-one-path-segment"
    responses = [
        client.post("/api/v1/planning/events", json={}),
        client.patch(f"/api/v1/planning/events/{event_id}", json={}),
        client.delete(f"/api/v1/planning/events/{event_id}"),
    ]
    read = client.get(f"/api/v1/planning/events/{event_id}")

    assert [response.status_code for response in responses] == [403, 403, 403]
    assert read.status_code == 405
    assert calls == []
    audited = [record for record in _audit_records(tmp_path) if record["event"] == "capability_execution"]
    assert {record["capability"] for record in audited} == {
        "planning.calendar.create",
        "planning.calendar.edit",
        "planning.calendar.delete",
    }


def test_standard_allows_calendar_access_layer_without_manufacturing_planning_state(tmp_path):
    store, calls, client = build_planning_client(tmp_path)
    store.set_profile("standard")
    event_id = "not-a-uuid-but-one-path-segment"
    responses = [
        client.post("/api/v1/planning/events", json={}),
        client.patch(f"/api/v1/planning/events/{event_id}", json={}),
        client.delete(f"/api/v1/planning/events/{event_id}"),
    ]

    assert [response.status_code for response in responses] == [200, 200, 200]
    assert len(calls) == 3
    assert all(
        store.status()["capabilities"][capability]["allowed"]
        for capability in {
            "planning.calendar.create",
            "planning.calendar.edit",
            "planning.calendar.delete",
        }
    )
