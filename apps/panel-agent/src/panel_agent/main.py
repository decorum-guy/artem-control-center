import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List

from fastapi import FastAPI, HTTPException, Query, Response, status

from .alice_control import AliceControlError
from .contracts import (
    CoffeeActionRequest,
    CoffeeActionResponse,
    CoffeeNotificationPatch,
    CoffeeNotificationSettings,
    CoffeeTimingPatch,
    CoffeeTimingSettings,
    DashboardSnapshot,
    PanelMode,
    ServiceSnapshot,
)
from .fixtures import load_fixture_document, services_for_scenario
from .integrations import IntegrationRuntime
from .settings import IntegrationSettings


def configured_mode() -> PanelMode:
    raw = os.getenv("PANEL_AGENT_MODE", "read_only")
    if raw not in {"fixtures", "read_only", "integration_test", "production"}:
        raise RuntimeError(f"Invalid PANEL_AGENT_MODE: {raw}")
    return raw  # type: ignore[return-value]


MODE = configured_mode()
SETTINGS = IntegrationSettings.from_env()
runtime = IntegrationRuntime(SETTINGS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if MODE not in {"fixtures", "integration_test"}:
        await runtime.start()
    try:
        yield
    finally:
        await runtime.close()


app = FastAPI(
    title="Artem Control Center Panel Agent",
    version="0.2.0",
    lifespan=lifespan,
)
fixture_services: List[ServiceSnapshot] = []
revision = 1
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
        "integrationsConfigured": {
            "homeAssistant": runtime.home_assistant.configured,
            "alice": bool(SETTINGS.alice_health_url),
            "avalarMain": bool(SETTINGS.avalar_main_url),
            "avalarStage": bool(SETTINGS.avalar_stage_url),
            "avalarSshDetails": runtime.avalar_ssh.enabled,
        },
    }


@app.get("/api/v1/fixtures")
def list_fixtures() -> dict:
    if MODE not in {"fixtures", "integration_test"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    document = load_fixture_document()
    return {"default": document["defaultScenario"], "scenarios": sorted(document["scenarios"].keys())}


@app.get("/api/v1/snapshot", response_model=DashboardSnapshot)
def snapshot(scenario: str = Query(default="ha-healthy")) -> DashboardSnapshot:
    document = load_fixture_document()
    if MODE in {"fixtures", "integration_test"}:
        try:
            services = services_for_scenario(scenario)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown fixture scenario")
        services.extend(fixture_services)
        coffee_actions_enabled = (
            scenario == "coffee-off"
            and _write_allowed(SETTINGS.coffee_actions_enabled)
        )
        for service in services:
            if service.id == "coffee-machine":
                for action in service.actions:
                    action.enabled = coffee_actions_enabled
        fixture_scenario = scenario
    else:
        services = runtime.services()
        fixture_scenario = None
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
async def coffee_timing_settings() -> CoffeeTimingSettings:
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
async def coffee_notification_settings() -> CoffeeNotificationSettings:
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
    _require_write(SETTINGS.coffee_actions_enabled)
    if MODE in {"fixtures", "integration_test"}:
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
        if not runtime.home_assistant.configured:
            raise HTTPException(status_code=503, detail="home_assistant_not_configured")
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
    response.headers["Cache-Control"] = "no-store"
    return CoffeeActionResponse(**result)


def _write_allowed(narrow_gate: bool) -> bool:
    return SETTINGS.writes_enabled and narrow_gate


def _require_write(narrow_gate: bool) -> None:
    if not _write_allowed(narrow_gate):
        raise HTTPException(status_code=403, detail="coffee_write_disabled")


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
