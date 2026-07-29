from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional
from urllib.parse import urlparse, urlunparse

import httpx
import websockets

from .contracts import ActionDescriptor, ServicePresentation, ServiceSnapshot
from .settings import IntegrationSettings

COFFEE_ENTITY = "switch.kofemashina"
WARMUP_ENTITY = "input_number.coffee_warmup_minutes"
LONG_RUNNING_ENTITY = "input_number.coffee_long_running_minutes"
LAST_ON_ENTITY = "input_datetime.coffee_last_turned_on"
TIMING_INITIALIZED_ENTITY = "input_boolean.coffee_timing_initialized"
KETTLE_ENTITY = "water_heater.chainik"
KETTLE_SUPPORT_ENTITIES = (
    "switch.chainik_podderzhanie_tepla",
    "switch.chainik_podsvetka",
    "switch.chainik_bez_zvuka",
)
REQUIRED_ENTITIES = (
    COFFEE_ENTITY,
    WARMUP_ENTITY,
    LONG_RUNNING_ENTITY,
    LAST_ON_ENTITY,
    TIMING_INITIALIZED_ENTITY,
    KETTLE_ENTITY,
    *KETTLE_SUPPORT_ENTITIES,
)


class HomeAssistantAdapter:
    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        panel_mode: str = "read_only",
        on_change: Callable[[], Awaitable[None]] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._states: Dict[str, Dict[str, Any]] = {}
        self._observed_at: Optional[datetime] = None
        self._last_successful_rest_at: Optional[datetime] = None
        self._last_transport_connected_at: Optional[datetime] = None
        self._last_transport_failure_at: Optional[datetime] = None
        self._websocket_connected = False
        self._snapshot_confirmed_for_transport = False
        self._source = "unavailable"
        self._latency_ms: Optional[int] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._stale_task: Optional[asyncio.Task[None]] = None
        self._panel_mode = panel_mode
        self._on_change = on_change
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._load_cache()

    @property
    def configured(self) -> bool:
        return bool(self._settings.ha_url and self._settings.ha_token)

    def set_on_change(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self._on_change = callback

    async def start(self) -> None:
        if not self.configured:
            return
        try:
            await self.fetch_initial_snapshot()
        except (httpx.HTTPError, ValueError):
            await self._mark_cached_or_unavailable()
        self._task = asyncio.create_task(self._subscribe_forever())
        self._stale_task = asyncio.create_task(self._watch_staleness())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self._task = None
        if self._stale_task:
            self._stale_task.cancel()
            await asyncio.gather(self._stale_task, return_exceptions=True)
        self._stale_task = None

    async def fetch_initial_snapshot(self) -> None:
        started = self._clock()
        async with httpx.AsyncClient(
            base_url=self._settings.ha_url,
            headers={"Authorization": f"Bearer {self._settings.ha_token}"},
            timeout=10,
            transport=self._transport,
        ) as client:
            response = await client.get("/api/states")
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Home Assistant states response must be a list")
        self._replace_states(payload)
        self._last_successful_rest_at = self._clock()
        self._snapshot_confirmed_for_transport = True
        self._source = "live"
        self._latency_ms = int(
            (self._clock() - started).total_seconds() * 1000
        )
        await self._notify_change()

    def coffee_confirmation(self) -> dict[str, Any]:
        coffee = self._states.get(COFFEE_ENTITY) or {}
        return {
            "state": coffee.get("state"),
            "warmupMinutes": _state_minutes(self._states.get(WARMUP_ENTITY)),
            "longRunningMinutes": _state_minutes(
                self._states.get(LONG_RUNNING_ENTITY)
            ),
            "observedAt": self._observed_at.isoformat()
            if self._observed_at
            else None,
        }

    def coffee_action_allowed(self, action: str) -> bool:
        coffee = self._states.get(COFFEE_ENTITY) or {}
        state = coffee.get("state")
        expected = "off" if action == "turn_on" else "on"
        return bool(
            self._settings.writes_enabled
            and self._settings.coffee_actions_enabled
            and self._panel_mode in {"production", "integration_test", "fixtures"}
            and self.configured
            and self._transport_is_live()
            and self._snapshot_confirmed_for_transport
            and state == expected
            and state not in {"unknown", "unavailable"}
            and self._settings.alice_base_url
            and self._settings.alice_control_center_token
        )

    async def apply_state_changed(
        self,
        entity_id: str,
        new_state: Dict[str, Any],
    ) -> bool:
        if entity_id not in REQUIRED_ENTITIES:
            return False
        sanitized = _sanitize_state(entity_id, new_state)
        if self._states.get(entity_id) == sanitized and self._source == "live":
            return False
        self._states[entity_id] = sanitized
        self._observed_at = self._clock()
        if self._transport_is_live():
            self._source = "live"
        self._save_cache()
        await self._notify_change()
        return True

    def services(self) -> List[ServiceSnapshot]:
        observed = self._observed_at or self._clock()
        stale = self._is_stale()
        source = self._current_source()
        missing = [entity for entity in REQUIRED_ENTITIES if entity not in self._states]
        ha_health = (
            "offline"
            if not self._states
            else "stale"
            if stale
            else "degraded"
            if missing
            else "healthy"
        )
        freshness = (
            "WebSocket подключен"
            if self._websocket_connected and self._transport_is_live()
            else _freshness_label(observed, now=self._clock())
        )

        coffee = self._states.get(COFFEE_ENTITY)
        available = bool(
            coffee and coffee.get("state") not in {"unknown", "unavailable"}
        )
        machine_state = (
            "stale"
            if stale and coffee
            else str(coffee.get("state"))
            if available
            else "unavailable"
        )
        if machine_state not in {"on", "off", "stale"}:
            machine_state = "unavailable"
        turned_on_at = _valid_datetime_state(self._states.get(LAST_ON_ENTITY))
        warmup = _minutes_to_seconds(self._states.get(WARMUP_ENTITY))
        long_running = _minutes_to_seconds(self._states.get(LONG_RUNNING_ENTITY))
        timing_initialized = (
            self._states.get(TIMING_INITIALIZED_ENTITY, {}).get("state") == "on"
        )
        timing_available = (
            timing_initialized and warmup is not None and long_running is not None
        )
        coffee_health = (
            "offline"
            if not available
            else "stale"
            if stale
            else "degraded"
            if not timing_available
            else "healthy"
        )

        kettle = self._states.get(KETTLE_ENTITY)
        kettle_state = _kettle_state(kettle)
        kettle_health = (
            "stale"
            if stale and kettle
            else "offline"
            if kettle_state == "unavailable"
            else "healthy"
        )

        coffee_actions = [
            ActionDescriptor(
                id="home.coffee.turn_on",
                title="Включить",
                enabled=self.coffee_action_allowed("turn_on"),
                risk="medium",
            ),
            ActionDescriptor(
                id="home.coffee.turn_off",
                title="Выключить",
                enabled=self.coffee_action_allowed("turn_off"),
                risk="low",
            ),
        ]
        return [
            ServiceSnapshot(
                id="home-assistant",
                title="Home Assistant",
                health=ha_health,
                summary=(
                    "Canonical home state available"
                    if ha_health == "healthy"
                    else "Home Assistant data unavailable or incomplete"
                ),
                dataContract="service.health.v1",
                actions=[],
                source=source,
                presentation=ServicePresentation(
                    category="home-infrastructure",
                    group="Home infrastructure",
                    overview="aggregate",
                    priority=80,
                    environment="home",
                    freshnessLabel=freshness,
                    latencyMs=self._latency_ms,
                    role="home-authority",
                ),
                data={
                    "adapter": "home-assistant-rest-websocket",
                    "missingEntities": missing,
                    "writesEnabled": self._settings.writes_enabled,
                    "transport": {
                        "websocketConnected": self._websocket_connected,
                        "snapshotConfirmed": self._snapshot_confirmed_for_transport,
                        "lastSuccessfulRestAt": _iso(self._last_successful_rest_at),
                        "lastTransportConnectedAt": _iso(
                            self._last_transport_connected_at
                        ),
                        "lastTransportFailureAt": _iso(
                            self._last_transport_failure_at
                        ),
                    },
                },
            ),
            ServiceSnapshot(
                id="coffee-machine",
                title="Кофемашина",
                health=coffee_health,
                summary=_coffee_summary(machine_state, timing_available),
                dataContract="home.coffee-machine.v1",
                actions=coffee_actions,
                source=source,
                presentation=ServicePresentation(
                    category="home-device",
                    group="Home infrastructure",
                    overview="primary",
                    priority=100,
                    environment="home",
                    freshnessLabel=freshness,
                ),
                data={
                    "machine": {
                        "entityId": COFFEE_ENTITY,
                        "authority": "home-assistant",
                        "state": machine_state,
                        "available": available,
                        "turnedOnAt": turned_on_at,
                        "entityLastChangedAt": (coffee or {}).get("last_changed"),
                        "observedAt": observed.isoformat(),
                        "stale": stale,
                    },
                    "timingPolicy": {
                        "source": "home-assistant",
                        "warmupDurationSeconds": warmup,
                        "longRunningThresholdSeconds": long_running,
                        "fetchedAt": observed.isoformat() if timing_available else None,
                        "stale": stale,
                        "sourceAvailable": timing_available and not stale,
                        "initialized": timing_initialized,
                        "sourceRevision": _timing_revision(
                            self._states.get(WARMUP_ENTITY),
                            self._states.get(LONG_RUNNING_ENTITY),
                        ),
                    },
                },
            ),
            ServiceSnapshot(
                id="kettle",
                title="Чайник",
                health=kettle_health,
                summary={
                    "on": "Включен",
                    "off": "Выключен",
                    "unavailable": "Недоступен",
                }[kettle_state],
                dataContract="home.kettle.v1",
                actions=[],
                source=source,
                presentation=ServicePresentation(
                    category="home-device",
                    group="Home infrastructure",
                    overview="quick-control",
                    priority=70,
                    environment="home",
                    freshnessLabel=freshness,
                ),
                data={
                    "stage": kettle_state,
                    "entityId": KETTLE_ENTITY,
                    "authority": "home-assistant",
                    "observedAt": observed.isoformat(),
                },
            ),
        ]

    async def _subscribe_forever(self) -> None:
        delay = 1
        while True:
            try:
                async with websockets.connect(
                    _websocket_url(self._settings.ha_url),
                    open_timeout=10,
                    close_timeout=5,
                ) as socket:
                    hello = json.loads(await socket.recv())
                    if hello.get("type") != "auth_required":
                        raise ValueError("Unexpected Home Assistant WebSocket greeting")
                    await socket.send(
                        json.dumps({"type": "auth", "access_token": self._settings.ha_token})
                    )
                    auth = json.loads(await socket.recv())
                    if auth.get("type") != "auth_ok":
                        raise ValueError("Home Assistant WebSocket authentication failed")
                    await socket.send(
                        json.dumps(
                            {
                                "id": 1,
                                "type": "subscribe_events",
                                "event_type": "state_changed",
                            }
                        )
                    )
                    subscription = json.loads(await socket.recv())
                    if (
                        subscription.get("type") != "result"
                        or subscription.get("id") != 1
                        or not subscription.get("success")
                    ):
                        raise ValueError(
                            "Home Assistant WebSocket subscription failed"
                        )
                    await self._mark_websocket_connected()
                    try:
                        await self.fetch_initial_snapshot()
                    except (httpx.HTTPError, ValueError):
                        await self._mark_cached_or_unavailable()
                    delay = 1
                    async for raw in socket:
                        message = json.loads(raw)
                        event = message.get("event", {})
                        data = event.get("data", {})
                        entity_id = data.get("entity_id")
                        new_state = data.get("new_state")
                        if entity_id in REQUIRED_ENTITIES and isinstance(new_state, dict):
                            await self.apply_state_changed(entity_id, new_state)
                    raise ConnectionError("Home Assistant WebSocket closed")
            except asyncio.CancelledError:
                raise
            except Exception:
                await self._mark_websocket_disconnected()
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def _watch_staleness(self) -> None:
        was_stale = self._is_stale()
        interval = max(1.0, min(15.0, self._settings.ha_stale_after_seconds / 3))
        while True:
            try:
                await asyncio.sleep(interval)
                stale = self._is_stale()
                if stale != was_stale:
                    was_stale = stale
                    await self._notify_change()
            except asyncio.CancelledError:
                raise

    def _replace_states(self, payload: Iterable[Any]) -> None:
        allowlist = set(REQUIRED_ENTITIES)
        self._states = {
            str(item["entity_id"]): _sanitize_state(str(item["entity_id"]), item)
            for item in payload
            if isinstance(item, dict) and item.get("entity_id") in allowlist
        }
        self._observed_at = self._clock()
        self._save_cache()

    def _is_stale(self) -> bool:
        if self._transport_is_live():
            return False
        if not self._states:
            return True
        anchor = (
            self._last_transport_failure_at
            or self._last_successful_rest_at
            or self._observed_at
        )
        if anchor is None:
            return True
        age = (self._clock() - anchor).total_seconds()
        return age > self._settings.ha_stale_after_seconds

    def _transport_is_live(self) -> bool:
        if self._websocket_connected and self._snapshot_confirmed_for_transport:
            return True
        if not self._last_successful_rest_at:
            return False
        if (
            self._last_transport_failure_at
            and self._last_transport_failure_at >= self._last_successful_rest_at
        ):
            return False
        age = (self._clock() - self._last_successful_rest_at).total_seconds()
        return age <= self._settings.ha_stale_after_seconds

    def _current_source(self) -> str:
        if not self._states:
            return "unavailable"
        if self._transport_is_live():
            return "live"
        if self._is_stale():
            return "stale"
        return "cached"

    async def _mark_websocket_connected(self) -> None:
        changed = not self._websocket_connected
        self._websocket_connected = True
        self._last_transport_connected_at = self._clock()
        if self._snapshot_confirmed_for_transport:
            self._source = "live"
        if changed:
            await self._notify_change()

    async def _mark_websocket_disconnected(self) -> None:
        was_connected = self._websocket_connected
        should_record_failure = was_connected or self._source == "live"
        self._websocket_connected = False
        self._snapshot_confirmed_for_transport = False
        if should_record_failure:
            self._last_transport_failure_at = self._clock()
        await self._mark_cached_or_unavailable(force_notify=was_connected)

    async def _mark_cached_or_unavailable(
        self,
        *,
        force_notify: bool = False,
    ) -> None:
        next_source = "cached" if self._states else "unavailable"
        if self._source != next_source or force_notify:
            self._source = next_source
            await self._notify_change()

    async def _notify_change(self) -> None:
        if self._on_change is not None:
            await self._on_change()

    def _load_cache(self) -> None:
        if not self._settings.state_cache_path:
            return
        path = Path(self._settings.state_cache_path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            self._states = {
                entity: _sanitize_state(entity, state)
                for entity, state in payload.get("states", {}).items()
                if entity in REQUIRED_ENTITIES and isinstance(state, dict)
            }
            self._observed_at = datetime.fromisoformat(payload["observedAt"])
            self._source = "cached" if self._states else "unavailable"
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            self._states = {}
            self._observed_at = None

    def _save_cache(self) -> None:
        if not self._settings.state_cache_path or not self._observed_at:
            return
        path = Path(self._settings.state_cache_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "observedAt": self._observed_at.isoformat(),
                    "states": self._states,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        temporary.replace(path)


def _websocket_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((scheme, parsed.netloc, "/api/websocket", "", "", ""))


def _sanitize_state(entity_id: str, state: Dict[str, Any]) -> Dict[str, Any]:
    attributes: Dict[str, Any] = {}
    if entity_id == LAST_ON_ENTITY:
        timestamp = state.get("attributes", {}).get("timestamp")
        if isinstance(timestamp, (int, float)):
            attributes["timestamp"] = timestamp
    return {
        "entity_id": entity_id,
        "state": state.get("state"),
        "last_changed": state.get("last_changed"),
        "last_updated": state.get("last_updated"),
        "attributes": attributes,
    }


def _minutes_to_seconds(state: Optional[Dict[str, Any]]) -> Optional[int]:
    try:
        minutes = float((state or {})["state"])
    except (KeyError, TypeError, ValueError):
        return None
    if minutes <= 0:
        return None
    return int(minutes * 60)


def _state_minutes(state: Optional[Dict[str, Any]]) -> Optional[int]:
    seconds = _minutes_to_seconds(state)
    return seconds // 60 if seconds is not None else None


def _valid_datetime_state(state: Optional[Dict[str, Any]]) -> Optional[str]:
    timestamp = (state or {}).get("attributes", {}).get("timestamp")
    if isinstance(timestamp, (int, float)) and timestamp > 0:
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
    value = str((state or {}).get("state", ""))
    if not value or value in {"unknown", "unavailable", "1970-01-01 00:00:00"}:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat()


def _timing_revision(
    warmup: Optional[Dict[str, Any]],
    long_running: Optional[Dict[str, Any]],
) -> Optional[str]:
    if not warmup or not long_running:
        return None
    return "|".join(
        str(value)
        for value in (
            warmup.get("state"),
            long_running.get("state"),
            warmup.get("last_updated"),
            long_running.get("last_updated"),
        )
    )


def _kettle_state(state: Optional[Dict[str, Any]]) -> str:
    value = str((state or {}).get("state", "")).lower()
    if value in {"off", "idle"}:
        return "off"
    if value in {"on", "heat", "heating"}:
        return "on"
    return "unavailable"


def _coffee_summary(state: str, timing_available: bool) -> str:
    if state == "off":
        return "Выключена"
    if state == "on" and timing_available:
        return "Включена; timing policy получена из Home Assistant"
    if state == "on":
        return "Включена; timing policy недоступна"
    if state == "stale":
        return "Состояние Home Assistant устарело"
    return "Home Assistant entity недоступна"


def _freshness_label(
    observed_at: datetime,
    *,
    now: datetime | None = None,
) -> str:
    seconds = max(
        0,
        int(((now or datetime.now(timezone.utc)) - observed_at).total_seconds()),
    )
    return "только что" if seconds < 10 else f"{seconds} сек назад"


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None
