from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import ValidationError

from .alice_control import AliceControlError
from .contracts import (
    CoffeeActionRequest,
    CoffeeActionResponse,
    CoffeeDelayedStartRecord,
    CoffeeDelayedStartRequest,
    CoffeeDelayedStartResponse,
    CoffeeNotificationPatch,
    CoffeeNotificationSettings,
    CoffeeTimingPatch,
    CoffeeTimingSettings,
    CalendarDisplayColorPatch,
    CalendarDisplayPreferencesResponse,
    DeviceVisibilityPatch,
    DeviceVisibilitySettingsResponse,
    CapabilityPatch,
    DashboardSnapshot,
    DiagnosticsReport,
    OverviewLayoutPatch,
    OverviewLayoutResponse,
    PanelMode,
    ReminderDeliveryPatch,
    ReminderDeliverySettings,
    ServiceSnapshot,
    InterfaceCopyPatch,
    InterfaceCopySettingsResponse,
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
from .device_visibility import (
    DeviceVisibilityRevisionConflict,
    DeviceVisibilitySettingsStore,
    DeviceVisibilityStoreError,
)
from .build_capabilities import active_build_flags, active_build_states
from .capabilities import (
    CAPABILITY_REGISTRY,
    CapabilityOverrideStore,
    CapabilityRevisionConflict,
    CapabilityStoreError,
)
from .ai_settings import AIProviderSettingsStore
from .ai_text import AITextService
from .ai_api import build_ai_router
from .interface_copy import (
    FIXTURE_INTERFACE_COPY_SCENARIOS,
    InterfaceCopyRevisionConflict,
    InterfaceCopySettingsStore,
    InterfaceCopyStoreError,
    fixture_interface_copy_response,
)
from .coffee_diary import (
    MAX_REQUEST_BYTES as COFFEE_DIARY_MAX_REQUEST_BYTES,
    CoffeeDiaryBean,
    CoffeeDiaryBeanCreate,
    CoffeeDiaryBeanDetail,
    CoffeeDiaryBeanPatch,
    CoffeeDiaryCollection,
    CoffeeDiaryConflict,
    CoffeeDiaryFavoriteExtractionPatch,
    CoffeeDiaryExtraction,
    CoffeeDiaryExtractionCreate,
    CoffeeDiaryNotFound,
    CoffeeDiaryPhoto,
    CoffeeDiaryStore,
    CoffeeDiaryStoreUnavailable,
    CoffeeDiaryValidationError,
    validate_if_match,
    validate_idempotency_key,
    validate_uuid4,
)
from .coffee_diary_upload import (
    ACCEPTED_MEDIA_TYPES,
    MAX_UPLOAD_BYTES,
    NormalizedImage,
    PhotoStorage,
    PhotoUploadRegistry,
    UploadResolution,
    normalize_image,
)
from .coffee_delayed_start import (
    CoffeeDelayedStartError,
    CoffeeDelayedStartScheduler,
)
from .knowledge import KnowledgeReader, build_knowledge_router


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
ai_provider_settings_store = AIProviderSettingsStore(SETTINGS.ai_settings_path)
ai_text_service = AITextService(SETTINGS, ai_provider_settings_store)
interface_copy_store = InterfaceCopySettingsStore.from_environment(
    writes_enabled=SETTINGS.writes_enabled,
)
device_visibility_store = DeviceVisibilitySettingsStore(
    SETTINGS.device_visibility_path,
    writes_enabled=SETTINGS.writes_enabled,
)
coffee_diary_store = CoffeeDiaryStore.from_environment(writes_enabled=True)
coffee_photo_storage = PhotoStorage(cleanup_staged=True)
coffee_upload_registry = PhotoUploadRegistry(coffee_photo_storage)
knowledge_reader = KnowledgeReader()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if MODE not in {"fixtures", "integration_test"}:
        await runtime.start()
        await snapshot_publisher.rebuild()
    elif SETTINGS.panel_planning_enabled:
        await runtime.start_planning()
        await snapshot_publisher.rebuild()
    # Integration tests construct concurrent TestClients around this imported
    # app.  The production scheduler is process-owned, while direct scheduler
    # tests cover recovery and due execution with injected clocks; avoid
    # sharing one background task across independent test event loops.
    scheduler_started = MODE == "production"
    if scheduler_started:
        await coffee_delayed_start_scheduler.start()
    try:
        yield
    finally:
        if scheduler_started:
            await coffee_delayed_start_scheduler.close()
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
    build_ai_router(
        SETTINGS,
        ai_provider_settings_store,
        ai_text_service,
        planning_provider=lambda: runtime.planning.projection,
        writes_allowed=lambda: _ai_settings_write_allowed(),
    )
)
app.include_router(
    build_planning_router(
        runtime.planning,
        prefix="/api/planning",
        calendar_read_observer=diagnostics_collector.observe_calendar_read,
    )
)
app.include_router(build_knowledge_router(knowledge_reader))
fixture_services: List[ServiceSnapshot] = []
revision = 1
fixture_coffee_state_override: str | None = None
fixture_current_scenario = "ha-healthy"
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
fixture_reminder_delivery = {
    "schemaVersion": "reminder.delivery-settings.v1",
    "revision": 0,
    "updatedAt": "2026-07-29T16:00:00Z",
    "spokenEndpoint": "alice",
    "phoneChannels": ["telegram"],
    "channelHealth": {
        "spoken": {
            "alice": {"status": "available", "code": None},
            "jarvis": {"status": "unavailable", "code": "jarvis_runtime_unavailable"},
        },
        "phone": {
            "telegram": {"status": "available", "code": None},
            "home_assistant": {"status": "available", "code": None},
        },
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
            "aiText": SETTINGS.ai_text_enabled,
        },
    }


