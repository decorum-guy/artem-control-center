from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event

import httpx
import pytest
import yaml

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.home_assistant import HomeAssistantAdapter
from panel_agent.panel_brightness import (
    COMMAND_EVENT, STATE_EVENT, TARGET, PanelBrightnessBridge, parse_brightness_event,
)
from panel_agent.settings import IntegrationSettings
from panel_agent.system_controls import SystemControlsError

NOW = datetime(2026, 11, 27, tzinfo=timezone.utc)


def command(percent=10, identity="brightness-test-01", *, age=0):
    return {
        "event_type": COMMAND_EVENT, "origin": "LOCAL", "context": {"id": identity},
        "time_fired": (NOW - timedelta(seconds=age)).isoformat(),
        "data": {"target": TARGET, "percent": percent, "request_id": identity},
    }


class Controls:
    supported_platform = True

    def __init__(self, value=50):
        self.value = value
        self.calls = []
        self.reads = 0
        self.error = None
        self.reported = None

    def read(self):
        self.reads += 1
        return {"brightness": {"available": True, "value": self.value}}

    def set_value(self, control, value):
        self.calls.append((control, value))
        if self.error:
            raise SystemControlsError(self.error)
        self.value = value if self.reported is None else self.reported
        return {"available": True, "value": self.value}


def bridge(tmp_path, *, controls=None, profile="standard", enabled=True, ready=True, publish=None, clock=None):
    path = tmp_path / "brightness-access.json"
    path.write_text(json.dumps({"schemaVersion": 1, "baseProfile": profile}))
    policy = AccessPolicyStore(path)
    reports = []

    async def collect(report):
        reports.append(report)

    controls = controls or Controls()
    subject = PanelBrightnessBridge(
        controls=controls, access=lambda: policy, write_enabled=lambda: enabled,
        ingress_ready=lambda: ready, publish=publish or collect, clock=clock or (lambda: NOW),
    )
    return subject, controls, reports, policy


@pytest.mark.parametrize("percent", [0, 1, 10, 37, 99, 100])
def test_percent_is_an_absolute_integer_not_a_0_to_1_fraction(percent):
    assert parse_brightness_event(command(percent), NOW)[1] == percent


@pytest.mark.parametrize("percent", [-1, 101, 10.5, "10", True, False, None, {}, [10], float("nan")])
def test_rejects_non_integer_or_out_of_range(percent):
    assert parse_brightness_event(command(percent), NOW) is None


@pytest.mark.parametrize("mutation", [
    lambda e: e.update(event_type="yandex_scenario"),
    lambda e: e.update(origin="REMOTE"),
    lambda e: e.update(time_fired="bad"),
    lambda e: e.update(context={}),
    lambda e: e["data"].update(target="other_monitor"),
    lambda e: e["data"].update(command="shutdown"),
    lambda e: e["data"].update(request_id=""),
    lambda e: e["data"].update(request_id="x" * 81),
    lambda e: e["data"].update(request_id="bad/request/id"),
])
def test_rejects_wrong_target_extra_command_or_malformed_envelope(mutation):
    event = command()
    mutation(event)
    assert parse_brightness_event(event, NOW) is None


@pytest.mark.parametrize("age", [13, 500, -3])
def test_rejects_expired_or_future_events(age):
    assert parse_brightness_event(command(age=age), NOW) is None


def test_one_command_and_actual_readback_no_speech_or_network_command_string(tmp_path):
    async def check():
        subject, controls, reports, _ = bridge(tmp_path)
        subject.handle(command())
        await subject.task
        assert controls.calls == [("brightness", 10)]
        assert reports[-1] == {
            "target": TARGET, "value": 10, "available": True, "writable": True,
            "observed_at": NOW.isoformat(), "request_id": "brightness-test-01", "outcome": "confirmed",
        }
        subject.handle(command())
        assert len(controls.calls) == 1
        await subject.close()
        assert reports[-1]["available"] is False
        subject.handle(command(30, "brightness-after-close"))
        assert subject.task is None
    asyncio.run(check())


@pytest.mark.parametrize(("profile", "enabled", "ready"), [
    ("read_only", True, True), ("full", False, True), ("standard", True, False),
])
def test_access_runtime_and_subscription_gates_block_mutation(tmp_path, profile, enabled, ready):
    async def check():
        subject, controls, reports, _ = bridge(tmp_path, profile=profile, enabled=enabled, ready=ready)
        subject.handle(command())
        await subject.task
        assert controls.calls == []
        assert reports[-1]["outcome"] == "blocked"
        assert reports[-1]["writable"] is False
    asyncio.run(check())


