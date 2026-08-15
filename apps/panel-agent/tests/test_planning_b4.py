from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI

from panel_agent.planning import PlanningObjectEnvelope
from panel_agent.planning_adapter import (
    PLANNING_MUTATION_ROUTES,
    PlanningAdapter,
    PlanningClient,
    PlanningUpstreamError,
)
from panel_agent.planning_api import build_planning_router
from panel_agent.planning_fixtures import PlanningFixtureTransport, fixture_payload
from panel_agent.settings import IntegrationSettings


REFERENCE = "2026-08-12T09:00:00Z"


def _settings(tmp_path, *, mutations: bool) -> IntegrationSettings:
    return IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_reminder_mutations_enabled=mutations,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="synthetic-internal-secret",
        panel_planning_secret="synthetic-panel-agent-secret",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_timezone="Europe/Moscow",
    )


class B4FixtureTransport(httpx.AsyncBaseTransport):
    def __init__(self, *, timeout_mutation: bool = False) -> None:
        self.fixture = PlanningFixtureTransport("healthy")
        self.timeout_mutation = timeout_mutation
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            return await self.fixture.handle_async_request(request)
        if request.url.path == "/internal/planning/v1/parse":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": "planning.v1",
                    "kind": "parse_preview",
                    "candidate": {
                        "domain": "reminder",
                        "operation": "create",
                        "fields": {
                            "title": "позвонить врачу",
                            "due_at_utc": "2026-08-13T12:00:00Z",
                            "timezone": "Europe/Moscow",
                        },
                        "normalized_paraphrase": "Напоминание «позвонить врачу» на 2026-08-13 в 15:00 (Europe/Moscow).",
                    },
                    "confidence": "high",
                    "ambiguities": [],
                    "requires_confirmation": False,
                    "normalized_text": "завтра в 15:00 напомни позвонить врачу",
                    "error_code": None,
                    "correlation_id": "00000000-0000-4000-8000-000000000099",
                },
                request=request,
            )
        if self.timeout_mutation:
            raise httpx.ReadTimeout("synthetic mutation timeout", request=request)
        path = request.url.path
        if path not in {
            "/internal/planning/v1/reminders",
            "/internal/planning/v1/reminders/00000000-0000-4000-8000-000000000001",
            "/internal/planning/v1/reminders/00000000-0000-4000-8000-000000000001/complete",
            "/internal/planning/v1/reminders/00000000-0000-4000-8000-000000000001/cancel",
        }:
            return httpx.Response(404, request=request)
        base = fixture_payload(
            "healthy",
            "/internal/planning/v1/reminders",
            httpx.QueryParams("limit=20"),
        )
        assert base is not None
        item = dict(base["items"][0])
        if request.method == "POST" and path.endswith("/complete"):
            item.update({"status": "completed", "completed_at": REFERENCE, "version": 2})
        elif request.method == "POST" and path.endswith("/cancel"):
            item.update({"status": "cancelled", "cancelled_at": REFERENCE, "version": 2})
        else:
            body = json.loads(request.content.decode("utf-8"))
            item.update({key: value for key, value in body.items() if key in {"title", "notes", "due_at_utc", "timezone"}})
            item["version"] = 2
        return httpx.Response(
            200,
            json={
                "schemaVersion": "planning.v1",
                "kind": "object",
                "domain": "reminder",
                "object": item,
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": "2026-08-12T09:05:00Z",
                "correlation_id": "00000000-0000-4000-8000-000000000099",
            },
            request=request,
        )