@app.get("/api/v1/fixtures")
def list_fixtures() -> dict:
    if MODE not in {"fixtures", "integration_test"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    document = load_fixture_document()
    return {
        "default": document["defaultScenario"],
        "scenarios": sorted(document["scenarios"].keys()),
        "interfaceCopyScenarios": list(FIXTURE_INTERFACE_COPY_SCENARIOS),
    }


def _fixture_snapshot_for_scenario(scenario: str) -> DashboardSnapshot:
    """Build one fixture snapshot without altering the active fixture scenario."""
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
    return DashboardSnapshot(
        revision=revision,
        generatedAt=document["generatedAt"],
        mode=MODE,
        fixtureScenario=scenario,
        services=services,
        planning=runtime.planning_snapshot(),
    )


@app.get("/api/v1/snapshot", response_model=DashboardSnapshot)
async def snapshot(
    response: Response,
    scenario: str = Query(default="ha-healthy"),
) -> DashboardSnapshot:
    global fixture_current_scenario
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        current = _fixture_snapshot_for_scenario(scenario)
        fixture_current_scenario = scenario
        return current
    else:
        current = snapshot_publisher.snapshot
        if current is None:
            current = await snapshot_publisher.rebuild()
        return current


@app.get("/api/v1/diagnostics", response_model=DiagnosticsReport)
async def diagnostics(
    response: Response,
    scenario: str | None = Query(default=None),
) -> DiagnosticsReport:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        current = _fixture_snapshot_for_scenario(scenario or fixture_current_scenario)
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


@app.get(
    "/api/v1/settings/interface-copy",
    response_model=InterfaceCopySettingsResponse,
)
def get_interface_copy(
    response: Response,
    fixtureScenario: str | None = Query(default=None),
) -> InterfaceCopySettingsResponse:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"} and fixtureScenario:
        fixture = fixture_interface_copy_response(fixtureScenario)
        if fixture is not None:
            response.headers["ETag"] = f'"{fixture.revision}"'
            return fixture
    settings = interface_copy_store.read()
    response.headers["ETag"] = f'"{settings.revision}"'
    response.headers["X-Interface-Copy-Writes-Enabled"] = str(_interface_copy_write_allowed()).lower()
    return settings.model_copy(update={"writesEnabled": _interface_copy_write_allowed()})


@app.patch(
    "/api/v1/settings/interface-copy",
    response_model=InterfaceCopySettingsResponse,
)
def patch_interface_copy(
    patch: InterfaceCopyPatch,
    response: Response,
) -> InterfaceCopySettingsResponse:
    if not _interface_copy_write_allowed():
        raise HTTPException(status_code=403, detail="interface_copy_write_disabled")
    try:
        saved = interface_copy_store.write(patch)
    except InterfaceCopyRevisionConflict:
        current = interface_copy_store.read()
        response.headers["ETag"] = f'"{current.revision}"'
        raise HTTPException(status_code=409, detail="revision_conflict")
    except InterfaceCopyStoreError as exc:
        if str(exc) == "stored_copy_settings_unavailable":
            raise HTTPException(status_code=503, detail=str(exc))
        raise HTTPException(status_code=422, detail=str(exc))
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{saved.revision}"'
    response.headers["X-Interface-Copy-Writes-Enabled"] = "true"
    return saved.model_copy(update={"writesEnabled": True})


def _calendar_display_write_allowed() -> bool:
    return _write_allowed(_immediate_capability_enabled("calendar_display_colors"))


def _ai_settings_write_allowed() -> bool:
    return _write_allowed(SETTINGS.ai_settings_writes_enabled and SETTINGS.ai_text_enabled)


def _interface_copy_write_allowed() -> bool:
    return _write_allowed(True)


def _device_visibility_write_allowed() -> bool:
    return _write_allowed(True)


@app.get(
    "/api/v1/settings/device-visibility",
    response_model=DeviceVisibilitySettingsResponse,
)
def get_device_visibility(response: Response) -> DeviceVisibilitySettingsResponse:
    settings = device_visibility_store.read()
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{settings.revision}"'
    response.headers["X-Device-Visibility-Writes-Enabled"] = str(_device_visibility_write_allowed()).lower()
    return settings.model_copy(update={"writesEnabled": _device_visibility_write_allowed()})


@app.patch(
    "/api/v1/settings/device-visibility",
    response_model=DeviceVisibilitySettingsResponse,
)
def patch_device_visibility(
    patch: DeviceVisibilityPatch,
    response: Response,
) -> DeviceVisibilitySettingsResponse:
    if not _device_visibility_write_allowed():
        raise HTTPException(status_code=403, detail="device_visibility_write_disabled")
    try:
        saved = device_visibility_store.write(patch)
    except DeviceVisibilityRevisionConflict:
        current = device_visibility_store.read()
        response.headers["ETag"] = f'"{current.revision}"'
        raise HTTPException(status_code=409, detail="revision_conflict")
    except DeviceVisibilityStoreError as exc:
        status_code = 503 if str(exc) == "stored_device_visibility_unavailable" else 422
        raise HTTPException(status_code=status_code, detail=str(exc))
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{saved.revision}"'
    response.headers["X-Device-Visibility-Writes-Enabled"] = "true"
    return saved.model_copy(update={"writesEnabled": True})


async def _read_bounded_coffee_diary_body(request: Request) -> bytes:
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            declared_bytes = int(declared_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes < 0:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes > COFFEE_DIARY_MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="coffee_diary_request_too_large")
    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > COFFEE_DIARY_MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="coffee_diary_request_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


async def _stream_bounded_photo_body(request: Request, destination) -> int:
    declared = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if declared not in ACCEPTED_MEDIA_TYPES:
        raise CoffeeDiaryValidationError("coffee_diary_upload_media_type_invalid")
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            length = int(declared_length)
        except ValueError as exc:
            raise CoffeeDiaryValidationError("coffee_diary_upload_file_too_large") from exc
        if length < 1 or length > MAX_UPLOAD_BYTES:
            raise CoffeeDiaryValidationError("coffee_diary_upload_file_too_large")
    total = 0
    with destination.open("wb") as handle:
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise CoffeeDiaryValidationError("coffee_diary_upload_file_too_large")
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if total == 0:
        raise CoffeeDiaryValidationError("coffee_diary_upload_image_invalid")
    return total


def _coffee_upload_origin(request: Request) -> str:
    configured = os.getenv("PANEL_COFFEE_DIARY_UPLOAD_ORIGIN", "").strip()
    candidate = configured or f"{request.url.scheme}://{request.headers.get('host', '')}"
    parsed = urlsplit(candidate)
    try:
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="coffee_diary_upload_origin_invalid") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or port is None and ":" in parsed.netloc.rsplit("]", 1)[-1]
    ):
        raise HTTPException(status_code=500, detail="coffee_diary_upload_origin_invalid")
    return f"{parsed.scheme}://{parsed.netloc}"


