from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from panel_agent.planning import (
    EventObjectEnvelope,
    UpstreamCalendarDestinationDeletedEnvelope,
    UpstreamCalendarDestinationObjectEnvelope,
    UpstreamCalendarDestinationsEnvelope,
    UpstreamCalendarEvent,
    UpstreamPlanningSource,
)
from panel_agent.planning_adapter import PlanningAdapter, PlanningUpstreamError
from panel_agent.planning_api import build_planning_router
from panel_agent.settings import IntegrationSettings


REFERENCE = "2026-08-12T09:00:00Z"
STALE_AFTER = "2026-08-12T09:05:00Z"
EVENT_ID = "00000000-0000-4000-8000-000000000901"
RAW_CALENDAR_ID = "icloud_calendar_" + "a" * 64
RAW_NEW_CALENDAR_ID = "icloud_calendar_" + "b" * 64


def _source() -> UpstreamPlanningSource:
    return UpstreamPlanningSource.model_validate(
        {
            "sourceType": "external_calendar",
            "accountId": "account_opaque",
            "provider": "icloud",
            "status": "current",
            "lastSyncedAt": REFERENCE,
            "observedAt": REFERENCE,
            "errorCode": None,
            "calendars": [
                {
                    "calendarId": RAW_CALENDAR_ID,
                    "displayName": "Работа",
                    "color": "#336699",
                    "enabled": True,
                    "status": "current",
                    "lastSyncedAt": REFERENCE,
                    "observedAt": REFERENCE,
                    "errorCode": None,
                },
                {
                    "calendarId": RAW_NEW_CALENDAR_ID,
                    "displayName": "Личное",
                    "color": "#AA7733",
                    "enabled": True,
                    "status": "current",
                    "lastSyncedAt": REFERENCE,
                    "observedAt": REFERENCE,
                    "errorCode": None,
                },
            ],
        }
    )


def _event(*, version: int = 1, deleted_at: str | None = None, title: str = "Встреча") -> UpstreamCalendarEvent:
    return UpstreamCalendarEvent.model_validate(
        {
            "id": EVENT_ID,
            "domain": "calendar_event",
            "title": title,
            "all_day": False,
            "timezone": "Europe/Moscow",
            "sync_state": "synced",
            "source": "calendar-provider",
            "version": version,
            "created_at": REFERENCE,
            "updated_at": REFERENCE,
            "audit_correlation_id": "00000000-0000-4000-8000-000000000902",
            "notes": None,
            "location": None,
            "start_at_utc": "2026-08-12T10:00:00Z",
            "end_at_utc": "2026-08-12T11:00:00Z",
            "start_date": None,
            "end_date_exclusive": None,
            "recurrence_rule": None,
            "provider_id": "provider-secret",
            "provider_calendar_id": RAW_CALENDAR_ID,
            "source_ref": "provider-event-secret",
            "deleted_at": deleted_at,
        }
    )


class ProviderClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.fail_destinations = False
        self.can_create_event = True
        self.can_delete_calendar = True

    async def close(self) -> None:
        return None

    async def calendar_destinations(self) -> UpstreamCalendarDestinationsEnvelope:
        if self.fail_destinations:
            raise PlanningUpstreamError("http_error", status_code=404)
        return UpstreamCalendarDestinationsEnvelope.model_validate(
            {
                "schemaVersion": "planning.v1",
                "kind": "calendar_destinations",
                "domain": "calendar_destination",
                "items": [
                    {
                        "id": RAW_CALENDAR_ID,
                        "label": "Работа",
                        "color": "#336699",
                        "providerKind": "icloud",
                        "writeState": "writable",
                        "canCreateEvent": self.can_create_event,
                        "canDeleteCalendar": self.can_delete_calendar,
                    }
                ],
                "capabilities": {"canCreateCalendar": True},
                "generatedAt": REFERENCE,
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": STALE_AFTER,
                "correlation_id": "00000000-0000-4000-8000-000000000903",
            }
        )

    def _event_response(self, event: UpstreamCalendarEvent) -> EventObjectEnvelope:
        return EventObjectEnvelope.model_validate(
            {
                "schemaVersion": "planning.v1",
                "kind": "object",
                "domain": "calendar_event",
                "object": event.model_dump(),
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": STALE_AFTER,
                "sources": [_source().model_dump()],
                "correlation_id": "00000000-0000-4000-8000-000000000904",
                "mutationCapabilities": {
                    "canEdit": True,
                    "canDelete": True,
                    "providerKind": "icloud",
                    "writeState": "writable",
                },
            }
        )

    async def create_provider_event(self, *, idempotency_key: str, body: dict[str, object]) -> EventObjectEnvelope:
        self.calls.append(("create_provider_event", dict(body)))
        return self._event_response(_event(title=str(body["title"])))

    async def update_provider_event(self, *, event_id: str, expected_version: int, idempotency_key: str, body: dict[str, object]) -> EventObjectEnvelope:
        self.calls.append(("update_provider_event", dict(body)))
        return self._event_response(_event(version=expected_version + 1, title=str(body.get("title", "Обновлённая встреча"))))

    async def delete_provider_event(self, *, event_id: str, expected_version: int, idempotency_key: str) -> EventObjectEnvelope:
        self.calls.append(("delete_provider_event", {}))
        return self._event_response(_event(version=expected_version + 1, deleted_at=REFERENCE))

    async def create_provider_calendar(self, *, idempotency_key: str, body: dict[str, object]) -> UpstreamCalendarDestinationObjectEnvelope:
        self.calls.append(("create_provider_calendar", dict(body)))
        return UpstreamCalendarDestinationObjectEnvelope.model_validate(
            {
                "schemaVersion": "planning.v1",
                "kind": "calendar_destination",
                "domain": "calendar_destination",
                "destination": {
                    "id": RAW_NEW_CALENDAR_ID,
                    "label": body["display_name"],
                    "color": body["color"],
                    "providerKind": "icloud",
                    "writeState": "writable",
                    "canCreateEvent": self.can_create_event,
                    "canDeleteCalendar": self.can_delete_calendar,
                },
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": STALE_AFTER,
                "correlation_id": "00000000-0000-4000-8000-000000000905",
            }
        )

    async def delete_provider_calendar(self, *, calendar_id: str, idempotency_key: str) -> UpstreamCalendarDestinationDeletedEnvelope:
        self.calls.append(("delete_provider_calendar", calendar_id))
        return UpstreamCalendarDestinationDeletedEnvelope.model_validate(
            {
                "schemaVersion": "planning.v1",
                "kind": "calendar_destination_deleted",
                "domain": "calendar_destination",
                "calendarId": calendar_id,
                "deleted": True,
                "sourceStatus": "current",
                "lastSyncedAt": REFERENCE,
                "staleAfter": STALE_AFTER,
                "correlation_id": "00000000-0000-4000-8000-000000000906",
            }
        )


def _adapter(tmp_path, client: ProviderClient, *, provider_enabled: bool = True) -> PlanningAdapter:
    settings = IntegrationSettings(
        panel_planning_enabled=True,
        panel_planning_calendar_mutations_enabled=True,
        panel_planning_provider_calendar_mutations_enabled=provider_enabled,
        panel_planning_base_url="http://fixture.test",
        panel_planning_internal_secret="internal",
        panel_planning_secret="panel",
        panel_planning_cache_path=str(tmp_path / "planning-cache.json"),
        panel_planning_timezone="Europe/Moscow",
    )
    adapter = PlanningAdapter(settings, client=client)
    adapter._domains_current = True
    adapter._latest_upstream_sources = [_source()]
    adapter._project_sources(adapter._latest_upstream_sources)
    adapter._last_status = SimpleNamespace(
        storageStatus="available",
        planningHealth=None,
        capabilities=SimpleNamespace(events=["create", "update", "delete"]),
        providerCapabilities=SimpleNamespace(
            providerKind="icloud",
            readIntegrationEnabled=True,
            configured=True,
            writesEnabled=True,
            canCreateCalendar=True,
        ),
    )
    return adapter


