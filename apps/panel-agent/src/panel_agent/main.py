from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from .alice_control import AliceControlError
from .contracts import (
    CoffeeActionRequest,
    CoffeeActionResponse,
    CoffeeNotificationPatch,
    CoffeeNotificationSettings,
    CoffeeTimingPatch,
    CoffeeTimingSettings,
    CalendarDisplayColorPatch,
    CalendarDisplayPreferencesResponse,
    CapabilityPatch,
    DashboardSnapshot,
    DiagnosticsReport,
    OverviewLayoutPatch,
    OverviewLayoutResponse,
    PanelMode,
    ServiceSnapshot,
)
from .fixtures import load_fixture_document, services_for_scenario
from .diagnostics import DiagnosticsCollector
from .integrations import IntegrationRuntime
from .planning_api import build_planning_router
from .runtime_control import router as runtime_control_router
from .settings import IntegrationSettings
from .snapshot import SnapshotPublisher
from .weather import WeatherService, build_weather_router
from .overview_layout import (
    MAX_REQUEST_BYTES,
    OverviewLayoutStore,
    OverviewLayoutValidationError,
    OverviewRevisionConflict,
)
from .calendar_display_preferences import (
    CalendarDisplayPreferencesConflict,
    CalendarDisplayPreferencesError,
    CalendarDisplayPreferencesStore,
)
from .build_capabilities import active_build_states
from .capabilities import (
    CAPABILITY_REGISTRY,
    CapabilityOverrideStore,
    CapabilityRevisionConflict,
    CapabilityStoreError,
)


def configured_mode() -> PanelMode:
    raw = os.getenv("PANEL_AGENT_MODE", "read_only")
    if raw not in {"fixtures", "read_only", "integration_test", "production"}:
        raise RuntimeError(f"Invalid PANEL_AGENT_MODE: {raw}")
    return raw  # type: ignore[return-value]


MODE = configured_mode()
SETTINGS = IntegrationSettings.from_env()
runtime = IntegrationRuntime(SETTINGS, mode=MODE)
weather_service = WeatherService(mode=MODE)
diagnostics_collector = DiagnosticsCollector(SETTINGS)
snapshot_publisher = SnapshotPublisher(
    mode=MODE,
    services_builder=runtime.services,
    planning_builder=runtime.planning_snapshot,
    heartbeat_seconds=SETTINGS.sse_heartbeat_seconds,
    on_snapshot=diagnostics_collector.observe,
)
runtime.set_snapshot_callback(snapshot_publisher.rebuild)
overview_layout_store = OverviewLayoutStore(
    SETTINGS.overview_layout_path,
    writes_enabled=SETTINGS.overview_layout_writes_enabled and SETTINGS.writes_enabled,
)
calendar_display_preferences_store = CalendarDisplayPreferencesStore(
    SETTINGS.calendar_display_color_path,
    writes_enabled=SETTINGS.calendar_display_color_writes_enabled and SETTINGS.writes_enabled,
)
capability_override_store = CapabilityOverrideStore()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if MODE not in {"fixtures", "integration_test"}:
        await runtime.start()
        await snapshot_publisher.rebuild()
    elif SETTINGS.panel_planning_enabled:
        await runtime.start_planning()
        await snapshot_publisher.rebuild()
    try:
        yield
    finally:
        await snapshot_publisher.close()
        await runtime.close()