def _coffee_upload_session_response(request: Request, response: Response, session, token: str) -> dict[str, object]:
    response.headers["Cache-Control"] = "no-store"
    return {
        "sessionId": str(session.session_id),
        "state": session.state,
        "expiresAt": session.expires_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "remainingSeconds": max(0, int(session.deadline - time.monotonic())),
        "uploadUrl": f"{_coffee_upload_origin(request)}/coffee-upload#token={quote(token, safe='-_')}",
        "pendingAttachmentId": None,
        "photoId": None,
    }


def _parse_coffee_diary_payload(raw_body: bytes, model_type):
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="invalid_json")
    try:
        return model_type.model_validate(payload)
    except ValidationError as exc:
        for code in (
            "coffee_diary_grams_invalid",
            "coffee_diary_grams_precision_invalid",
            "coffee_diary_preferred_drink_invalid",
            "coffee_diary_extraction_belongs_to_another_bean",
            "coffee_diary_favorite_extraction_required",
            "coffee_diary_favorite_extraction_invalid",
        ):
            if code in str(exc):
                raise HTTPException(status_code=422, detail=code)
        raise HTTPException(status_code=422, detail="invalid_coffee_diary_request")


def _require_coffee_diary_write() -> None:
    if not _write_allowed(True):
        raise HTTPException(status_code=403, detail="coffee_diary_write_disabled")


_COFFEE_DIARY_PUBLIC_CODES = {
    "coffee_diary_conflict",
    "coffee_diary_id_invalid",
    "coffee_diary_idempotency_key_reused",
    "coffee_diary_store_not_canonical",
    "coffee_diary_store_oversized",
    "coffee_diary_store_lock_busy",
    "coffee_diary_store_unavailable",
    "coffee_diary_store_write_failed",
    "coffee_diary_bean_not_found",
    "coffee_diary_extraction_not_found",
    "coffee_diary_not_found",
    "coffee_diary_extraction_belongs_to_another_bean",
    "coffee_diary_favorite_extraction_required",
    "coffee_diary_favorite_extraction_invalid",
    "coffee_diary_grams_invalid",
    "coffee_diary_grams_precision_invalid",
    "coffee_diary_photo_storage_id_invalid",
    "coffee_diary_photo_relationship_invalid",
    "coffee_diary_preferred_drink_invalid",
    "coffee_diary_relationship_duplicate_id",
    "coffee_diary_too_many_beans",
    "coffee_diary_too_many_extractions",
    "coffee_diary_write_disabled",
    "coffee_diary_upload_token_invalid",
    "coffee_diary_upload_token_expired",
    "coffee_diary_upload_token_consumed",
    "coffee_diary_upload_token_cancelled",
    "coffee_diary_upload_attempts_exhausted",
    "coffee_diary_upload_in_progress",
    "coffee_diary_upload_file_too_large",
    "coffee_diary_upload_media_type_invalid",
    "coffee_diary_upload_image_invalid",
    "coffee_diary_upload_dimensions_invalid",
    "coffee_diary_upload_target_not_found",
    "coffee_diary_upload_staged_attachment_invalid",
    "coffee_diary_upload_sessions_full",
    "coffee_diary_upload_session_not_found",
    "coffee_diary_staged_attachment_not_found",
    "coffee_diary_photo_file_missing",
    "coffee_diary_export_too_large",
    "coffee_diary_upload_origin_invalid",
    "if_match_invalid",
    "if_match_required",
    "idempotency_key_invalid",
    "idempotency_key_required",
    "revision_conflict",
}