def test_b4_feature_gate_keeps_all_mutations_false_by_default(tmp_path):
    adapter = PlanningAdapter(
        _settings(tmp_path, mutations=False),
        transport=B4FixtureTransport(),
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            response = await client.post(
                "/api/v1/planning/reminders",
                headers={"Idempotency-Key": "b4-disabled-create"},
                json={
                    "title": "Synthetic reminder",
                    "notes": None,
                    "due_at_utc": "2026-08-13T12:00:00Z",
                    "timezone": "Europe/Moscow",
                },
            )
        projection = adapter.projection
        await adapter.close()
        return response, projection

    response, projection = asyncio.run(exercise())
    assert response.status_code == 404
    assert projection is not None
    assert projection.capabilities.model_dump() == {
        "create": False,
        "edit": False,
        "complete": False,
        "cancel": False,
        "delete": False,
        "voice": False,
        "providerSync": False,
    }


def test_b4_reminder_mutations_use_canonical_capabilities_and_readback(tmp_path):
    transport = B4FixtureTransport()
    adapter = PlanningAdapter(
        _settings(tmp_path, mutations=True),
        transport=transport,
        wall_clock=lambda: datetime(2026, 8, 12, 9, 0, tzinfo=timezone.utc),
    )

    async def exercise():
        await adapter.start()
        assert adapter.projection is not None
        assert adapter.projection.capabilities.create is True
        app = FastAPI()
        app.include_router(build_planning_router(adapter))
        headers = {"Idempotency-Key": "b4-create-001"}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as client:
            created = await client.post(
                "/api/v1/planning/reminders",
                headers=headers,
                json={
                    "title": "Обновить запись",
                    "notes": None,
                    "due_at_utc": "2026-08-13T12:00:00Z",
                    "timezone": "Europe/Moscow",
                },
            )
            completed = await client.post(
                "/api/v1/planning/reminders/00000000-0000-4000-8000-000000000001/complete",
                headers={"Idempotency-Key": "b4-complete-001", "If-Match": "1"},
                json={},
            )
        parsed = PlanningObjectEnvelope.model_validate(created.json())
        await adapter.close()
        return created, completed, parsed

    created, completed, parsed = asyncio.run(exercise())
    assert created.status_code == 200
    assert parsed.object.title == "Обновить запись"
    assert completed.status_code == 200
    assert completed.json()["object"]["status"] == "completed"
    mutation_requests = [request for request in transport.requests if request.method != "GET"]
    assert [request.url.path for request in mutation_requests] == [
        PLANNING_MUTATION_ROUTES["create_reminder"],
        PLANNING_MUTATION_ROUTES["complete_reminder"].replace("{reminder_id}", "00000000-0000-4000-8000-000000000001"),
    ]
    assert mutation_requests[0].headers["idempotency-key"] == "b4-create-001"
    assert mutation_requests[1].headers["if-match"] == "1"
    assert mutation_requests[1].headers["idempotency-key"] == "b4-complete-001"


def test_b4_parse_preview_is_a_fixed_non_mutating_relay(tmp_path):
    adapter = PlanningAdapter(
        _settings(tmp_path, mutations=False),
        transport=B4FixtureTransport(),
    )

    async def exercise():
        preview = await adapter.parse_preview(
            text="завтра в 15:00 напомни позвонить врачу",
            reference_time_utc=REFERENCE,
            timezone="Europe/Moscow",
        )
        await adapter.close()
        return preview

    preview = asyncio.run(exercise())
    assert preview.candidate is not None
    assert preview.candidate["domain"] == "reminder"
    assert preview.requires_confirmation is False


def test_b4_mutation_timeout_is_uncertain_and_never_success(tmp_path):
    client = PlanningClient(
        base_url="http://fixture.test",
        internal_secret="synthetic-internal-secret",
        panel_secret="synthetic-panel-agent-secret",
        transport=B4FixtureTransport(timeout_mutation=True),
    )

    async def exercise():
        with pytest.raises(PlanningUpstreamError) as error:
            await client.create_reminder(
                idempotency_key="b4-timeout-001",
                title="Synthetic reminder",
                notes=None,
                due_at_utc="2026-08-13T12:00:00Z",
                timezone="Europe/Moscow",
            )
        await client.close()
        return error.value

    error = asyncio.run(exercise())
    assert error.category == "mutation_uncertain"
    assert error.uncertain is True