app = FastAPI(
    title="Artem Control Center Panel Agent",
    version="0.2.0",
    lifespan=lifespan,
)
app.include_router(runtime_control_router)
app.include_router(build_weather_router(weather_service))
app.include_router(
    build_planning_router(
        runtime.planning,
        calendar_read_observer=diagnostics_collector.observe_calendar_read,
    )
)
app.include_router(
    build_planning_router(
        runtime.planning,
        prefix="/api/planning",
        calendar_read_observer=diagnostics_collector.observe_calendar_read,
    )
)
fixture_services: List[ServiceSnapshot] = []
revision = 1
fixture_coffee_state_override: str | None = None
fixture_timing = {
    "schemaVersion": 1,
    "source": "home-assistant",
    "transport": "alice-tg-bot",
    "revision": "fixture-timing-1",
    "observedAt": "2026-07-29T16:00:00Z",
    "warmupMinutes": 15,
    "longRunningMinutes": 60,
}
fixture_notifications = {
    "schemaVersion": 1,
    "source": "alice-tg-bot",
    "revision": "fixture-notifications-1",
    "updatedAt": "2026-07-29T16:00:00Z",
    "warmup": {
        "enabled": True,
        "channels": {"telegram": False, "iphone": True},
    },
    "longRunning": {
        "enabled": True,
        "channels": {"telegram": False, "iphone": True},
    },
}


@app.get("/health/live")
def live() -> dict:
    return {"ok": True, "service": "artem-panel-agent", "mode": MODE}


@app.get("/health/ready")
def ready() -> dict:
    return {
        "ok": True,
        "service": "artem-panel-agent",
        "mode": MODE,
        "writesEnabled": SETTINGS.writes_enabled,
        "overviewLayoutWritesEnabled": _overview_write_allowed(),
        "integrationsConfigured": {
            "homeAssistant": runtime.home_assistant.configured,
            "alice": bool(SETTINGS.alice_health_url),
            "avalarMain": bool(SETTINGS.avalar_main_url),
            "avalarStage": bool(SETTINGS.avalar_stage_url),
            "avalarSshDetails": runtime.avalar_ssh.enabled,
            "rogG703": SETTINGS.rog_g703_enabled,
            "weather": True,
            "planning": runtime.planning.enabled,
        },
    }


