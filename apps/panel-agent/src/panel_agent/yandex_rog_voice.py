"""Closed YandexDialogs phrase bridge for the existing ASUS ROG executor."""

from __future__ import annotations

from typing import Any, Literal, Protocol

from fastapi import HTTPException

from .rog_g703_power import (
    ROG_G703_HIBERNATE_ACTION,
    ROG_G703_SLEEP_ACTION,
    ROG_G703_WAKE_ACTION,
    RogG703ActionExecutor,
    RogG703ActionRequest,
)
from .settings import IntegrationSettings

RogVoiceAction = Literal[
    "system.rog_g703.wake",
    "system.rog_g703.sleep",
    "system.rog_g703.hibernate",
]

_PHRASES: dict[str, RogVoiceAction] = {
    "включить асус": ROG_G703_WAKE_ACTION,
    "включи асус": ROG_G703_WAKE_ACTION,
    "разбудить асус": ROG_G703_WAKE_ACTION,
    "разбуди асус": ROG_G703_WAKE_ACTION,
    "перевести асус в сон": ROG_G703_SLEEP_ACTION,
    "переведи асус в сон": ROG_G703_SLEEP_ACTION,
    "отправить асус в сон": ROG_G703_SLEEP_ACTION,
    "отправь асус в сон": ROG_G703_SLEEP_ACTION,
    "перевести асус в гибернацию": ROG_G703_HIBERNATE_ACTION,
    "переведи асус в гибернацию": ROG_G703_HIBERNATE_ACTION,
    "отправить асус в гибернацию": ROG_G703_HIBERNATE_ACTION,
    "отправь асус в гибернацию": ROG_G703_HIBERNATE_ACTION,
}

_ACCEPTED_RESPONSES: dict[RogVoiceAction, str] = {
    ROG_G703_WAKE_ACTION: "Включаю ASUS.",
    ROG_G703_SLEEP_ACTION: "Перевожу ASUS в сон.",
    ROG_G703_HIBERNATE_ACTION: "Перевожу ASUS в гибернацию.",
}


class YandexIntentResponder(Protocol):
    async def respond_to_yandex_intent(self, text: str) -> None: ...


def parse_yandex_rog_voice_command(event_data: dict[str, Any]) -> RogVoiceAction | None:
    """Parse only the cleaned `command` field and a bounded `text` fallback."""

    candidate = event_data.get("command")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = event_data.get("text")
    if not isinstance(candidate, str):
        return None
    normalized = " ".join(candidate.casefold().replace("ё", "е").split())
    return _PHRASES.get(normalized)


class YandexRogVoiceBridge:
    """Routes only closed ASUS phrases to the shared typed ROG executor."""

    def __init__(
        self,
        settings: IntegrationSettings,
        executor: RogG703ActionExecutor,
        responder: YandexIntentResponder,
    ) -> None:
        self._settings = settings
        self._executor = executor
        self._responder = responder

    async def handle(self, event_data: dict[str, Any]) -> None:
        action_id = parse_yandex_rog_voice_command(event_data)
        if action_id is None or not self._settings.rog_g703_alice_enabled:
            return

        availability = self._executor.availability(action_id)
        if not availability.get("allowed"):
            await self._responder.respond_to_yandex_intent(
                self._denied_response(action_id, availability)
            )
            return

        try:
            await self._executor.start(RogG703ActionRequest(actionId=action_id))
        except HTTPException:
            # Availability can change only between the read above and start.
            availability = self._executor.availability(action_id)
            await self._responder.respond_to_yandex_intent(
                self._denied_response(action_id, availability)
            )
            return
        await self._responder.respond_to_yandex_intent(_ACCEPTED_RESPONSES[action_id])

    def _denied_response(
        self,
        action_id: RogVoiceAction,
        availability: dict[str, Any],
    ) -> str:
        if availability.get("availability") == "busy":
            return "Команда для ASUS уже выполняется."
        if (
            action_id == ROG_G703_WAKE_ACTION
            and availability.get("status") == "online"
        ):
            return "ASUS уже в сети."
        if (
            action_id in {ROG_G703_SLEEP_ACTION, ROG_G703_HIBERNATE_ACTION}
            and availability.get("status") != "online"
        ):
            return "ASUS сейчас не в сети."
        return "Управление ASUS сейчас недоступно."