def test_provider_bridge_uses_safe_ids_and_fixed_routes(tmp_path):
    client = ProviderClient()
    adapter = _adapter(tmp_path, client)
    app = FastAPI()
    app.include_router(build_planning_router(adapter))

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://panel.test") as http:
            destinations = await http.get("/api/v1/planning/calendar-destinations")
            safe_id = destinations.json()["items"][0]["id"]
            created = await http.post(
                "/api/v1/planning/provider-events",
                headers={"Idempotency-Key": "provider-create"},
                json={
                    "calendar_id": safe_id,
                    "title": "Новая встреча",
                    "notes": None,
                    "location": None,
                    "all_day": False,
                    "timezone": "Europe/Moscow",
                    "start_at_utc": "2026-08-12T12:00:00Z",
                    "end_at_utc": "2026-08-12T13:00:00Z",
                    "start_date": None,
                    "end_date_exclusive": None,
                },
            )
            edited = await http.patch(
                f"/api/v1/planning/provider-events/{EVENT_ID}",
                headers={"Idempotency-Key": "provider-edit", "If-Match": "1"},
                json={"title": "Обновлённая встреча"},
            )
            deleted = await http.delete(
                f"/api/v1/planning/provider-events/{EVENT_ID}",
                headers={"Idempotency-Key": "provider-delete", "If-Match": "2"},
            )
            new_calendar = await http.post(
                "/api/v1/planning/provider-calendars",
                headers={"Idempotency-Key": "calendar-create"},
                json={"display_name": "Новое", "color": "#123456"},
            )
            deleted_calendar = await http.delete(
                f"/api/v1/planning/provider-calendars/{new_calendar.json()['destination']['id']}",
                headers={"Idempotency-Key": "calendar-delete"},
            )
            return destinations, created, edited, deleted, new_calendar, deleted_calendar, safe_id

    destinations, created, edited, deleted, new_calendar, deleted_calendar, safe_id = asyncio.run(exercise())
    assert destinations.status_code == 200
    assert safe_id.startswith("calendar-") and RAW_CALENDAR_ID not in destinations.text
    assert created.status_code == 200 and edited.status_code == 200 and deleted.status_code == 200
    assert created.json()["object"]["canEdit"] is True and created.json()["object"]["canDelete"] is True
    assert new_calendar.status_code == 200 and deleted_calendar.status_code == 200
    assert RAW_CALENDAR_ID not in created.text
    assert "account_opaque" not in created.text
    assert client.calls[0] == ("create_provider_event", {
        "calendar_id": RAW_CALENDAR_ID,
        "title": "Новая встреча",
        "notes": None,
        "location": None,
        "all_day": False,
        "timezone": "Europe/Moscow",
        "start_at_utc": "2026-08-12T12:00:00Z",
        "end_at_utc": "2026-08-12T13:00:00Z",
        "start_date": None,
        "end_date_exclusive": None,
    })
    assert client.calls[-1] == ("delete_provider_calendar", RAW_NEW_CALENDAR_ID)


def test_missing_destination_route_is_bounded_and_does_not_disable_local_projection(tmp_path):
    client = ProviderClient()
    client.fail_destinations = True
    adapter = _adapter(tmp_path, client)

    async def exercise():
        return await adapter.read_calendar_destinations()

    envelope = asyncio.run(exercise())
    assert envelope.sourceStatus == "degraded"
    assert envelope.items == []
    assert envelope.capabilities.canCreateCalendar is False


def test_provider_bridge_honors_selected_destination_capabilities(tmp_path):
    client = ProviderClient()
    client.can_create_event = False
    client.can_delete_calendar = False
    adapter = _adapter(tmp_path, client)

    async def exercise():
        destinations = await adapter.read_calendar_destinations()
        safe_id = destinations.items[0].id
        with pytest.raises(PlanningUpstreamError, match="provider_read_only"):
            await adapter.create_provider_event(
                idempotency_key="provider-create-read-only",
                body={"calendar_id": safe_id},
            )
        with pytest.raises(PlanningUpstreamError, match="provider_read_only"):
            await adapter.delete_provider_calendar(
                calendar_id=safe_id,
                idempotency_key="calendar-delete-read-only",
            )

    asyncio.run(exercise())
    assert client.calls == []


def test_provider_destinations_remain_visible_but_non_writable_when_provider_gate_is_off(tmp_path):
    client = ProviderClient()
    adapter = _adapter(tmp_path, client, provider_enabled=False)

    envelope = asyncio.run(adapter.read_calendar_destinations())

    assert envelope.items[0].writeState == "read_only"
    assert envelope.items[0].canCreateEvent is False
    assert envelope.items[0].canDeleteCalendar is False