@app.get("/api/v1/fixtures")
def list_fixtures() -> dict:
    if MODE not in {"fixtures", "integration_test"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    document = load_fixture_document()
    return {"default": document["defaultScenario"], "scenarios": sorted(document["scenarios"].keys())}


@app.get("/api/v1/snapshot", response_model=DashboardSnapshot)
async def snapshot(
    response: Response,
    scenario: str = Query(default="ha-healthy"),
) -> DashboardSnapshot:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        document = load_fixture_document()
        try:
            services = services_for_scenario(scenario)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown fixture scenario")
        services.extend(fixture_services)
        for service in services:
            if service.id == "coffee-machine":
                machine = service.data.get("machine", {})
                if (
                    isinstance(machine, dict)
                    and fixture_coffee_state_override in {"on", "off"}
                ):
                    machine["state"] = fixture_coffee_state_override
                    machine["available"] = True
                    machine["stale"] = False
                    service.summary = (
                        "Включена"
                        if fixture_coffee_state_override == "on"
                        else "Выключена"
                    )
                machine_state = (
                    machine.get("state") if isinstance(machine, dict) else None
                )
                for action in service.actions:
                    action.enabled = bool(
                        _write_allowed(SETTINGS.coffee_actions_enabled)
                        and (
                            (
                                action.id == "home.coffee.turn_on"
                                and machine_state == "off"
                            )
                            or (
                                action.id == "home.coffee.turn_off"
                                and machine_state == "on"
                            )
                        )
                    )
        fixture_scenario = scenario
    else:
        current = snapshot_publisher.snapshot
        if current is None:
            current = await snapshot_publisher.rebuild()
        return current
    generated_at = (
        document["generatedAt"]
        if fixture_scenario
        else datetime.now(timezone.utc).isoformat()
    )
    return DashboardSnapshot(
        revision=revision,
        generatedAt=generated_at,
        mode=MODE,
        fixtureScenario=fixture_scenario,
        services=services,
        planning=runtime.planning_snapshot(),
    )


@app.get("/api/v1/diagnostics", response_model=DiagnosticsReport)
async def diagnostics(
    response: Response,
    scenario: str = Query(default="ha-healthy"),
) -> DiagnosticsReport:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        current = await snapshot(Response(), scenario)
    else:
        current = snapshot_publisher.snapshot
        if current is None:
            current = await snapshot_publisher.rebuild()
    return diagnostics_collector.report(current)


@app.get("/api/v1/overview/layout", response_model=OverviewLayoutResponse)
def get_overview_layout(response: Response) -> OverviewLayoutResponse:
    layout = overview_layout_store.read()
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = overview_layout_store.etag(layout.revision)
    response.headers["X-Overview-Layout-Writes-Enabled"] = str(_overview_write_allowed()).lower()
    return layout.model_copy(update={"writesEnabled": _overview_write_allowed()})


def _calendar_display_write_allowed() -> bool:
    return _write_allowed(_immediate_capability_enabled("calendar_display_colors"))


def _calendar_display_known_identities() -> set[tuple[str, str]]:
    projection = runtime.planning.projection
    if projection is None:
        return set()
    return {
        (source.id, calendar.id)
        for source in projection.providerStatuses
        for calendar in source.calendars
    }


@app.get(
    "/api/v1/settings/calendar/display-colors",
    response_model=CalendarDisplayPreferencesResponse,
)
def get_calendar_display_preferences(response: Response) -> CalendarDisplayPreferencesResponse:
    preferences = calendar_display_preferences_store.read()
    response.headers["Cache-Control"] = "no-store"
    return preferences.model_copy(update={"writesEnabled": _calendar_display_write_allowed()})


@app.patch(
    "/api/v1/settings/calendar/display-colors",
    response_model=CalendarDisplayPreferencesResponse,
)
def patch_calendar_display_preferences(
    patch: CalendarDisplayColorPatch,
    response: Response,
) -> CalendarDisplayPreferencesResponse:
    if not _calendar_display_write_allowed():
        raise HTTPException(status_code=403, detail="calendar_display_preferences_write_disabled")
    try:
        saved = calendar_display_preferences_store.write(
            provider_id=patch.providerId,
            calendar_id=patch.calendarId,
            color=patch.color,
            expected_revision=patch.expectedRevision,
            known_identities=_calendar_display_known_identities(),
        )
    except CalendarDisplayPreferencesConflict:
        raise HTTPException(status_code=409, detail="revision_conflict")
    except CalendarDisplayPreferencesError as exc:
        raise HTTPException(status_code=404 if str(exc) == "calendar_identity_unknown" else 422, detail=str(exc))
    response.headers["Cache-Control"] = "no-store"
    return saved.model_copy(update={"writesEnabled": _calendar_display_write_allowed()})


def _immediate_baseline(capability_id: str) -> bool:
    return {
        "calendar_display_colors": SETTINGS.calendar_display_color_writes_enabled,
        "overview_layout_editor": SETTINGS.overview_layout_writes_enabled,
    }[capability_id]


def _immediate_capability_enabled(capability_id: str) -> bool:
    document, available = capability_override_store.read()
    if not available:
        return _immediate_baseline(capability_id)
    return document["overrides"].get(capability_id, _immediate_baseline(capability_id))


def _read_only_capability_enabled(capability_id: str) -> bool:
    return {
        "v2_visual_shell": True,
        "overview_v2": True,
        "planning_mutations": SETTINGS.panel_planning_task_mutations_enabled,
        "touch_lock": True,
        "panel_writes": SETTINGS.writes_enabled,
        "avalar_actions": SETTINGS.avalar_actions_enabled,
    }[capability_id]


def _capability_inventory() -> dict:
    document, available = capability_override_store.read()
    overrides = document["overrides"] if available else {}
    active_build, baseline_build, build_available = active_build_states()
    entries = []
    for definition in CAPABILITY_REGISTRY:
        if definition.id in {"calendar_display_colors", "overview_layout_editor"}:
            baseline = _immediate_baseline(definition.id)
            effective = overrides.get(definition.id, baseline)
            active = desired = effective
        elif definition.id in active_build:
            active = active_build[definition.id]
            desired = overrides.get(definition.id, baseline_build[definition.id])
        else:
            active = desired = _read_only_capability_enabled(definition.id)
        blocked = "panel_writes_disabled" if definition.id in {"calendar_display_colors", "overview_layout_editor"} and desired and not SETTINGS.writes_enabled else None
        entries.append({
            "id": definition.id,
            "label": definition.label,
            "description": definition.description,
            "group": definition.group,
            "technicalFlag": definition.technical_flag,
            "activeEnabled": active,
            "desiredEnabled": desired,
            "pending": definition.behavior == "delayed" and active != desired,
            "mutable": definition.mutable,
            "behavior": definition.behavior,
            "requiredApplyAction": definition.apply_requirement,
            "operationalBlockedReason": blocked,
        })
    return {
        "schemaVersion": "capabilities.v1",
        "revision": document["revision"],
        "available": available and build_available,
        "writesEnabled": SETTINGS.writes_enabled,
        "warnings": ([] if available else ["capability_store_unavailable"]) + ([] if build_available else ["build_capabilities_unavailable"]),
        "entries": entries,
    }


@app.get("/api/v1/settings/capabilities")
def get_capabilities(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return _capability_inventory()


@app.patch("/api/v1/settings/capabilities")
def patch_capability(payload: CapabilityPatch, response: Response) -> dict:
    if not _capabilities_write_allowed():
        raise HTTPException(status_code=403, detail="capability_settings_write_disabled")
    try:
        capability_override_store.write(
            capability_id=payload.capabilityId,
            enabled=payload.enabled,
            expected_revision=payload.expectedRevision,
        )
    except CapabilityRevisionConflict:
        raise HTTPException(status_code=409, detail="revision_conflict")
    except CapabilityStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    response.headers["Cache-Control"] = "no-store"
    return _capability_inventory()


async def _read_bounded_overview_request_body(request: Request) -> bytes:
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            declared_bytes = int(declared_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes < 0:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="overview_layout_request_too_large")

    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="overview_layout_request_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def _parse_overview_layout_patch(raw_body: bytes) -> OverviewLayoutPatch:
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="invalid_json")
    try:
        return OverviewLayoutPatch.model_validate(payload)
    except ValidationError:
        raise HTTPException(status_code=422, detail="invalid_overview_layout_patch")


@app.patch("/api/v1/overview/layout", response_model=OverviewLayoutResponse)
async def patch_overview_layout(
    request: Request,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> OverviewLayoutResponse:
    raw_body = await _read_bounded_overview_request_body(request)
    _require_overview_write()
    expected_revision = OverviewLayoutStore.parse_if_match(if_match)
    if expected_revision is None:
        raise HTTPException(status_code=428, detail="if_match_required")
    patch = _parse_overview_layout_patch(raw_body)
    try:
        saved = overview_layout_store.write(patch, expected_revision)
    except OverviewRevisionConflict:
        current = overview_layout_store.read()
        response.headers["ETag"] = overview_layout_store.etag(current.revision)
        raise HTTPException(status_code=412, detail="revision_conflict")
    except OverviewLayoutValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = overview_layout_store.etag(saved.revision)
    return saved.model_copy(update={"writesEnabled": _overview_write_allowed()})


@app.get("/api/v1/events")
async def events(request: Request) -> StreamingResponse:
    async def stream():
        async for event in snapshot_publisher.event_stream(
            request.is_disconnected
        ):
            yield event

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/v1/fixtures/services", response_model=ServiceSnapshot, status_code=201)
def add_fixture_service(service: ServiceSnapshot) -> ServiceSnapshot:
    global revision
    if MODE not in {"fixtures", "integration_test"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if any(existing.id == service.id for existing in fixture_services):
        raise HTTPException(status_code=409, detail="Fixture service already exists")
    service.actions = []
    fixture_services.append(service)
    revision += 1
    return service


@app.get("/api/v1/settings/coffee/timing", response_model=CoffeeTimingSettings)
async def coffee_timing_settings(response: Response) -> CoffeeTimingSettings:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        payload, source_mode = dict(fixture_timing), "fixture"
    else:
        try:
            payload, source_mode = await runtime.alice_control.get_timing()
        except AliceControlError as exc:
            _raise_alice_error(exc)
    return CoffeeTimingSettings(
        **payload,
        sourceMode=source_mode,
        writesEnabled=_write_allowed(SETTINGS.coffee_timing_writes_enabled),
    )


@app.patch("/api/v1/settings/coffee/timing", response_model=CoffeeTimingSettings)
async def patch_coffee_timing_settings(
    patch: CoffeeTimingPatch,
    response: Response,
) -> CoffeeTimingSettings:
    _require_write(SETTINGS.coffee_timing_writes_enabled)
    if patch.warmupMinutes is None and patch.longRunningMinutes is None:
        raise HTTPException(status_code=400, detail="At least one timing value is required")
    payload = patch.model_dump(exclude_none=True)
    if MODE in {"fixtures", "integration_test"}:
        if patch.expectedRevision != fixture_timing["revision"]:
            raise HTTPException(status_code=409, detail="revision_conflict")
        if patch.warmupMinutes is not None:
            fixture_timing["warmupMinutes"] = patch.warmupMinutes
        if patch.longRunningMinutes is not None:
            fixture_timing["longRunningMinutes"] = patch.longRunningMinutes
        fixture_timing["revision"] = _next_fixture_revision(
            str(fixture_timing["revision"])
        )
        result, source_mode = dict(fixture_timing), "fixture"
    else:
        if not runtime.home_assistant.configured:
            raise HTTPException(status_code=503, detail="home_assistant_not_configured")
        try:
            result = await runtime.alice_control.patch_timing(payload)
            await runtime.home_assistant.fetch_initial_snapshot()
        except AliceControlError as exc:
            _raise_alice_error(exc)
        except Exception:
            raise HTTPException(status_code=503, detail="home_assistant_confirmation_failed")
        confirmation = runtime.home_assistant.coffee_confirmation()
        if (
            confirmation["warmupMinutes"] != result.get("warmupMinutes")
            or confirmation["longRunningMinutes"] != result.get("longRunningMinutes")
        ):
            raise HTTPException(status_code=503, detail="home_assistant_confirmation_failed")
        source_mode = "live"
        await snapshot_publisher.rebuild()
    response.headers["Cache-Control"] = "no-store"
    return CoffeeTimingSettings(
        **result,
        sourceMode=source_mode,
        writesEnabled=True,
    )


@app.get(
    "/api/v1/settings/notifications/coffee",
    response_model=CoffeeNotificationSettings,
)
async def coffee_notification_settings(response: Response) -> CoffeeNotificationSettings:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        payload, source_mode = dict(fixture_notifications), "fixture"
    else:
        try:
            payload, source_mode = await runtime.alice_control.get_notifications()
        except AliceControlError as exc:
            _raise_alice_error(exc)
    return CoffeeNotificationSettings(
        **payload,
        sourceMode=source_mode,
        writesEnabled=_write_allowed(
            SETTINGS.coffee_notification_writes_enabled
        ),
    )


@app.patch(
    "/api/v1/settings/notifications/coffee",
    response_model=CoffeeNotificationSettings,
)
async def patch_coffee_notification_settings(
    patch: CoffeeNotificationPatch,
    response: Response,
) -> CoffeeNotificationSettings:
    _require_write(SETTINGS.coffee_notification_writes_enabled)
    if patch.warmup is None and patch.longRunning is None:
        raise HTTPException(
            status_code=400,
            detail="At least one notification value is required",
        )
    payload = patch.model_dump(exclude_none=True)
    if MODE in {"fixtures", "integration_test"}:
        if patch.expectedRevision != fixture_notifications["revision"]:
            raise HTTPException(status_code=409, detail="revision_conflict")
        _apply_fixture_notification_patch(payload)
        fixture_notifications["revision"] = _next_fixture_revision(
            str(fixture_notifications["revision"])
        )
        result, source_mode = dict(fixture_notifications), "fixture"
    else:
        try:
            result = await runtime.alice_control.patch_notifications(payload)
        except AliceControlError as exc:
            _raise_alice_error(exc)
        source_mode = "live"
        await snapshot_publisher.rebuild()
    response.headers["Cache-Control"] = "no-store"
    return CoffeeNotificationSettings(
        **result,
        sourceMode=source_mode,
        writesEnabled=True,
    )


@app.post("/api/v1/actions/home/coffee", response_model=CoffeeActionResponse)
async def coffee_action(
    action: CoffeeActionRequest,
    response: Response,
) -> CoffeeActionResponse:
    global fixture_coffee_state_override, revision
    _require_write(SETTINGS.coffee_actions_enabled)
    if MODE in {"fixtures", "integration_test"}:
        fixture_coffee_state_override = (
            "on" if action.action == "turn_on" else "off"
        )
        revision += 1
        result = {
            "schemaVersion": 1,
            "authority": "home-assistant",
            "action": action.action,
            "requestId": action.requestId,
            "confirmedState": "on" if action.action == "turn_on" else "off",
            "alreadyInState": False,
            "observedAt": "2026-07-29T16:05:00Z",
        }
    else:
        if not runtime.home_assistant.coffee_action_allowed(action.action):
            raise HTTPException(status_code=403, detail="coffee_action_unavailable")
        try:
            result = await runtime.alice_control.coffee_action(action.model_dump())
            await runtime.home_assistant.fetch_initial_snapshot()
        except AliceControlError as exc:
            _raise_alice_error(exc)
        except Exception:
            raise HTTPException(status_code=503, detail="home_assistant_confirmation_failed")
        expected = "on" if action.action == "turn_on" else "off"
        if runtime.home_assistant.coffee_confirmation()["state"] != expected:
            raise HTTPException(status_code=503, detail="home_assistant_confirmation_failed")
        await snapshot_publisher.rebuild()
    response.headers["Cache-Control"] = "no-store"
    return CoffeeActionResponse(**result)


def _fixture_writes_enabled() -> bool:
    raw = os.getenv("PANEL_FIXTURE_WRITES_ENABLED", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _write_allowed(narrow_gate: bool) -> bool:
    return (
        MODE in {"fixtures", "integration_test", "production"}
        and (MODE != "fixtures" or _fixture_writes_enabled())
        and SETTINGS.writes_enabled
        and narrow_gate
    )


def _overview_write_allowed() -> bool:
    return _write_allowed(_immediate_capability_enabled("overview_layout_editor"))


def _capabilities_write_allowed() -> bool:
    return (
        MODE in {"fixtures", "integration_test", "production"}
        and (MODE != "fixtures" or _fixture_writes_enabled())
        and SETTINGS.writes_enabled
    )


def _require_write(narrow_gate: bool) -> None:
    if not _write_allowed(narrow_gate):
        raise HTTPException(status_code=403, detail="coffee_write_disabled")


def _require_overview_write() -> None:
    if not _overview_write_allowed():
        raise HTTPException(status_code=403, detail="overview_layout_write_disabled")


def _raise_alice_error(exc: AliceControlError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.code)


def _next_fixture_revision(current: str) -> str:
    prefix, number = current.rsplit("-", 1)
    return f"{prefix}-{int(number) + 1}"


def _apply_fixture_notification_patch(payload: dict) -> None:
    for event in ("warmup", "longRunning"):
        update = payload.get(event)
        if not isinstance(update, dict):
            continue
        target = fixture_notifications[event]
        if "enabled" in update:
            target["enabled"] = update["enabled"]
        channels = update.get("channels")
        if isinstance(channels, dict):
            target["channels"].update(channels)
