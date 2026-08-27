from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI

from panel_agent.planning_adapter import PlanningAdapter
from panel_agent.planning_api import build_planning_router
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


REFERENCE = "2026-08-12T09:00:00Z"
LOCAL_ID = "00000000-0000-4000-8000-000000000701"
EXTERNAL_ID = "00000000-0000-4000-8000-000000000702"
SOURCE_METADATA = [
    {
        "sourceType": "native_planning",
        "accountId": "local",
        "provider": "local",
        "status": "current",
        "lastSyncedAt": REFERENCE,
        "observedAt": REFERENCE,
        "errorCode": None,
        "calendars": [],
    },
    {
        "sourceType": "external_calendar",
        "accountId": "account_opaque",
        "provider": "icloud",
        "status": "stale",
        "lastSyncedAt": REFERENCE,
        "observedAt": REFERENCE,
        "errorCode": "provider_timeout",
        "calendars": [
            {
                "calendarId": "provider-calendar-secret",
                "displayName": "Работа",
                "color": None,
                "enabled": True,
                "status": "stale",
                "lastSyncedAt": REFERENCE,
                "observedAt": REFERENCE,
                "errorCode": "provider_timeout",
            }
        ],
    },
]


def _event(event_id: str, *, external: bool = False, deleted_at: str | None = None, version: int = 1) -> dict[str, object]:
    return {
        "id": event_id,
        "domain": "calendar_event",
        "title": "Встреча",
        "all_day": False,
        "timezone": "Europe/Moscow",
        "sync_state": "synced" if external else "local_only",
        "source": "calendar-provider" if external else "panel-agent",
        "version": version,
        "created_at": REFERENCE,
        "updated_at": REFERENCE,
        "audit_correlation_id": "00000000-0000-4000-8000-000000000799",
        "notes": "Сохранить заметку",
        "location": "Переговорная",
        "start_at_utc": "2026-08-12T10:00:00Z",
        "end_at_utc": "2026-08-12T11:00:00Z",
        "start_date": None,
        "end_date_exclusive": None,
        "recurrence_rule": None,
        "provider_id": "provider-secret-id" if external else None,
        "provider_calendar_id": "provider-calendar-secret" if external else None,
        "source_ref": "provider-ref" if external else None,
        "deleted_at": deleted_at,
    }


class EventMutationTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.fixture = PlanningFixtureTransport("healthy")
        self.events = {
            LOCAL_ID: _event(LOCAL_ID),
            EXTERNAL_ID: _event(EXTERNAL_ID, external=True),
        }
        self.writes: list[tuple[str, str, dict[str, object]]] = []
        self.idempotent: dict[str, dict[str, object]] = {}

    def _object(self, event: dict[str, object], request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schemaVersion": "planning.v1",
                "kind": "object",
                "domain": "calendar_event",
                "object": event,
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": "2026-08-12T09:05:00Z",
                "sources": SOURCE_METADATA,
                "correlation_id": "00000000-0000-4000-8000-000000000798",
            },
            request=request,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.startswith("/internal/planning/v1/events/"):
            event = self.events.get(path.rsplit("/", 1)[-1])
            if event is None:
                return httpx.Response(404, json={"error": {"code": "not_found"}}, request=request)
            return self._object(event, request)
        if request.method == "GET":
            return await self.fixture.handle_async_request(request)

        body = json.loads(request.content.decode("utf-8") or "{}")
        key = request.headers.get("idempotency-key", "")
        if key in self.idempotent:
            return self._object(self.idempotent[key], request)
        event_id = path.rsplit("/", 1)[-1]
        if request.method == "POST" and path == "/internal/planning/v1/events":
            event_id = LOCAL_ID
            event = _event(event_id)
            event.update({key: value for key, value in body.items()})
            self.events[event_id] = event
        else:
            event = self.events.get(event_id)
            if event is None:
                return httpx.Response(404, json={"error": {"code": "not_found"}}, request=request)
            if event.get("provider_id") is not None or event.get("provider_calendar_id") is not None or event.get("sync_state") != "local_only":
                return httpx.Response(409, json={"error": {"code": "event_not_local_only"}}, request=request)
            event = dict(event)
            if request.method == "PATCH":
                event.update(body)
            else:
                event["deleted_at"] = REFERENCE
            event["version"] = int(event["version"]) + 1
            self.events[event_id] = event
        self.writes.append((request.method, path, body))
        self.idempotent[key] = dict(event)
        return self._object(event, request)