def _safe_coffee_diary_code(value: object, fallback: str) -> str:
    candidate = str(value)
    return candidate if candidate in _COFFEE_DIARY_PUBLIC_CODES else fallback


def _coffee_diary_error(exc: Exception) -> None:
    if isinstance(exc, CoffeeDiaryStoreUnavailable):
        raise HTTPException(status_code=503, detail=_safe_coffee_diary_code(exc.code, "coffee_diary_store_unavailable"))
    if isinstance(exc, CoffeeDiaryConflict):
        raise HTTPException(status_code=409, detail=_safe_coffee_diary_code(exc, "coffee_diary_conflict"))
    if isinstance(exc, CoffeeDiaryNotFound):
        raise HTTPException(status_code=404, detail=_safe_coffee_diary_code(exc, "coffee_diary_not_found"))
    if isinstance(exc, CoffeeDiaryValidationError):
        code = _safe_coffee_diary_code(exc, "coffee_diary_validation_failed")
        if code == "coffee_diary_write_disabled":
            raise HTTPException(status_code=403, detail=code)
        if code in {"if_match_required", "idempotency_key_required"}:
            raise HTTPException(status_code=428, detail=code)
        raise HTTPException(status_code=422, detail=code)
    raise HTTPException(status_code=500, detail="coffee_diary_unavailable")


def _coffee_upload_error(exc: Exception) -> None:
    code = str(getattr(exc, "code", exc))
    if code == "coffee_diary_upload_token_invalid":
        raise HTTPException(status_code=403, detail=code)
    if code in {"coffee_diary_upload_token_expired", "coffee_diary_upload_token_cancelled"}:
        raise HTTPException(status_code=410, detail=code)
    if code == "coffee_diary_upload_token_consumed":
        raise HTTPException(status_code=409, detail=code)
    if code == "coffee_diary_upload_in_progress":
        raise HTTPException(status_code=409, detail=code)
    if code == "coffee_diary_upload_file_too_large":
        raise HTTPException(status_code=413, detail=code)
    if code == "coffee_diary_upload_sessions_full":
        raise HTTPException(status_code=429, detail=code)
    if code in {"coffee_diary_upload_session_not_found", "coffee_diary_staged_attachment_not_found", "coffee_diary_upload_target_not_found"}:
        raise HTTPException(status_code=404, detail=code)
    if isinstance(exc, CoffeeDiaryNotFound):
        raise HTTPException(status_code=404, detail=code)
    if isinstance(exc, CoffeeDiaryStoreUnavailable):
        raise HTTPException(status_code=503, detail=_safe_coffee_diary_code(code, "coffee_diary_store_unavailable"))
    if isinstance(exc, CoffeeDiaryValidationError):
        raise HTTPException(status_code=422, detail=_safe_coffee_diary_code(code, "coffee_diary_upload_image_invalid"))
    raise HTTPException(status_code=500, detail="coffee_diary_upload_unavailable")


@app.get("/api/v1/coffee-diary", response_model=CoffeeDiaryCollection)
def get_coffee_diary() -> CoffeeDiaryCollection:
    try:
        return coffee_diary_store.collection()
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")


@app.get("/api/v1/coffee-diary/beans/{bean_id}", response_model=CoffeeDiaryBeanDetail)
def get_coffee_diary_bean(bean_id: str) -> CoffeeDiaryBeanDetail:
    try:
        return coffee_diary_store.bean_detail(validate_uuid4(bean_id))
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")


