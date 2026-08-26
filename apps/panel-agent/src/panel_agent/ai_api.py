"""Fixed same-origin Settings and small Planning-today AI API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from .ai_settings import AIProviderSettingsStore, MODELS
from .ai_text import AITextRequest, AITextService, project_today
from .planning import PlanningProjection
from .settings import IntegrationSettings

class ProviderSelectionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    providerId: str = Field(min_length=1, max_length=32)
    modelId: str = Field(min_length=1, max_length=96)

class CredentialPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    credential: str | None = Field(default=None, max_length=8192)

def _public_result(result) -> dict:
    return {"text": result.text, "providerId": result.provider_id, "modelId": result.model_id, "status": result.status, "errorCategory": result.error_category, "fallbackUsed": result.fallback_used, "latencyMs": result.latency_ms, "contextWarning": result.context_warning, "tier1": result.tier1}

def build_ai_router(
    settings: IntegrationSettings,
    store: AIProviderSettingsStore,
    service: AITextService,
    *,
    planning_provider: Callable[[], PlanningProjection | None],
    writes_allowed: Callable[[], bool],
) -> APIRouter:
    router = APIRouter(tags=["ai"])

    @router.get("/api/v1/settings/ai")
    def get_settings(response: Response) -> dict:
        response.headers["Cache-Control"] = "no-store"
        return store.public(enabled=settings.ai_text_enabled, writes_enabled=writes_allowed(), local_enabled=settings.ai_local_enabled, local_model=settings.ai_local_model, yandex_folder_configured=bool(settings.ai_yandex_folder_id))

    @router.patch("/api/v1/settings/ai/selection")
    def select(payload: ProviderSelectionPatch, response: Response) -> dict:
        if not writes_allowed(): raise HTTPException(status_code=403, detail="ai_settings_write_disabled")
        if payload.providerId not in MODELS or payload.modelId not in MODELS[payload.providerId]: raise HTTPException(status_code=422, detail="provider_or_model_unknown")
        try: store.select(expected_revision=payload.expectedRevision, provider_id=payload.providerId, model=payload.modelId)
        except ValueError as exc: raise HTTPException(status_code=409 if str(exc) == "revision_conflict" else 422, detail=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return store.public(enabled=settings.ai_text_enabled, writes_enabled=writes_allowed(), local_enabled=settings.ai_local_enabled, local_model=settings.ai_local_model, yandex_folder_configured=bool(settings.ai_yandex_folder_id))

    @router.patch("/api/v1/settings/ai/providers/{provider_id}/credential")
    def credential(provider_id: str, payload: CredentialPatch, response: Response) -> dict:
        if not writes_allowed(): raise HTTPException(status_code=403, detail="ai_settings_write_disabled")
        try: store.credential(expected_revision=payload.expectedRevision, provider_id=provider_id, value=payload.credential)
        except ValueError as exc: raise HTTPException(status_code=409 if str(exc) == "revision_conflict" else 422, detail=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return store.public(enabled=settings.ai_text_enabled, writes_enabled=writes_allowed(), local_enabled=settings.ai_local_enabled, local_model=settings.ai_local_model, yandex_folder_configured=bool(settings.ai_yandex_folder_id))

    @router.post("/api/v1/ai/text/today")
    async def planning_today(response: Response) -> dict:
        request = AITextRequest(purpose="planning_today", instruction="Ты — краткий ассистент Artem Control Center. Суммируй только переданный план дня.", user_text="Что у меня сегодня?", facts=project_today(planning_provider(), now=datetime.now(timezone.utc), timezone=settings.panel_planning_timezone), timezone=settings.panel_planning_timezone)
        result = await service.generate(request)
        response.headers["Cache-Control"] = "no-store"
        return _public_result(result)
    return router
