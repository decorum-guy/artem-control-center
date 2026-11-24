"""Send a short, fixed result to the configured Station without blocking voice actions."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from itertools import cycle
from time import monotonic

LOGGER = logging.getLogger(__name__)
FEEDBACK_SECONDS = 5

PHRASES = {
    "tv.screen-on.screen-confirmed": ("Телевизор включён.", "Экран включён."),
    "tv.screen-off.screen-confirmed": ("Экран погашен.", "Экран выключен."),
    "tv.youtube.app-open": ("Приложение открыто.", "Готово, Ютуб открыт."),
    "tv.offline": ("Телевизор не отвечает.", "Телевизор недоступен."),
    "tv.app-unavailable": ("Приложение недоступно.",),
    "tv.busy": ("Телевизор занят.",),
    "tv.unconfirmed": ("Не удалось подтвердить результат.",),
    "music.in_music": ("Песня добавлена в избранное.", "Готово, песня в избранном."),
    "music.already_in_music": ("Эта песня уже в избранном.",),
    "music.youtube_like": ("Лайк подтверждён.", "У этой песни теперь есть лайк."),
    "music.choose_source": ("Уточни песню на панели.",),
    "music.choose_version": ("Выбери версию на панели.",),
    "music.no_track": ("Сейчас музыка не играет.",),
    "music.no_match": ("Подходящая запись не нашлась.",),
    "music.auth_required": ("Нужно подключить Ютуб в настройках панели.",),
    "music.unavailable": ("Не удалось связаться с Ютубом.",),
    "music.unconfirmed": ("Не удалось подтвердить лайк.",),
}


class AliceVoiceFeedback:
    def __init__(self, speak: Callable[[str, str], Awaitable[None]], *,
                 local_music_entity: str = "",
                 speak_local: Callable[[str, Callable[[], bool]], Awaitable[bool]] | None = None,
                 clock: Callable[[], float] = monotonic) -> None:
        self.speak, self.speak_local, self.local_music_entity = speak, speak_local, local_music_entity
        self.clock = clock
        self.variants = {cue: cycle(phrases) for cue, phrases in PHRASES.items()}
        self.task: asyncio.Task | None = None
        self.closed = False

    def announce(self, entity: str, cue: str, allowed: Callable[[], bool]) -> None:
        phrases = self.variants.get(cue)
        if self.closed or phrases is None or (self.task is not None and not self.task.done()):
            return
        deadline = self.clock() + FEEDBACK_SECONDS

        def may_send() -> bool:
            return not self.closed and self.clock() < deadline and allowed()

        self.task = asyncio.create_task(self._announce(entity, cue, next(phrases), may_send),
                                        name="alice-voice-feedback")

    async def _announce(self, entity: str, cue: str, phrase: str, may_send: Callable[[], bool]) -> None:
        if not may_send():
            return
        local = self.speak_local if cue.startswith("music.") and entity == self.local_music_entity else None
        try:
            async with asyncio.timeout(FEEDBACK_SECONDS):
                if local is not None:
                    if not await local(phrase, may_send):
                        LOGGER.warning("Alice voice feedback not confirmed by Glagol: %s", cue)
                        return
                    LOGGER.info("Alice voice feedback accepted by Glagol: %s", cue)
                elif may_send():
                    await self.speak(entity, phrase)
                    LOGGER.info("Alice voice feedback accepted by HA: %s", cue)
        except Exception:
            LOGGER.warning("Alice voice feedback unavailable: %s", cue)

    async def close(self) -> None:
        self.closed = True
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