def test_gate_is_rechecked_after_waiting_for_observation_lock(tmp_path):
    async def check():
        subject, controls, reports, policy = bridge(tmp_path)
        await subject._operation_lock.acquire()
        subject.handle(command())
        await asyncio.sleep(0)
        policy.set_profile("read_only")
        subject._operation_lock.release()
        await subject.task
        assert controls.calls == []
        assert reports[-1]["outcome"] == "blocked"
    asyncio.run(check())


def test_waiting_command_is_not_dispatched_after_expiration(tmp_path):
    async def check():
        now = [NOW]
        subject, controls, reports, _ = bridge(tmp_path, clock=lambda: now[0])
        await subject._operation_lock.acquire()
        subject.handle(command())
        await asyncio.sleep(0)
        now[0] += timedelta(seconds=13)
        subject._operation_lock.release()
        await subject.task
        assert controls.calls == []
        assert reports[-1]["outcome"] == "expired"
    asyncio.run(check())


def test_actual_quantized_level_is_not_false_success(tmp_path):
    async def check():
        subject, controls, reports, _ = bridge(tmp_path)
        controls.reported = 12
        subject.handle(command(10))
        await subject.task
        assert reports[-1]["value"] == 12
        assert reports[-1]["available"] is True
        assert reports[-1]["outcome"] == "unconfirmed"
    asyncio.run(check())


@pytest.mark.parametrize("error", ["system_controls_timeout", "system_controls_busy", "brightness_unavailable"])
def test_controller_failure_is_not_retried(tmp_path, error):
    async def check():
        subject, controls, reports, _ = bridge(tmp_path)
        controls.error = error
        subject.handle(command())
        await subject.task
        subject.handle(command())
        assert len(controls.calls) == 1
        assert reports[-1]["outcome"] == ("busy" if error.endswith("busy") else "unconfirmed")
        assert reports[-1]["value"] is None
    asyncio.run(check())


def test_lost_ack_does_not_repeat_physical_command(tmp_path):
    async def check():
        async def failed_publish(_):
            raise httpx.ConnectError("synthetic outage")
        subject, controls, _, _ = bridge(tmp_path, publish=failed_publish)
        subject.handle(command())
        await subject.task
        subject.handle(command())
        assert controls.calls == [("brightness", 10)]
    asyncio.run(check())


def test_busy_commands_dropped_and_reader_remains_responsive(tmp_path):
    async def check():
        started, release = Event(), Event()

        class SlowControls(Controls):
            def set_value(self, control, value):
                started.set()
                assert release.wait(3)
                return super().set_value(control, value)

        subject, controls, _, _ = bridge(tmp_path, controls=SlowControls())
        subject.handle(command())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            subject.handle(command(20, "brightness-busy-02"))
            await asyncio.sleep(0)  # command has not blocked the HA reader
        finally:
            release.set()
        await subject.task
        subject.handle(command(20, "brightness-busy-02"))
        assert controls.calls == [("brightness", 10)]
        await subject.close()
    asyncio.run(check())


def test_periodic_read_observes_manual_change_and_start_is_singleton(tmp_path):
    async def check():
        subject, controls, reports, _ = bridge(tmp_path)
        await subject.refresh()
        assert reports[-1]["value"] == 50
        controls.value = 7
        await subject.refresh()
        assert reports[-1]["value"] == 7
        assert controls.calls == []
        subject.start()
        task = subject._report_task
        subject.start()
        assert subject._report_task is task
        await subject.close()
        assert subject._report_task is None
    asyncio.run(check())


class Socket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        return json.dumps(next(self.messages))

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return json.dumps(next(self.messages))
        except StopIteration:
            raise StopAsyncIteration


def adapter(tmp_path, transport=None):
    return HomeAssistantAdapter(
        IntegrationSettings(ha_url="http://ha.test", ha_token="fixture-token",
                            state_cache_path=str(tmp_path / "ha.json")),
        transport=transport or httpx.MockTransport(lambda _: httpx.Response(200, json=[])),
    )


