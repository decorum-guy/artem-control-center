import os
from typing import List

from fastapi import FastAPI, HTTPException, Query, status

from .contracts import DashboardSnapshot, PanelMode, ServiceSnapshot
from .fixtures import load_fixture_document, safe_read_only_services, services_for_scenario


def configured_mode() -> PanelMode:
    raw = os.getenv("PANEL_AGENT_MODE", "read_only")
    if raw not in {"fixtures", "read_only", "integration_test", "production"}:
        raise RuntimeError(f"Invalid PANEL_AGENT_MODE: {raw}")
    return raw  # type: ignore[return-value]


MODE = configured_mode()
app = FastAPI(title="Artem Control Center Panel Agent", version="0.1.0")
fixture_services: List[ServiceSnapshot] = []
revision = 1


@app.get("/health/live")
def live() -> dict:
    return {"ok": True, "service": "artem-panel-agent", "mode": MODE}


@app.get("/health/ready")
def ready() -> dict:
    return {
        "ok": True,
        "service": "artem-panel-agent",
        "mode": MODE,
        "writesEnabled": False,
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
        fixture_scenario = scenario
    else:
        services = safe_read_only_services()
        fixture_scenario = None
    return DashboardSnapshot(
        revision=revision,
        generatedAt=document["generatedAt"],
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