@app.post("/api/v1/coffee-diary/beans/{bean_id}/photo-upload-sessions")
def create_coffee_diary_photo_upload_session(bean_id: str, request: Request, response: Response) -> dict[str, object]:
    _require_coffee_diary_write()
    try:
        parsed_bean_id = validate_uuid4(bean_id)
        coffee_diary_store.bean_detail(parsed_bean_id)
        session, token = coffee_upload_registry.create(intent="bean", bean_id=parsed_bean_id)
        return _coffee_upload_session_response(request, response, session, token)
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        if isinstance(exc, CoffeeDiaryNotFound):
            raise HTTPException(status_code=404, detail="coffee_diary_upload_target_not_found")
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.post("/api/v1/coffee-diary/photo-upload-sessions")
async def create_coffee_diary_staged_upload_session(request: Request, response: Response) -> dict[str, object]:
    _require_coffee_diary_write()
    raw_body = await _read_bounded_coffee_diary_body(request)
    try:
        payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc
    if not isinstance(payload, dict) or set(payload) - {"intent"} or payload.get("intent", "bean_create") != "bean_create":
        raise HTTPException(status_code=422, detail="coffee_diary_upload_staged_attachment_invalid")
    try:
        session, token = coffee_upload_registry.create(intent="bean_create", bean_id=None)
        return _coffee_upload_session_response(request, response, session, token)
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.get("/api/v1/coffee-diary/photo-upload-sessions/{session_id}")
def get_coffee_diary_photo_upload_session(session_id: str, response: Response) -> dict[str, object]:
    _require_coffee_diary_write()
    response.headers["Cache-Control"] = "no-store"
    try:
        return coffee_upload_registry.status(validate_uuid4(session_id))
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.delete("/api/v1/coffee-diary/photo-upload-sessions/{session_id}")
def cancel_coffee_diary_photo_upload_session(session_id: str, request: Request, response: Response) -> dict[str, object]:
    _require_coffee_diary_write()
    response.headers["Cache-Control"] = "no-store"
    try:
        return coffee_upload_registry.cancel(validate_uuid4(session_id))
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.delete("/api/v1/coffee-diary/pending-photo-attachments/{pending_id}", status_code=204)
def discard_coffee_diary_pending_photo(pending_id: str, request: Request) -> Response:
    _require_coffee_diary_write()
    try:
        coffee_upload_registry.discard_pending(validate_uuid4(pending_id))
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@app.get("/api/v1/coffee-diary/pending-photo-attachments/{pending_id}/content")
def get_coffee_diary_pending_photo_content(pending_id: str) -> FileResponse:
    _require_coffee_diary_write()
    try:
        attachment = coffee_upload_registry.pending_content(validate_uuid4(pending_id))
        return FileResponse(
            attachment.path,
            media_type=attachment.media_type,
            headers={
                "Cache-Control": "no-store",
                "Content-Length": str(attachment.byte_size),
                "X-Content-Type-Options": "nosniff",
            },
        )
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.post("/api/v1/coffee-diary/photo-upload")
async def upload_coffee_diary_photo(request: Request, response: Response) -> dict[str, object]:
    token = request.headers.get("X-Coffee-Upload-Token")
    decision = coffee_upload_registry.resolve_upload(token or "")
    if decision.resolution in {UploadResolution.TERMINAL_UPLOADED, UploadResolution.TERMINAL_CONSUMED}:
        if decision.terminal_result is None:
            _coffee_upload_error(CoffeeDiaryValidationError("coffee_diary_upload_token_invalid"))
            raise AssertionError("unreachable")
        response.headers.update({"Cache-Control": "no-store"})
        return decision.terminal_result
    if decision.resolution != UploadResolution.BEGIN_NEW_UPLOAD or decision.session is None:
        resolution_errors = {
            UploadResolution.INVALID: "coffee_diary_upload_token_invalid",
            UploadResolution.EXPIRED: "coffee_diary_upload_token_expired",
            UploadResolution.CANCELLED: "coffee_diary_upload_token_cancelled",
            UploadResolution.IN_PROGRESS: "coffee_diary_upload_in_progress",
        }
        _coffee_upload_error(CoffeeDiaryValidationError(resolution_errors.get(decision.resolution, "coffee_diary_upload_token_invalid")))
        raise AssertionError("unreachable")
    session = decision.session

    upload_path = None
    normalized: NormalizedImage | None = None
    try:
        upload_path = coffee_photo_storage.new_temp_file()
        try:
            await _stream_bounded_photo_body(request, upload_path)
            normalized = normalize_image(upload_path, request.headers.get("content-type", ""), coffee_photo_storage)
        except CoffeeDiaryValidationError as exc:
            code = str(exc)
            if code.startswith("coffee_diary_upload_"):
                coffee_upload_registry.invalid_attempt(session.session_id)
            else:
                coffee_upload_registry.fail_upload(session.session_id)
            _coffee_upload_error(exc)
            raise AssertionError("unreachable")

        if session.intent == "bean":
            if session.bean_id is None:
                coffee_upload_registry.fail_upload(session.session_id)
                raise HTTPException(status_code=422, detail="coffee_diary_upload_target_not_found")
            finalized = normalized
            storage_id, final_path = coffee_photo_storage.move_normalized_to_final(finalized)
            normalized = None
            photo = CoffeeDiaryPhoto(
                id=uuid4(),
                beanId=session.bean_id,
                storageId=storage_id,
                mediaType=finalized.media_type,
                byteSize=finalized.byte_size,
                width=finalized.width,
                height=finalized.height,
                sha256=finalized.sha256,
                createdAt=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            )
            try:
                coffee_diary_store.attach_photo(session.bean_id, photo)
            except Exception:
                coffee_photo_storage.remove(final_path)
                coffee_upload_registry.fail_upload(session.session_id)
                raise
            coffee_upload_registry.finish_existing(session.session_id, photo.id)
            response.headers.update({"Cache-Control": "no-store"})
            return {"state": "consumed", "photoId": str(photo.id), "pendingAttachmentId": None}

        pending_id, _ = coffee_upload_registry.finish_staged(session.session_id, normalized)
        normalized = None
        response.headers.update({"Cache-Control": "no-store"})
        return {"state": "uploaded", "photoId": None, "pendingAttachmentId": str(pending_id)}
    except HTTPException:
        raise
    except Exception as exc:
        coffee_upload_registry.fail_upload(session.session_id)
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")
    finally:
        if upload_path is not None:
            coffee_photo_storage.remove(upload_path)
        if normalized is not None:
            coffee_photo_storage.remove(normalized.path)


@app.get("/api/v1/coffee-diary/photos/{photo_id}/content")
def get_coffee_diary_photo_content(photo_id: str) -> FileResponse:
    try:
        parsed_photo_id = validate_uuid4(photo_id)
        document = coffee_diary_store.read_document()
        photo = next((candidate for candidate in document.photos if candidate.id == parsed_photo_id and candidate.deletedAt is None), None)
        if photo is None:
            raise CoffeeDiaryNotFound("coffee_diary_photo_file_missing")
        path = coffee_photo_storage.final_path(photo.storageId)
        if not path.is_file():
            raise CoffeeDiaryNotFound("coffee_diary_photo_file_missing")
        return FileResponse(
            path,
            media_type=photo.mediaType,
            headers={
                "Cache-Control": "private, max-age=3600",
                "ETag": f'"{photo.sha256}"',
                "X-Content-Type-Options": "nosniff",
                "Content-Length": str(photo.byteSize),
            },
        )
    except Exception as exc:
        _coffee_upload_error(exc)
        raise AssertionError("unreachable")