def _settings(tmp_path, *, enabled: bool = True) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_calendar_mutations_enabled=enabled,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_timezone="Europe/Moscow",
    )


def _adapter(tmp_path, transport: EventMutationTransport, *, enabled: bool = True) -> PlanningAdapter:
    return PlanningAdapter(
        _settings(tmp_path, enabled=enabled),
        transport=transport,
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )


def test_b43_event_readback_projection_and_local_only_mutations(tmp_path):
    transport = EventMutationTransport()
    adapter = _adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            local = await client.get(f"/api/v1/planning/events/{LOCAL_ID}")
            external = await client.get(f"/api/v1/planning/events/{EXTERNAL_ID}")
            before = len(transport.writes)
            patched = await client.patch(
                f"/api/v1/planning/events/{LOCAL_ID}",
                headers={"Idempotency-Key": "event-edit", "If-Match": "1"},
                json={
                    "title": "Обновлённая встреча",
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T12:00:00Z",
                    "end_at_utc": "2026-08-12T13:00:00Z",
                    "start_date": None,
                    "end_date_exclusive": None,
                },
            )
            patched_replay = await client.patch(
                f"/api/v1/planning/events/{LOCAL_ID}",
                headers={"Idempotency-Key": "event-edit", "If-Match": "1"},
                json={
                    "title": "Обновлённая встреча",
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T12:00:00Z",
                    "end_at_utc": "2026-08-12T13:00:00Z",
                    "start_date": None,
                    "end_date_exclusive": None,
                },
            )
            deleted = await client.delete(
                f"/api/v1/planning/events/{LOCAL_ID}",
                headers={"Idempotency-Key": "event-delete", "If-Match": "2"},
            )
            deleted_replay = await client.delete(
                f"/api/v1/planning/events/{LOCAL_ID}",
                headers={"Idempotency-Key": "event-delete", "If-Match": "2"},
            )
            tombstone = await client.get(f"/api/v1/planning/events/{LOCAL_ID}")
            rejected_patch = await client.patch(
                f"/api/v1/planning/events/{EXTERNAL_ID}",
                headers={"Idempotency-Key": "external-edit", "If-Match": "1"},
                json={"title": "Не менять"},
            )
            rejected_delete = await client.delete(
                f"/api/v1/planning/events/{EXTERNAL_ID}",
                headers={"Idempotency-Key": "external-delete", "If-Match": "1"},
            )
            after = len(transport.writes)
        await adapter.close()
        return local, external, patched, patched_replay, deleted, deleted_replay, tombstone, rejected_patch, rejected_delete, before, after

    local, external, patched, patched_replay, deleted, deleted_replay, tombstone, rejected_patch, rejected_delete, before, after = asyncio.run(exercise())
    assert local.status_code == 200
    assert local.json()["object"]["localOnlyMutable"] is True
    assert local.json()["object"]["notes"] == "Сохранить заметку"
    assert local.json()["object"]["location"] == "Переговорная"
    assert external.status_code == 200
    external_object = external.json()["object"]
    assert external_object["localOnlyMutable"] is False
    assert "provider_id" not in external_object and "provider_calendar_id" not in external_object
    assert external_object["calendarIdentity"]["providerLabel"] == "iCloud"
    assert external_object["calendarIdentity"]["calendarLabel"] == "Работа"
    assert external.json()["sources"][1]["id"].startswith("external-icloud-")
    assert "account_opaque" not in external.text
    assert "provider-calendar-secret" not in external.text
    assert patched.status_code == 200 and patched.json()["object"]["version"] == 2
    assert patched_replay.status_code == patched.status_code and patched_replay.json() == patched.json()
    assert deleted.status_code == 200 and deleted.json()["object"]["deletedAt"] == REFERENCE
    assert deleted_replay.status_code == deleted.status_code and deleted_replay.json() == deleted.json()
    assert tombstone.status_code == 200 and tombstone.json()["object"]["deletedAt"] == REFERENCE
    assert rejected_patch.status_code == 409 and rejected_patch.json()["detail"] == "event_not_local_only"
    assert rejected_delete.status_code == 409 and rejected_delete.json()["detail"] == "event_not_local_only"
    assert before + 2 == after
    assert transport.events[EXTERNAL_ID]["provider_id"] == "provider-secret-id"
    assert transport.events[EXTERNAL_ID]["version"] == 1


