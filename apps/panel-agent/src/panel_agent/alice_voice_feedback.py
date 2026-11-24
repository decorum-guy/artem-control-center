"""Send a short, fixed result to the configured Station without blocking voice actions."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from itertools import cycle

LOGGER = logging.getLogger(__name__)

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
    def __init__(self, speak: Callable[[str, str], Awaitable[None]]) -> None:
        self.speak = speak
        self.variants = {cue: cycle(phrases) for cue, phrases in PHRASES.items()}
        self.task: asyncio.Task | None = None
        self.closed = False

    def announce(self, entity: str, cue: str, allowed: Callable[[], bool]) -> None:
        phrases = self.variants.get(cue)
        if self.closed or phrases is None or (self.task is not None and not self.task.done()):
            return
        self.task = asyncio.create_task(self._announce(entity, cue, next(phrases), allowed),
                                        name="alice-voice-feedback")

    async def _announce(self, entity: str, cue: str, phrase: str, allowed: Callable[[], bool]) -> None:
        try:
            if allowed():
                await asyncio.wait_for(self.speak(entity, phrase), timeout=5)
                LOGGER.info("Alice voice feedback accepted: %s", cue)
        except Exception:
            LOGGER.warning("Alice voice feedback unavailable: %s", cue)

    async def close(self) -> None:
        self.closed = True
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
