"""Private, text-first Jarvis turn endpoint with only closed A1 execution."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from .jarvis_core import MAX_JARVIS_TEXT_CODEPOINTS, JarvisIntentEnvelope, classify_jarvis_text
from .planning import PlanningProjection
from .weather import WeatherError, WeatherService

MAX_RESPONSE_CODEPOINTS = 500
NavigationPath = Literal["/overview", "/calendar", "/tasks", "/reminders", "/settings", "/system", "/coffee-diary"]
NAVIGATION_BY_INTENT: dict[str, NavigationPath] = {
    "navigation.overview": "/overview", "navigation.calendar": "/calendar",
    "navigation.tasks": "/tasks", "navigation.reminders": "/reminders",
    "navigation.settings": "/settings", "navigation.system": "/system",
    "navigation.coffee_diary": "/coffee-diary",
}


class JarvisTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=MAX_JARVIS_TEXT_CODEPOINTS)


class JarvisTurnResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    schema_version: Literal["jarvis.turn.v1"] = Field(default="jarvis.turn.v1", alias="schemaVersion")
    status: Literal["ready", "unavailable", "cancelled"]
    intent_id: str = Field(alias="intentId")
    response_text: str = Field(max_length=MAX_RESPONSE_CODEPOINTS, alias="responseText")
    navigation: NavigationPath | None = None


class JarvisTurnService:
    """In-memory, non-content session state for a single local Panel Agent."""

    def __init__(self, *, planning: Callable[[], PlanningProjection | None], weather: WeatherService,
                 timezone_name: str, clock: Callable[[], datetime] | None = None) -> None:
        self._planning = planning
        self._weather = weather
        self._timezone = ZoneInfo(timezone_name)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._previous_response: str | None = None
        self.last_successful_interaction_at: datetime | None = None

    async def turn(self, text: str) -> JarvisTurnResponse:
        intent = classify_jarvis_text(text)
        result = await self._execute(intent)
        if result.status == "ready" and intent.intent_id not in {"jarvis.repeat", "jarvis.cancel", "jarvis.stop"}:
            self._previous_response = result.response_text
            self.last_successful_interaction_at = self._clock()
        return result

    async def _execute(self, intent: JarvisIntentEnvelope) -> JarvisTurnResponse:
        if intent.intent_id == "jarvis.repeat":
            return self._response("ready", intent, self._previous_response or "Мне пока нечего повторить.")
        if intent.intent_id in {"jarvis.cancel", "jarvis.stop"}:
            return self._response("cancelled", intent, "Текущий запрос отменён.")
        if intent.intent_id == "system.time.current":
            local = self._clock().astimezone(self._timezone)
            return self._response("ready", intent, f"Сейчас {local:%H:%M}.")
        if intent.intent_id == "weather.read":
            try:
                forecast = await self._weather.forecast()
            except WeatherError:
                return self._response("unavailable", intent, "Погода сейчас недоступна.")
            if forecast.stale:
                return self._response("unavailable", intent, "Данные о погоде устарели; свежая сводка сейчас недоступна.")
            return self._response("ready", intent, f"{forecast.location.title}: {round(forecast.current.temperature)}°C.")
        if intent.intent_id.startswith("planning."):
            return self._planning_response(intent)
        if intent.intent_id in NAVIGATION_BY_INTENT:
            return self._response("ready", intent, "Открываю раздел.", NAVIGATION_BY_INTENT[intent.intent_id])
        if intent.kind == "future_mutation":
            return self._response("unavailable", intent, "Эта команда пока недоступна в текущей версии Jarvis.")
        return self._response("unavailable", intent, "В текущей версии Jarvis я умею отвечать на запросы панели и открывать разделы.")

    def _planning_response(self, intent: JarvisIntentEnvelope) -> JarvisTurnResponse:
        projection = self._planning()
        if projection is None or projection.sourceStatus != "current":
            return self._response("unavailable", intent, "Данные планирования сейчас недоступны.")
        if intent.intent_id == "planning.calendar.read":
            items = projection.calendar.today
            label = "событий" if len(items) != 1 else "событие"
            detail = f" Ближайшее: {items[0].title}." if items else ""
            return self._response("ready", intent, f"Сегодня {len(items)} {label}.{detail}")
        if intent.intent_id == "planning.tasks.read":
            items = projection.tasks.today
            return self._response("ready", intent, f"На сегодня задач: {len(items)}." + (f" Первая: {items[0].title}." if items else ""))
        items = projection.reminders.upcoming
        return self._response("ready", intent, f"Ближайших напоминаний: {len(items)}." + (f" Первое: {items[0].title}." if items else ""))

    @staticmethod
    def _response(status: Literal["ready", "unavailable", "cancelled"], intent: JarvisIntentEnvelope,
                  text: str, navigation: NavigationPath | None = None) -> JarvisTurnResponse:
        return JarvisTurnResponse(status=status, intentId=intent.intent_id, responseText=text[:MAX_RESPONSE_CODEPOINTS], navigation=navigation)


def build_jarvis_router(service: JarvisTurnService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/jarvis", tags=["jarvis"])

    @router.post("/turn", response_model=JarvisTurnResponse)
    async def jarvis_turn(request: JarvisTurnRequest, response: Response) -> JarvisTurnResponse:
        response.headers["Cache-Control"] = "no-store"
        return await service.turn(request.text)

    return router
