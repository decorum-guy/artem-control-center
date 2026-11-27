"""A single typed HA ingress for the existing Windows brightness controller.

Alice's smart-home provider converts speech to a percentage. This module never
parses speech, accepts an entity/command from the network, or opens a listener.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from .access_policy import AccessPolicyStore, parse_datetime
from .system_controls import SystemControlsError, WindowsSystemControls

LOGGER = logging.getLogger(__name__)
CAPABILITY = "settings.system.brightness"
COMMAND_EVENT = "artem_panel_brightness_command"
STATE_EVENT = "artem_panel_brightness_state"
TARGET = "samsung_panel"
MAX_EVENT_AGE_SECONDS = 12
REPORT_INTERVAL_SECONDS = 30
_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,80}\Z")


def parse_brightness_event(event: dict[str, Any], now: datetime) -> tuple[str, int, datetime] | None:
    """Accept fresh HA events with only a fixed target and an integer percent."""
    if event.get("event_type") != COMMAND_EVENT or event.get("origin") != "LOCAL":
        return None
    data, context = event.get("data"), event.get("context")
    if not isinstance(data, dict) or not isinstance(context, dict):
        return None
    if set(data) != {"target", "percent", "request_id"} or data.get("target") != TARGET:
        return None
    request_id, percent = data.get("request_id"), data.get("percent")
    if not isinstance(request_id, str) or _REQUEST_ID.fullmatch(request_id) is None:
        return None
    if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 100:
        return None
    context_id = context.get("id")
    if not isinstance(context_id, str) or not 0 < len(context_id) <= 80:
        return None
    fired = parse_datetime(event.get("time_fired"))
    if fired is None or not -2 <= (now - fired).total_seconds() <= MAX_EVENT_AGE_SECONDS:
        return None
    return request_id, percent, fired


class PanelBrightnessBridge:
    def __init__(
        self,
        *,
        controls: WindowsSystemControls,
        access: Callable[[], AccessPolicyStore],
        write_enabled: Callable[[], bool],
        ingress_ready: Callable[[], bool],
        publish: Callable[[dict[str, Any]], Awaitable[None]],
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        report_interval: float = REPORT_INTERVAL_SECONDS,
    ) -> None:
        self.controls = controls
        self.access = access
        self.write_enabled = write_enabled
        self.ingress_ready = ingress_ready
        self.publish = publish
        self.clock = clock
        self.report_interval = max(10.0, report_interval)
        self.task: asyncio.Task | None = None
        self._report_task: asyncio.Task | None = None
        self._operation_lock = asyncio.Lock()
        self._closed = False
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._last_request: str | None = None
        self._last_outcome = "observed"

    def _allowed(self) -> bool:
        return not self._closed and self.ingress_ready() and self.access().authorize(
            CAPABILITY,
            gate_enabled=bool(self.write_enabled()),
            integration_available=self.controls.supported_platform,
        ).allowed

    def start(self) -> None:
        if not self._closed and self._report_task is None:
            self._report_task = asyncio.create_task(self._report_loop(), name="panel-brightness-state")

    def handle(self, event: dict[str, Any]) -> None:
        if self._closed:
            return
        parsed = parse_brightness_event(event, self.clock())
        if parsed is None:
            return
        request_id, percent, fired = parsed
        if request_id in self._seen:
            return
        # Mark busy requests too: replay may not turn an ignored event into a
        # delayed mutation after the owner has issued a different command.
        self._seen[request_id] = None
        if len(self._seen) > 256:
            self._seen.popitem(last=False)
        if self.task is not None and not self.task.done():
            LOGGER.info("Panel brightness command busy")
            return
        self.task = asyncio.create_task(self._run(request_id, percent, fired), name="panel-brightness-command")

    def _execute(self, percent: int, fired: datetime) -> tuple[str, dict[str, Any]]:
        unavailable = {"available": False, "value": None}
        # This check runs in the worker immediately before dispatch, not just
        # when the event was received. Touch lock is deliberately not involved.
        if not self._allowed():
            return "blocked", unavailable
        if (self.clock() - fired).total_seconds() > MAX_EVENT_AGE_SECONDS:
            return "expired", unavailable
        try:
            state = self.controls.set_value("brightness", percent)
        except SystemControlsError as exc:
            outcome = "busy" if str(exc) == "system_controls_busy" else "unconfirmed"
            return outcome, unavailable
        except Exception:
            LOGGER.warning("Panel brightness controller failed")
            return "unconfirmed", unavailable
        # WMI may quantize a level. Publish what it actually returned, without
        # claiming the requested percentage was confirmed when it was not.
        confirmed = state.get("available") is True and state.get("value") == percent
        return ("confirmed" if confirmed else "unconfirmed"), state

    async def _run(self, request_id: str, percent: int, fired: datetime) -> None:
        async with self._operation_lock:
            try:
                outcome, state = await asyncio.to_thread(self._execute, percent, fired)
            except Exception:
                LOGGER.warning("Panel brightness command failed")
                outcome, state = "unconfirmed", {"available": False, "value": None}
            self._last_request, self._last_outcome = request_id, outcome
            try:
                self.access().audit_capability(CAPABILITY, result=f"voice:{outcome}")
            except Exception:
                LOGGER.warning("Panel brightness audit unavailable")
            await self._publish(state)

    async def _publish(self, state: dict[str, Any]) -> None:
        value = state.get("value")
        available = (state.get("available") is True and isinstance(value, int)
                     and not isinstance(value, bool) and 0 <= value <= 100 and not self._closed)
        try:
            writable = available and self._allowed()
        except Exception:
            writable = False
        report = {
            "target": TARGET,
            "available": available,
            "value": value if available else None,
            "writable": writable,
            "observed_at": self.clock().isoformat(),
            "request_id": self._last_request,
            "outcome": self._last_outcome,
        }
        try:
            await self.publish(report)
        except Exception:
            # A lost acknowledgement never retries the physical mutation.
            LOGGER.warning("Panel brightness state report unavailable")

    async def refresh(self) -> None:
        async with self._operation_lock:
            if self._closed:
                return
            state = await asyncio.to_thread(self.controls.read)
            await self._publish(state.get("brightness", {}))

    async def _report_loop(self) -> None:
        while not self._closed:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.warning("Panel brightness state read unavailable")
            await asyncio.sleep(self.report_interval)

    async def close(self) -> None:
        self._closed = True
        if self._report_task is not None:
            self._report_task.cancel()
            await asyncio.gather(self._report_task, return_exceptions=True)
            self._report_task = None
        # An already-dispatched WMI call is bounded by the existing controller
        # and must finish; cancelling a to_thread await would not stop it.
        if self.task is not None:
            await self.task
            self.task = None
        await self._publish({"available": False, "value": None})