@app.post("/api/v1/coffee-diary/beans", response_model=CoffeeDiaryBean, status_code=201)
async def post_coffee_diary_bean(request: Request, response: Response) -> CoffeeDiaryBean:
    _require_coffee_diary_write()
    raw_body = await _read_bounded_coffee_diary_body(request)
    payload = _parse_coffee_diary_payload(raw_body, CoffeeDiaryBeanCreate)
    prepared = []
    try:
        key = validate_idempotency_key(request.headers.get("Idempotency-Key"))
        def prepare_pending(bean_id: UUID, pending_ids) -> list[CoffeeDiaryPhoto]:
            prepared.clear()
            prepared.extend(coffee_upload_registry.prepare_pending(pending_ids, bean_id))
            return [item.photo for item in prepared]

        result = coffee_diary_store.create_bean(
            payload,
            key,
            prepare_pending=prepare_pending,
            rollback_pending=lambda: coffee_upload_registry.rollback_prepared(prepared),
            finalize_pending=lambda: coffee_upload_registry.finalize_prepared(prepared),
        )
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.patch("/api/v1/coffee-diary/beans/{bean_id}/favorite-extraction", response_model=CoffeeDiaryBean)
async def patch_coffee_diary_favorite_extraction(bean_id: str, request: Request, response: Response) -> CoffeeDiaryBean:
    _require_coffee_diary_write()
    raw_body = await _read_bounded_coffee_diary_body(request)
    payload = _parse_coffee_diary_payload(raw_body, CoffeeDiaryFavoriteExtractionPatch)
    try:
        result = coffee_diary_store.set_favorite_extraction(
            validate_uuid4(bean_id), payload.extractionId, validate_if_match(request.headers.get("If-Match")),
        )
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.patch("/api/v1/coffee-diary/beans/{bean_id}", response_model=CoffeeDiaryBean)
async def patch_coffee_diary_bean(bean_id: str, request: Request, response: Response) -> CoffeeDiaryBean:
    _require_coffee_diary_write()
    raw_body = await _read_bounded_coffee_diary_body(request)
    payload = _parse_coffee_diary_payload(raw_body, CoffeeDiaryBeanPatch)
    try:
        result = coffee_diary_store.patch_bean(validate_uuid4(bean_id), payload, validate_if_match(request.headers.get("If-Match")))
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.delete("/api/v1/coffee-diary/beans/{bean_id}", response_model=CoffeeDiaryBean)
def delete_coffee_diary_bean(bean_id: str, request: Request, response: Response) -> CoffeeDiaryBean:
    _require_coffee_diary_write()
    try:
        result = coffee_diary_store.delete_bean(validate_uuid4(bean_id), validate_if_match(request.headers.get("If-Match")))
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.post("/api/v1/coffee-diary/beans/{bean_id}/extractions", response_model=CoffeeDiaryExtraction, status_code=201)
async def post_coffee_diary_extraction(bean_id: str, request: Request, response: Response) -> CoffeeDiaryExtraction:
    _require_coffee_diary_write()
    raw_body = await _read_bounded_coffee_diary_body(request)
    payload = _parse_coffee_diary_payload(raw_body, CoffeeDiaryExtractionCreate)
    try:
        key = validate_idempotency_key(request.headers.get("Idempotency-Key"))
        result = coffee_diary_store.create_extraction(validate_uuid4(bean_id), payload, key)
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.delete("/api/v1/coffee-diary/extractions/{extraction_id}", response_model=CoffeeDiaryExtraction)
def delete_coffee_diary_extraction(extraction_id: str, request: Request, response: Response) -> CoffeeDiaryExtraction:
    _require_coffee_diary_write()
    try:
        result = coffee_diary_store.delete_extraction(validate_uuid4(extraction_id), validate_if_match(request.headers.get("If-Match")))
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{result.version}"'
    return result


@app.get("/api/v1/coffee-diary/export")
def export_coffee_diary() -> Response:
    try:
        content = coffee_diary_store.export_bytes()
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    return Response(
        content=content,
        media_type="application/json",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="coffee-diary.json"',
        },
    )


@app.get("/api/v1/coffee-diary/export.csv")
def export_coffee_diary_csv() -> Response:
    try:
        content = coffee_diary_store.export_csv_bytes()
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    return Response(
        content=content,
        media_type="text/csv",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="coffee-diary-extractions.csv"',
        },
    )


@app.get("/api/v1/coffee-diary/export.zip")
def export_coffee_diary_zip() -> FileResponse:
    try:
        archive_path = coffee_diary_store.export_zip_path(coffee_photo_storage.root)
    except Exception as exc:
        _coffee_diary_error(exc)
        raise AssertionError("unreachable")
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename="coffee-diary.zip",
        headers={"Cache-Control": "no-store"},
        background=BackgroundTask(lambda: archive_path.unlink(missing_ok=True)),
    )


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


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    return default if not raw else raw in {"1", "true", "yes", "on"}