def test_existing_socket_subscribes_once_and_requires_ack_then_resubscribes(tmp_path):
    async def check():
        subject = adapter(tmp_path)
        events = []
        subject.set_panel_brightness_handler(events.append)
        payload = {"type": "event", "id": 4, "event": command()}
        socket = Socket([
            {"type": "result", "id": 1, "success": True}, payload,
            {"type": "result", "id": 4, "success": True}, payload,
            dict(payload, id=3), dict(payload, type="result"),
        ])
        await subject._subscribe_socket(socket)
        assert events == [command()]
        assert socket.sent == [
            {"type": "subscribe_events", "id": 1, "event_type": "state_changed"},
            {"type": "subscribe_events", "id": 4, "event_type": COMMAND_EVENT},
        ]
        await subject._mark_websocket_disconnected()
        await subject._handle_websocket_event(payload)
        assert len(events) == 1
        socket2 = Socket([
            {"type": "result", "id": 1, "success": True},
            {"type": "result", "id": 4, "success": True}, payload,
        ])
        await subject._subscribe_socket(socket2)
        assert len(events) == 2
        assert subject.panel_brightness_subscribed
    asyncio.run(check())


def test_brightness_denial_does_not_break_core_or_tv_subscription(tmp_path):
    async def check():
        subject = adapter(tmp_path)
        brightness, tv = [], []
        subject.set_panel_brightness_handler(brightness.append)
        subject.set_yandex_scenario_handler(tv.append)
        tv_event = {"event_type": "yandex_scenario", "data": {"fixture": True}}
        socket = Socket([
            {"type": "result", "id": 1, "success": True},
            {"type": "result", "id": 3, "success": True},
            {"type": "result", "id": 4, "success": False},
            {"type": "event", "id": 4, "event": command()},
            {"type": "event", "id": 3, "event": tv_event},
        ])
        await subject._subscribe_socket(socket)
        assert subject._websocket_connected
        assert not subject.panel_brightness_subscribed
        assert brightness == []
        assert tv == [tv_event]
    asyncio.run(check())


def test_state_publish_is_fixed_and_rejects_extra_network_fields(tmp_path):
    async def check():
        requests = []
        def receive(request):
            requests.append((str(request.url), json.loads(request.content)))
            return httpx.Response(200, json={"message": "Event fired."})
        subject = adapter(tmp_path, httpx.MockTransport(receive))
        _, _, reports, _ = bridge(tmp_path)
        report = {"target": TARGET, "available": True, "value": 10, "writable": True,
                  "observed_at": NOW.isoformat(), "request_id": "brightness-state-01", "outcome": "confirmed"}
        await subject.publish_panel_brightness_state(report)
        assert requests == [(f"http://ha.test/api/events/{STATE_EVENT}", report)]
        for invalid in [dict(report, url="http://evil.test"), dict(report, value=True),
                        dict(report, value=101), dict(report, target="other"),
                        dict(report, outcome="secret detail"), dict(report, available=False)]:
            with pytest.raises(ValueError):
                await subject.publish_panel_brightness_state(invalid)
        assert len(requests) == 1
        assert reports == []
    asyncio.run(check())


def test_feature_is_disabled_by_default_and_explicit_env_enables(monkeypatch):
    monkeypatch.delenv("PANEL_BRIGHTNESS_VOICE_ENABLED", raising=False)
    assert IntegrationSettings.from_env().panel_brightness_voice_enabled is False
    monkeypatch.setenv("PANEL_BRIGHTNESS_VOICE_ENABLED", "true")
    assert IntegrationSettings.from_env().panel_brightness_voice_enabled is True


def test_ha_package_contract_matches_typed_bridge_and_nonoptimistic_route():
    root = Path(__file__).resolve().parents[3]
    base = root / "integration-patches/home-assistant"
    package = yaml.safe_load((base / "config/packages/panel_brightness.yaml").read_text())
    exposure = yaml.safe_load((base / "panel-brightness-yandex.example.yaml").read_text())
    assert package["template"][0]["triggers"][0]["event_type"] == STATE_EVENT
    assert package["template"][0]["triggers"][0]["event_data"] == {"target": TARGET}
    assert package["artem_panel"] == {}
    assert "script" not in package  # no ignored mode=single call can claim success
    entity = exposure["yandex_smart_home"]["entity_config"]["sensor.artem_panel_brightness"]
    assert entity.get("slow", False) is False
    assert "DEVICE_UNREACHABLE" in entity["error_code_template"]
    value = entity["custom_ranges"]["brightness"]
    assert value["range"] == {"min": 0, "max": 100, "precision": 1}
    assert value["set_value"]["action"] == "artem_panel.set_brightness"