def test_b43_event_routes_are_strict_and_gate_is_false_by_default(tmp_path):
    transport = EventMutationTransport()
    adapter = _adapter(tmp_path, transport, enabled=False)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            blocked = await client.post(
                "/api/v1/planning/events",
                headers={"Idempotency-Key": "blocked-event"},
                json={
                    "title": "Событие",
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T10:00:00Z",
                    "end_at_utc": "2026-08-12T11:00:00Z",
                    "start_date": None,
                    "end_date_exclusive": None,
                },
            )
            query = await client.get(f"/api/v1/planning/events/{LOCAL_ID}?from=bad")
            malformed = await client.get("/api/v1/planning/events/not-a-uuid")
        await adapter.close()
        return blocked, query, malformed

    blocked, query, malformed = asyncio.run(exercise())
    assert blocked.status_code == 404
    assert query.status_code == 422
    assert malformed.status_code == 422
    assert transport.writes == []
    assert adapter.projection is not None
    assert adapter.projection.calendarMutationsEnabled is False


def test_b43_calendar_gate_is_projected_to_snapshot_and_status(tmp_path):
    transport = EventMutationTransport()
    adapter = _adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        projection = adapter.projection
        status = adapter.status_projection()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            status_response = await client.get("/api/v1/planning/status")
        await adapter.close()
        return projection, status, status_response

    projection, status, status_response = asyncio.run(exercise())
    assert projection is not None
    assert projection.calendarMutationsEnabled is True
    assert status is not None
    assert status.calendarMutationsEnabled is True
    assert status_response.status_code == 200
    assert status_response.json()["calendarMutationsEnabled"] is True


def test_b43_degraded_projection_and_status_fail_closed_calendar_writer(tmp_path):
    transport = EventMutationTransport()
    adapter = _adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        transport.fixture.scenario = "timeout"
        await adapter.refresh_domains()
        degraded = adapter.projection
        status = adapter.status_projection()
        await adapter.close()
        return degraded, status

    degraded, status = asyncio.run(exercise())
    assert degraded is not None
    assert degraded.sourceStatus == "degraded"
    assert degraded.calendarMutationsEnabled is False
    assert status is not None
    assert status.sourceStatus == "degraded"
    assert status.calendarMutationsEnabled is False


def test_b43_event_mutation_body_rejects_provider_and_mixed_shape_fields(tmp_path):
    transport = EventMutationTransport()
    adapter = _adapter(tmp_path, transport)

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            provider_fields = await client.post(
                "/api/v1/planning/events",
                headers={"Idempotency-Key": "provider-fields"},
                json={
                    "title": "Не принимать provider ownership",
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T10:00:00Z",
                    "end_at_utc": "2026-08-12T11:00:00Z",
                    "start_date": None,
                    "end_date_exclusive": None,
                    "sync_state": "local_only",
                    "provider_id": "provider-id",
                },
            )
            mixed_shape = await client.post(
                "/api/v1/planning/events",
                headers={"Idempotency-Key": "mixed-shape"},
                json={
                    "title": "Смешанная форма",
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T10:00:00Z",
                    "end_at_utc": "2026-08-12T11:00:00Z",
                    "start_date": "2026-08-12",
                    "end_date_exclusive": None,
                },
            )
            missing_if_match = await client.patch(
                f"/api/v1/planning/events/{LOCAL_ID}",
                headers={"Idempotency-Key": "missing-if-match"},
                json={"title": "Версия обязательна"},
            )
        await adapter.close()
        return provider_fields, mixed_shape, missing_if_match

    provider_fields, mixed_shape, missing_if_match = asyncio.run(exercise())
    assert provider_fields.status_code == 422
    assert mixed_shape.status_code == 422
    assert missing_if_match.status_code == 400
    assert transport.writes == []