def _immediate_capability_enabled(capability_id: str) -> bool:
    document, available = capability_override_store.read()
    if not available:
        return _immediate_baseline(capability_id)
    return document["overrides"].get(capability_id, _immediate_baseline(capability_id))


def _read_only_capability_enabled(capability_id: str) -> bool:
    return {
        "planning_integration": SETTINGS.panel_planning_enabled,
        "ai_text": SETTINGS.ai_text_enabled,
        "ai_provider_settings": SETTINGS.ai_settings_writes_enabled,
        "ai_local_fallback": SETTINGS.ai_local_enabled,
        "planning_reminder_mutations": SETTINGS.panel_planning_reminder_mutations_enabled,
        "planning_task_mutations": SETTINGS.panel_planning_task_mutations_enabled,
        "planning_calendar_mutations": SETTINGS.panel_planning_calendar_mutations_enabled,
        "panel_writes": SETTINGS.writes_enabled,
        "coffee_timing_writes": SETTINGS.coffee_timing_writes_enabled,
        "coffee_notification_writes": SETTINGS.coffee_notification_writes_enabled,
        "coffee_actions": SETTINGS.coffee_actions_enabled,
        "avalar_ssh": SETTINGS.avalar_ssh_enabled,
        "avalar_actions": SETTINGS.avalar_actions_enabled,
        "avalar_smoke": SETTINGS.avalar_smoke_enabled,
        "avalar_stage_restart": SETTINGS.avalar_stage_restart_enabled,
        "avalar_main_restart": SETTINGS.avalar_main_restart_enabled,
        "avalar_stage_deploy": SETTINGS.avalar_stage_deploy_enabled,
        "avalar_main_deploy": SETTINGS.avalar_main_deploy_enabled,
        "rog_g703": SETTINGS.rog_g703_enabled,
        "kiosk_controls": _bool_env("PANEL_KIOSK_CONTROLS_ENABLED"),
        "panel_update_controls": _bool_env("PANEL_UPDATE_CONTROLS_ENABLED"),
    }[capability_id]


def _capability_inventory() -> dict:
    document, available = capability_override_store.read()
    overrides = document["overrides"] if available else {}
    active_build, baseline_build, build_available = active_build_states()
    build_flags, flags_available = active_build_flags()
    entries = []
    for definition in CAPABILITY_REGISTRY:
        configured = None
        if definition.id in {"calendar_display_colors", "overview_layout_editor"}:
            configured = _immediate_baseline(definition.id)
            effective = overrides.get(definition.id, configured)
            active = desired = effective
        elif definition.id in active_build:
            configured = baseline_build[definition.id]
            active = active_build[definition.id]
            desired = overrides.get(definition.id, configured)
        elif definition.technical_flag.startswith("VITE_"):
            active = desired = build_flags[definition.technical_flag]
        else:
            active = desired = _read_only_capability_enabled(definition.id)
        blocked = "panel_writes_disabled" if definition.id in {"calendar_display_colors", "overview_layout_editor"} and desired and not SETTINGS.writes_enabled else None
        entry = {
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
        }
        if definition.mutable:
            entry["configuredEnabled"] = configured
            entry["overrideEnabled"] = overrides.get(definition.id)
        entries.append(entry)
    return {
        "schemaVersion": "capabilities.v1",
        "revision": document["revision"],
        "available": available and build_available and flags_available,
        "writesEnabled": SETTINGS.writes_enabled,
        "warnings": (
            ([] if available else ["capability_store_unavailable"])
            + ([] if build_available and flags_available else ["build_capabilities_unavailable"])
        ),
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


def _fixture_coffee_machine_state() -> str | None:
    try:
        service = next(
            item
            for item in services_for_scenario(fixture_current_scenario)
            if item.id == "coffee-machine"
        )
    except (KeyError, StopIteration):
        return None
    machine = service.data.get("machine", {})
    state = machine.get("state") if isinstance(machine, dict) else None
    return fixture_coffee_state_override if fixture_coffee_state_override in {"on", "off"} else state


def _coffee_machine_state() -> str | None:
    if MODE in {"fixtures", "integration_test"}:
        return _fixture_coffee_machine_state()
    return runtime.home_assistant.coffee_confirmation().get("state")


def _coffee_schedule_authority_available() -> bool:
    if not _write_allowed(SETTINGS.coffee_actions_enabled):
        return False
    if MODE in {"fixtures", "integration_test"}:
        try:
            service = next(
                item
                for item in services_for_scenario(fixture_current_scenario)
                if item.id == "coffee-machine"
            )
        except (KeyError, StopIteration):
            return False
        machine = service.data.get("machine", {})
        return bool(
            isinstance(machine, dict)
            and machine.get("available") is True
            and machine.get("stale") is False
            and _coffee_machine_state() == "off"
        )
    return runtime.home_assistant.coffee_action_allowed("turn_on")


async def _execute_fixed_coffee_turn_on(request_id: str) -> dict:
    """Execute the exact verified turn-on path shared by manual and due control."""
    global fixture_coffee_state_override, revision
    if not _coffee_schedule_authority_available():
        raise CoffeeDelayedStartError("coffee_action_unavailable")
    if MODE in {"fixtures", "integration_test"}:
        fixture_coffee_state_override = "on"
        revision += 1
        return {
            "schemaVersion": 1,
            "authority": "home-assistant",
            "action": "turn_on",
            "requestId": request_id,
            "confirmedState": "on",
            "alreadyInState": False,
            "observedAt": "2026-07-29T16:05:00Z",
        }
    try:
        result = await runtime.alice_control.coffee_action(
            {"action": "turn_on", "requestId": request_id}
        )
        await runtime.home_assistant.fetch_initial_snapshot()
    except AliceControlError as exc:
        raise CoffeeDelayedStartError(exc.code) from exc
    except Exception as exc:
        raise CoffeeDelayedStartError("home_assistant_confirmation_failed") from exc
    if runtime.home_assistant.coffee_confirmation()["state"] != "on":
        raise CoffeeDelayedStartError("home_assistant_confirmation_failed")
    await snapshot_publisher.rebuild()
    return result


def _coffee_delayed_start_response() -> CoffeeDelayedStartResponse:
    record = coffee_delayed_start_scheduler.read()
    return CoffeeDelayedStartResponse(
        schedule=CoffeeDelayedStartRecord.model_validate(record) if record else None,
        available=_coffee_schedule_authority_available(),
        writesEnabled=_write_allowed(SETTINGS.coffee_actions_enabled),
    )


@app.get(
    "/api/v1/actions/home/coffee/delayed-start",
    response_model=CoffeeDelayedStartResponse,
)
async def get_coffee_delayed_start(response: Response) -> CoffeeDelayedStartResponse:
    await coffee_delayed_start_scheduler.reconcile()
    response.headers["Cache-Control"] = "no-store"
    return _coffee_delayed_start_response()


@app.post(
    "/api/v1/actions/home/coffee/delayed-start",
    response_model=CoffeeDelayedStartResponse,
)
async def create_coffee_delayed_start(
    payload: CoffeeDelayedStartRequest,
    response: Response,
) -> CoffeeDelayedStartResponse:
    _require_write(SETTINGS.coffee_actions_enabled)
    try:
        await coffee_delayed_start_scheduler.create_or_replace(
            payload.delayMinutes,
            payload.requestId,
        )
    except CoffeeDelayedStartError as exc:
        raise HTTPException(status_code=403, detail=exc.code)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="coffee_delayed_start_unavailable") from exc
    response.headers["Cache-Control"] = "no-store"
    return _coffee_delayed_start_response()


