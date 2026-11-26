"""Controlled HA adapter/gateway checks, not a live HA or Samsung acceptance."""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
import voluptuous as vol
import yaml
from jinja2 import Environment, StrictUndefined

ROOT = Path(__file__).resolve().parents[3]
COMPONENT = ROOT / "integration-patches/home-assistant/config/custom_components/artem_panel"
NOW = datetime(2026, 11, 27, tzinfo=timezone.utc)


def load_gateway():
    spec = importlib.util.spec_from_file_location("brightness_gateway_fixture", COMPONENT / "request_gateway.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_state(**overrides):
    return {"available": True, "writable": True, "observed_at": NOW.isoformat(), **overrides}


class Harness:
    def __init__(self, *, state=None, auto_reply=True, timeout=0.05):
        self.module = load_gateway()
        self.state = fresh_state() if state is None else state
        self.listeners, self.requests = [], []
        self.auto_reply = auto_reply
        self.reply_changes = {}
        self.gateway = self.module.BrightnessGateway(
            state=lambda: self.state, subscribe=self.subscribe, fire=self.fire,
            clock=lambda: NOW, timeout=timeout,
        )

    def subscribe(self, callback):
        self.listeners.append(callback)
        return lambda: self.listeners.remove(callback)

    def fire(self, data):
        self.requests.append(data)
        if self.auto_reply:
            self.reply(data)

    def reply(self, data):
        report = {"target": "samsung_panel", "request_id": data["request_id"],
                  "available": True, "value": data["percent"], "outcome": "confirmed",
                  "observed_at": NOW.isoformat(), **self.reply_changes}
        for callback in list(self.listeners):
            callback(report)


def test_immediate_reply_is_captured_after_listener_is_registered():
    async def check():
        harness = Harness()
        assert await harness.gateway.set_brightness(10.0) == 10
        assert harness.requests[0]["percent"] == 10
        assert type(harness.requests[0]["percent"]) is int
        assert harness.listeners == []
    asyncio.run(check())


def test_concurrent_request_is_an_explicit_error_then_lock_is_reusable():
    async def check():
        h = Harness(auto_reply=False)
        first = asyncio.create_task(h.gateway.set_brightness(10))
        await asyncio.sleep(0)
        with pytest.raises(h.module.BrightnessRequestError, match="busy"):
            await h.gateway.set_brightness(20)
        assert len(h.requests) == 1
        h.reply(h.requests[0])
        assert await first == 10
        h.auto_reply = True
        assert await h.gateway.set_brightness(20) == 20
        assert h.listeners == []
    asyncio.run(check())


@pytest.mark.parametrize("state", [
    {}, fresh_state(available=False), fresh_state(writable=False),
    fresh_state(observed_at=(NOW - timedelta(seconds=90)).isoformat()),
    fresh_state(observed_at=(NOW + timedelta(seconds=3)).isoformat()),
    fresh_state(observed_at="invalid"), fresh_state(observed_at="2026-11-27T00:00:00"),
])
def test_state_must_be_available_writable_and_recent_before_dispatch(state):
    async def check():
        h = Harness(state=state)
        with pytest.raises(h.module.BrightnessRequestError, match="unavailable"):
            await h.gateway.set_brightness(10)
        assert h.requests == []
    asyncio.run(check())


@pytest.mark.parametrize("changes", [
    {"request_id": "another-request"}, {"target": "other"}, {"value": 11},
    {"value": True}, {"available": False}, {"outcome": "unconfirmed"},
    {"observed_at": (NOW - timedelta(seconds=90)).isoformat()},
])
def test_only_matching_actual_readback_is_success(changes):
    async def check():
        h = Harness(timeout=0.005)
        h.reply_changes = changes
        with pytest.raises(h.module.BrightnessRequestError, match="unconfirmed"):
            await h.gateway.set_brightness(10)
        assert len(h.requests) == 1
        assert h.listeners == []
        assert not h.gateway._lock.locked()
    asyncio.run(check())


def test_timeout_late_reply_and_close_never_resend():
    async def check():
        h = Harness(auto_reply=False, timeout=0.005)
        with pytest.raises(h.module.BrightnessRequestError, match="unconfirmed"):
            await h.gateway.set_brightness(10)
        h.reply(h.requests[0])
        assert len(h.requests) == 1 and not h.listeners
        h.gateway.close()
        with pytest.raises(h.module.BrightnessRequestError, match="unavailable"):
            await h.gateway.set_brightness(10)
    asyncio.run(check())


def test_cancellation_unsubscribes_and_releases_busy_guard():
    async def check():
        h = Harness(auto_reply=False)
        task = asyncio.create_task(h.gateway.set_brightness(10))
        await asyncio.sleep(0)
        h.gateway.close()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert h.listeners == []
        assert not h.gateway._lock.locked()
        assert len(h.requests) == 1
    asyncio.run(check())


@pytest.mark.parametrize("value", [True, False, "10", None, -1, 101, 10.5, float("nan"), float("inf")])
def test_boundary_does_not_coerce_malformed_values(value):
    with pytest.raises(ValueError, match="brightness_percent_invalid"):
        load_gateway().validate_percent(value)


def load_component(monkeypatch):
    class HAError(Exception):
        pass
    package = ModuleType("homeassistant")
    core, const, exceptions = ModuleType("homeassistant.core"), ModuleType("homeassistant.const"), ModuleType("homeassistant.exceptions")
    core.HomeAssistant = SimpleNamespace
    core.ServiceCall = SimpleNamespace
    core.callback = lambda callback: callback
    const.EVENT_HOMEASSISTANT_STOP = "homeassistant_stop"
    exceptions.HomeAssistantError = HAError
    for name, module in [("homeassistant", package), ("homeassistant.core", core),
                         ("homeassistant.const", const), ("homeassistant.exceptions", exceptions)]:
        monkeypatch.setitem(sys.modules, name, module)
    name = "fixture_artem_panel"
    for imported in list(sys.modules):
        if imported == name or imported.startswith(name + "."):
            monkeypatch.delitem(sys.modules, imported)
    spec = importlib.util.spec_from_file_location(name, COMPONENT / "__init__.py", submodule_search_locations=[str(COMPONENT)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module, HAError


class Bus:
    def __init__(self):
        self.listeners, self.fired = {}, []
        self.on_command = None

    def async_listen(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)
        return lambda: self.listeners[name].remove(callback)

    def async_listen_once(self, name, callback):
        def once(event):
            remove()
            callback(event)
        remove = self.async_listen(name, once)
        return remove

    def async_fire(self, name, data):
        self.fired.append((name, data))
        for callback in list(self.listeners.get(name, [])):
            callback(SimpleNamespace(data=data))
        if name == "artem_panel_brightness_command" and self.on_command:
            self.on_command(data)


class Services:
    def __init__(self):
        self.registered = {}

    def async_register(self, domain, name, callback, *, schema):
        self.registered[(domain, name)] = (callback, schema)

    def async_remove(self, domain, name):
        del self.registered[(domain, name)]

    async def call(self, data):
        callback, schema = self.registered[("artem_panel", "set_brightness")]
        return await callback(SimpleNamespace(data=schema(data)))


def test_actual_setup_registration_schema_busy_error_and_stop(monkeypatch):
    async def check():
        module, HAError = load_component(monkeypatch)
        bus, services = Bus(), Services()
        hass = SimpleNamespace(data={}, bus=bus, services=services,
                               states=SimpleNamespace(get=lambda _: SimpleNamespace(state="50", attributes=fresh_state())))
        assert await module.async_setup(hass, {"artem_panel": {}})
        assert await module.async_setup(hass, {"artem_panel": {}})  # no duplicate handlers
        gateway = hass.data["artem_panel"]
        gateway.clock = lambda: NOW
        gateway.timeout = 0.02
        assert len(services.registered) == 1
        for data in [{}, {"percent": True}, {"percent": "10"}, {"percent": 10, "command": "evil"}]:
            with pytest.raises(vol.Invalid):
                await services.call(data)
        first = asyncio.create_task(services.call({"percent": 10}))
        await asyncio.sleep(0)
        with pytest.raises(HAError, match="уже выполняется"):
            await services.call({"percent": 20})
        request = bus.fired[0][1]
        bus.async_fire("artem_panel_brightness_state", {
            **fresh_state(), "target": "samsung_panel", "value": 10,
            "request_id": request["request_id"], "outcome": "confirmed",
        })
        await first
        assert len([item for item in bus.fired if item[0] == "artem_panel_brightness_command"]) == 1
        with pytest.raises(HAError, match="не подтверждена"):
            await services.call({"percent": 30})
        bus.async_fire("homeassistant_stop", {})
        assert not services.registered and not hass.data
        assert not bus.listeners["artem_panel_brightness_state"]
    asyncio.run(check())


def as_timestamp(value, default=0):
    try:
        return value.timestamp() if isinstance(value, datetime) else datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError, AttributeError):
        return default


@pytest.mark.parametrize(("platform", "age", "available", "expected"), [
    ("event", 0, True, True), ("event", 89, True, True), ("event", 90, True, False),
    ("event", 0, False, False), ("event", -3, True, False),
    ("time_pattern", 89, True, True), ("time_pattern", 90, True, False),
    ("homeassistant", 0, True, False),
])
def test_actual_ha_sensor_template_expires_and_resets_on_ha_start(platform, age, available, expected):
    base = ROOT / "integration-patches/home-assistant"
    package = yaml.safe_load((base / "config/packages/panel_brightness.yaml").read_text())
    sensor = package["template"][0]["sensor"][0]
    env = Environment(undefined=StrictUndefined)
    observed_at = (NOW - timedelta(seconds=age)).isoformat()
    values = {"available": available, "writable": True, "value": 10, "observed_at": observed_at,
              "request_id": "fixture-id", "outcome": "confirmed"}
    context = {"trigger": SimpleNamespace(platform=platform, event=SimpleNamespace(data=values)),
               "this": SimpleNamespace(state="10", attributes=values), "now": lambda: NOW,
               "as_timestamp": as_timestamp}
    assert env.from_string(sensor["availability"]).render(**context).strip() == str(expected)
    for value in sensor["attributes"].values():
        env.from_string(value).render(**context)  # every event/timer/start branch is defined
    assert env.from_string(sensor["state"]).render(**context).strip() == "10"
