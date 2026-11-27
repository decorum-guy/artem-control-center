"""Fixed percentage request/ack contract; no Home Assistant dependency here."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

COMMAND_EVENT = "artem_panel_brightness_command"
STATE_EVENT = "artem_panel_brightness_state"
TARGET = "samsung_panel"
STATE_ENTITY = "sensor.artem_panel_brightness"


class BrightnessRequestError(RuntimeError):
    """A bounded failure code, without private data."""


def validate_percent(value: Any) -> int:
    # Yandex range values may be integral JSON floats. HA normalizes them here
    # before the strict Samsung event boundary; strings/bools never coerce.
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not 0 <= value <= 100 or value != int(value)):
        raise ValueError("brightness_percent_invalid")
    return int(value)


def _fresh(observed_at: Any, now: datetime) -> bool:
    if not isinstance(observed_at, str) or len(observed_at) > 40:
        return False
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        return observed.tzinfo is not None and -2 <= (now - observed).total_seconds() < 90
    except (ValueError, TypeError):
        return False


class BrightnessGateway:
    def __init__(
        self,
        *,
        state: Callable[[], dict[str, Any] | None],
        subscribe: Callable[[Callable[[dict[str, Any]], None]], Callable[[], None]],
        fire: Callable[[dict[str, Any]], None],
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        timeout: float = 4.0,
    ) -> None:
        self.state, self.subscribe, self.fire = state, subscribe, fire
        self.clock, self.timeout = clock, timeout
        self._lock = asyncio.Lock()
        self._closed = False
        self._pending: asyncio.Future | None = None

    async def set_brightness(self, percent: Any) -> int:
        percent = validate_percent(percent)
        if self._closed:
            raise BrightnessRequestError("unavailable")
        if self._lock.locked():
            # Do not use HA script mode=single: its ignored call returns None
            # as a normal completion, causing false success at the provider.
            raise BrightnessRequestError("busy")
        async with self._lock:
            state = self.state()
            if (not isinstance(state, dict) or state.get("available") is not True
                    or state.get("writable") is not True or not _fresh(state.get("observed_at"), self.clock())):
                raise BrightnessRequestError("unavailable")
            request_id = uuid4().hex
            pending = asyncio.get_running_loop().create_future()
            self._pending = pending

            def receive(data: dict[str, Any]) -> None:
                if (not pending.done() and data.get("target") == TARGET
                        and data.get("request_id") == request_id):
                    pending.set_result(dict(data))

            # Listener exists before fire, so even an immediate reply is kept.
            remove = None
            try:
                remove = self.subscribe(receive)
                self.fire({"target": TARGET, "percent": percent, "request_id": request_id})
                try:
                    report = await asyncio.wait_for(pending, timeout=self.timeout)
                except asyncio.TimeoutError as exc:
                    raise BrightnessRequestError("unconfirmed") from exc
                if (report.get("outcome") != "confirmed" or report.get("available") is not True
                        or type(report.get("value")) is not int or report["value"] != percent
                        or not _fresh(report.get("observed_at"), self.clock())):
                    raise BrightnessRequestError("unconfirmed")
                return report["value"]
            finally:
                if remove is not None:
                    remove()
                if not pending.done():
                    pending.cancel()
                self._pending = None

    def close(self) -> None:
        self._closed = True
        if self._pending is not None and not self._pending.done():
            self._pending.cancel()