@app.delete(
    "/api/v1/actions/home/coffee/delayed-start",
    response_model=CoffeeDelayedStartResponse,
)
async def cancel_coffee_delayed_start(response: Response) -> CoffeeDelayedStartResponse:
    _require_write(SETTINGS.coffee_actions_enabled)
    try:
        await coffee_delayed_start_scheduler.cancel()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="coffee_delayed_start_unavailable") from exc
    response.headers["Cache-Control"] = "no-store"
    return _coffee_delayed_start_response()


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


@app.get("/api/v1/settings/reminders/delivery", response_model=ReminderDeliverySettings)
async def reminder_delivery_settings(response: Response) -> ReminderDeliverySettings:
    response.headers["Cache-Control"] = "no-store"
    if MODE in {"fixtures", "integration_test"}:
        payload, source_mode = dict(fixture_reminder_delivery), "fixture"
    else:
        try:
            payload, source_mode = await runtime.alice_control.get_reminder_delivery()
        except AliceControlError as exc:
            _raise_alice_error(exc)
    return ReminderDeliverySettings(
        **payload,
        sourceMode=source_mode,
        writesEnabled=_write_allowed(True),
    )


@app.patch("/api/v1/settings/reminders/delivery", response_model=ReminderDeliverySettings)
async def patch_reminder_delivery_settings(
    patch: ReminderDeliveryPatch,
    response: Response,
) -> ReminderDeliverySettings:
    _require_write(True)
    payload = patch.model_dump()
    if MODE in {"fixtures", "integration_test"}:
        if patch.expectedRevision != fixture_reminder_delivery["revision"]:
            raise HTTPException(status_code=409, detail="revision_conflict")
        fixture_reminder_delivery["spokenEndpoint"] = patch.spokenEndpoint
        fixture_reminder_delivery["phoneChannels"] = list(patch.phoneChannels)
        fixture_reminder_delivery["revision"] += 1
        fixture_reminder_delivery["updatedAt"] = datetime.now(timezone.utc).isoformat()
        result, source_mode = dict(fixture_reminder_delivery), "fixture"
    else:
        try:
            result = await runtime.alice_control.patch_reminder_delivery(payload)
        except AliceControlError as exc:
            _raise_alice_error(exc)
        source_mode = "live"
    response.headers["Cache-Control"] = "no-store"
    return ReminderDeliverySettings(
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
    if action.action == "turn_on":
        try:
            result = await _execute_fixed_coffee_turn_on(action.requestId)
        except CoffeeDelayedStartError as exc:
            status_code = 403 if exc.code == "coffee_action_unavailable" else 503
            raise HTTPException(status_code=status_code, detail=exc.code) from exc
        await coffee_delayed_start_scheduler.reconcile()
    elif MODE in {"fixtures", "integration_test"}:
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
        await coffee_delayed_start_scheduler.reconcile()
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


coffee_delayed_start_scheduler = CoffeeDelayedStartScheduler(
    SETTINGS.coffee_delayed_start_path,
    can_schedule=_coffee_schedule_authority_available,
    execute_turn_on=_execute_fixed_coffee_turn_on,
    machine_state=_coffee_machine_state,
)
runtime.set_coffee_schedule_callback(coffee_delayed_start_scheduler.reconcile)
