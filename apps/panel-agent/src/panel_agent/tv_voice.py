"""Route allow-listed HA scenario events to the installed TV executor."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable

from .access_policy import AccessPolicyStore, parse_datetime
from .tv_api import TVCommand, TVExecutorClient

LOGGER = logging.getLogger(__name__)
CAPABILITY = "home.television.voice"
SCENARIOS = {
    "Панель ТВ · Включение": "screen-on",
    "Панель ТВ · Выключение": "screen-off",
    "Панель ТВ · YouTube": "youtube",
    "Панель ТВ · YouTube коротко": "youtube",
}
MAX_EVENT_AGE_SECONDS = 12
DUPLICATE_WINDOW_SECONDS = 6


class TVVoiceBridge:
    def __init__(self, *, station_entity: str, executor: TVExecutorClient,
                 access: Callable[[], AccessPolicyStore], write_enabled: Callable[[], bool],
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
        self.station_entity = station_entity
        self.executor = executor
        self.access = access
        self.write_enabled = write_enabled
        self.clock = clock
        self.task: asyncio.Task | None = None
        self._closed = False
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._last_action: dict[str, datetime] = {}

    def handle(self, event: dict[str, Any]) -> None:
        data, context = event.get("data"), event.get("context")
        if self._closed or event.get("event_type") != "yandex_scenario" or event.get("origin") != "LOCAL":
            return
        if not isinstance(data, dict) or not isinstance(context, dict):
            return
        if (data.get("entity_id") != self.station_entity or data.get("instance") != "text_action"
                or data.get("value") != "ничего не делай"):
            return
        name, event_id = data.get("scenario_name"), context.get("id")
        if not isinstance(name, str) or not isinstance(event_id, str) or not 0 < len(event_id) <= 80:
            return
        action = SCENARIOS.get(name)
        fired = parse_datetime(event.get("time_fired"))
        now = self.clock()
        if action is None or fired is None or not -2 <= (now - fired).total_seconds() <= MAX_EVENT_AGE_SECONDS:
            return
        if event_id in self._seen:
            return
        self._seen[event_id] = None
        if len(self._seen) > 256:
            self._seen.popitem(last=False)
        if self.task is not None and not self.task.done():
            LOGGER.info("TV voice %s busy", action)
            return
        previous = self._last_action.get(action)
        if previous is not None and (now - previous).total_seconds() < DUPLICATE_WINDOW_SECONDS:
            return
        self._last_action[action] = now
        self.task = asyncio.create_task(self._run(action), name="tv-voice-command")

    def _allowed(self) -> bool:
        return not self._closed and self.access().authorize(CAPABILITY, gate_enabled=self.write_enabled()).allowed

    async def _run(self, action: str) -> None:
        try:
            outcome = await asyncio.to_thread(self._execute, action)
            self.access().audit_capability(CAPABILITY, result=f"{action}:{outcome}")
            LOGGER.info("TV voice %s %s", action, outcome)
        except Exception:
            LOGGER.warning("TV voice command failed")

    def _execute(self, action: str) -> str:
        if not self._allowed():
            return "blocked"
        if action in {"screen-on", "screen-off"}:
            return self._screen(action)
        code, status = self.executor.invoke()
        if code != 200 or status.get("availability") != "online":
            return "offline"
        apps = status.get("apps")
        if not isinstance(apps, list) or not any(isinstance(item, dict) and item.get("id") == "youtube" for item in apps):
            return "app-unavailable"
        if status.get("screen") == "off":
            if not self._allowed():
                return "blocked"
            result = self._screen("screen-on")
            if result != "screen-confirmed":
                return result
        elif status.get("screen") != "on":
            return "unconfirmed"
        if not self._allowed():
            return "blocked"
        code, response = self.executor.invoke(TVCommand(action="open-app", app="youtube"))
        if code == 200 and response.get("outcome") == "app-open":
            return "app-open"
        return self._failure(response)

    def _screen(self, action: str) -> str:
        code, response = self.executor.invoke(TVCommand(action=action))
        if code == 200 and response.get("outcome") == "confirmed" and response.get("screen") == action[7:]:
            return "screen-confirmed"
        return self._failure(response)

    @staticmethod
    def _failure(response: dict) -> str:
        outcome = response.get("outcome")
        return outcome if outcome in ("busy", "offline") else "unconfirmed"

    async def close(self) -> None:
        self._closed = True
        if self.task is not None:
            # A dispatched synchronous request cannot be cancelled safely.
            # The executor client bounds it, and no new step may start.
            await self.task
            self.task = None
