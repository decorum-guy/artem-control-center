from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI

from panel_agent.planning import PlanningTaskObjectEnvelope
from panel_agent.planning_adapter import PlanningAdapter, PlanningClient
from panel_agent.planning_api import build_planning_router
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


REFERENCE = "2026-08-12T09:00:00Z"
OPEN_ID = "00000000-0000-4000-8000-000000000101"
COMPLETED_ID = "00000000-0000-4000-8000-000000000102"
ARCHIVED_ID = "00000000-0000-4000-8000-000000000103"


def _settings(tmp_path, *, mutations: bool) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_task_mutations_enabled=mutations,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_timezone="Europe/Moscow",
    )


class TaskMutationTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.fixture = PlanningFixtureTransport("healthy")
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, str, dict[str, object]]] = []
        self.idempotent: dict[str, dict[str, object]] = {}
        self.tasks = {
            OPEN_ID: self._task(OPEN_ID, "Открытая задача"),
            COMPLETED_ID: self._task(COMPLETED_ID, "Завершенная задача", status="completed", version=2),
            ARCHIVED_ID: self._task(ARCHIVED_ID, "Архивная задача", status="archived", version=2),
        }

    @staticmethod
    def _task(
        task_id: str,
        title: str,
        *,
        status: str = "open",
        due_date: str | None = None,
        due_time: str | None = None,
        timezone_name: str | None = None,
        version: int = 1,
    ) -> dict[str, object]:
        return {
            "id": task_id,
            "domain": "task",
            "title": title,
            "priority": "normal",
            "status": status,
            "source": "panel-agent",
            "version": version,
            "created_at": REFERENCE,
            "updated_at": REFERENCE,
            "audit_correlation_id": "00000000-0000-4000-8000-000000000099",
            "notes": None,
            "due_date": due_date,
            "due_time": due_time,
            "timezone": timezone_name,
            "project_id": None,
            "source_ref": None,
            "completed_at": REFERENCE if status == "completed" else None,
            "archived_at": REFERENCE if status == "archived" else None,
            "deleted_at": REFERENCE if status == "archived" else None,
        }

    def _object(self, task: dict[str, object], request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schemaVersion": "planning.v1",
                "kind": "object",
                "domain": "task",
                "object": task,
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": "2026-08-12T09:05:00Z",
                "correlation_id": "00000000-0000-4000-8000-000000000099",
            },
            request=request,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET":
            if path.startswith("/internal/planning/v1/tasks/"):
                task_id = path.rsplit("/", 1)[-1]
                task = self.tasks.get(task_id)
                if task is None:
                    return httpx.Response(404, json={"error": {"code": "not_found"}}, request=request)
                return self._object(task, request)
            return await self.fixture.handle_async_request(request)

        body = json.loads(request.content.decode("utf-8") or "{}")
        key = request.headers.get("idempotency-key", "")
        if key in self.idempotent:
            return self._object(self.idempotent[key], request)
        if path == "/internal/planning/v1/tasks" and request.method == "POST":
            task_id = OPEN_ID
            task = self._task(
                task_id,
                str(body["title"]),
                due_date=body.get("due_date"),
                due_time=body.get("due_time"),
                timezone_name=body.get("timezone"),
            )
            task["priority"] = body["priority"]
            task["notes"] = body.get("notes")
            task["project_id"] = body.get("project_id")
            self.tasks[task_id] = task
        else:
            task_id = path.split("/tasks/", 1)[1].split("/", 1)[0]
            task = dict(self.tasks[task_id])
            if request.method == "PATCH":
                task.update({key: value for key, value in body.items()})
            elif path.endswith("/complete"):
                task.update({"status": "completed", "completed_at": REFERENCE})
            elif request.method == "DELETE":
                task.update({"status": "archived", "archived_at": REFERENCE, "deleted_at": REFERENCE})
            task["version"] = int(task["version"]) + 1
            self.tasks[task_id] = task
        self.writes.append((request.method, path, body))
        self.idempotent[key] = task
        return self._object(task, request)


def _build_adapter(tmp_path, transport: TaskMutationTransport, *, mutations: bool = True) -> PlanningAdapter:
    return PlanningAdapter(
        _settings(tmp_path, mutations=mutations),
        transport=transport,
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )


def test_b42_task_routes_preserve_date_shapes_and_use_delete_for_archive(tmp_path):
    transport = TaskMutationTransport()
    adapter = _build_adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            date_only = await client.post(
                "/api/v1/planning/tasks",
                headers={"Idempotency-Key": "task-date-only"},
                json={"title": "Купить продукты", "priority": "normal", "due_date": "2026-08-14"},
            )
            timed = await client.patch(
                f"/api/v1/planning/tasks/{OPEN_ID}",
                headers={"Idempotency-Key": "task-timed-edit", "If-Match": "1"},
                json={"due_date": "2026-08-14", "due_time": "18:30", "timezone": "Europe/Moscow"},
            )
            archived = await client.delete(
                f"/api/v1/planning/tasks/{OPEN_ID}",
                headers={"Idempotency-Key": "task-archive", "If-Match": "2"},
            )
        await adapter.close()
        return date_only, timed, archived

    date_only, timed, archived = asyncio.run(exercise())
    assert date_only.status_code == 200
    assert date_only.json()["object"]["dueDate"] == "2026-08-14"
    assert date_only.json()["object"]["dueTime"] is None
    assert date_only.json()["object"]["timezone"] is None
    assert timed.status_code == 200
    assert timed.json()["object"]["dueTime"] == "18:30"
    assert timed.json()["object"]["timezone"] == "Europe/Moscow"
    assert archived.status_code == 200
    assert archived.json()["object"]["status"] == "archived"
    assert archived.json()["object"]["deletedAt"] == REFERENCE
    assert [(method, path) for method, path, _ in transport.writes] == [
        ("POST", "/internal/planning/v1/tasks"),
        ("PATCH", f"/internal/planning/v1/tasks/{OPEN_ID}"),
        ("DELETE", f"/internal/planning/v1/tasks/{OPEN_ID}"),
    ]
    assert transport.requests[-1].headers["if-match"] == "2"


def test_b42_read_by_id_proves_terminal_lifecycle_and_has_no_write_side_effect(tmp_path):
    transport = TaskMutationTransport()
    adapter = _build_adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            before = len(transport.writes)
            open_response = await client.get(f"/api/v1/planning/tasks/{OPEN_ID}")
            completed_response = await client.get(f"/api/v1/planning/tasks/{COMPLETED_ID}")
            archived_response = await client.get(f"/api/v1/planning/tasks/{ARCHIVED_ID}")
            missing = await client.get("/api/v1/planning/tasks/00000000-0000-4000-8000-000000000404")
            malformed = await client.get("/api/v1/planning/tasks/not-a-uuid")
            unmatched = await client.get(f"/api/v1/planning/tasks/{OPEN_ID}/extra")
            after = len(transport.writes)
        await adapter.close()
        return open_response, completed_response, archived_response, missing, malformed, unmatched, before, after

    open_response, completed, archived, missing, malformed, unmatched, before, after = asyncio.run(exercise())
    assert open_response.status_code == 200
    assert completed.status_code == 200 and completed.json()["object"]["status"] == "completed"
    assert archived.status_code == 200 and archived.json()["object"]["status"] == "archived"
    assert before == after
    assert missing.status_code == 404 and missing.json()["detail"] == "planning_task_not_found"
    assert malformed.status_code == 422 and malformed.json()["detail"] == "planning_task_id_invalid"
    assert unmatched.status_code == 404


def test_b42_task_gate_is_false_by_default_and_dst_wall_times_are_rejected(tmp_path):
    transport = TaskMutationTransport()
    adapter = _build_adapter(tmp_path, transport, mutations=False)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            blocked = await client.post(
                "/api/v1/planning/tasks",
                headers={"Idempotency-Key": "blocked-task"},
                json={"title": "blocked", "priority": "normal"},
            )
            nonexistent = await client.post(
                "/api/v1/planning/tasks",
                headers={"Idempotency-Key": "nonexistent-wall"},
                json={"title": "gap", "priority": "normal", "due_date": "2026-03-08", "due_time": "02:30", "timezone": "America/New_York"},
            )
        await adapter.close()
        return blocked, nonexistent

    blocked, nonexistent = asyncio.run(exercise())
    assert blocked.status_code == 404
    assert nonexistent.status_code == 422
    assert transport.writes == []


def test_b42_task_envelope_preserves_canonical_fields(tmp_path):
    transport = TaskMutationTransport()
    transport.tasks[OPEN_ID]["notes"] = "Не потерять чек"
    transport.tasks[OPEN_ID]["source_ref"] = "panel:test"
    transport.tasks[OPEN_ID]["due_date"] = None
    transport.tasks[OPEN_ID]["due_time"] = None
    transport.tasks[OPEN_ID]["timezone"] = None
    adapter = _build_adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        envelope = await adapter.read_task_by_id(task_id=OPEN_ID)
        await adapter.close()
        return envelope

    envelope = asyncio.run(exercise())
    parsed = PlanningTaskObjectEnvelope.model_validate(envelope.model_dump())
    assert parsed.object.notes == "Не потерять чек"
    assert parsed.object.sourceRef == "panel:test"
    assert parsed.object.version == 1
    assert parsed.object.dueDate is None
    assert parsed.object.dueTime is None
    assert parsed.object.timezone is None
