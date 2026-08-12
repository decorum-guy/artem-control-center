from __future__ import annotations

import asyncio
import io
import importlib.util
import json
import threading
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.rog_g703_power import (
    ROG_G703_HIBERNATE_ACTION,
    ROG_G703_TARGET_ID,
    ROG_G703_WAKE_ACTION,
    CompanionRequestError,
    RogG703ActionExecutor,
    RogG703ActionRequest,
    RogG703Device,
    WakeOnLanSender,
    build_magic_packet,
    build_rog_g703_action_router,
    parse_mac,
)
from panel_agent.settings import IntegrationSettings


def rog_settings(**overrides) -> IntegrationSettings:
    values = {
        "writes_enabled": True,
        "rog_g703_enabled": True,
        "rog_g703_target_id": ROG_G703_TARGET_ID,
        "rog_g703_mac": "AA:BB:CC:DD:EE:FF",
        "rog_g703_broadcast_address": "255.255.255.255",
        "rog_g703_companion_base_url": "http://127.0.0.1:8769",
        "rog_g703_companion_secret": "s" * 48,
        "rog_g703_wol_repeats": 3,
        "rog_g703_wol_cooldown_seconds": 3,
        "rog_g703_hibernate_cooldown_seconds": 5,
        "rog_g703_health_timeout_seconds": 1,
        "rog_g703_hibernate_timeout_seconds": 1,
        "rog_g703_health_poll_seconds": 5,
    }
    values.update(overrides)
    return IntegrationSettings(**values)


class FakeCompanion:
    def __init__(self, health_values: list[bool] | None = None) -> None:
        self.health_values = list(health_values or [True])
        self.health_calls = 0
        self.hibernate_calls = 0

    async def health(self) -> bool:
        self.health_calls += 1
        if len(self.health_values) > 1:
            return self.health_values.pop(0)
        return self.health_values[0]

    async def hibernate(self) -> None:
        self.hibernate_calls += 1
        self.health_values = [False]


async def wait_terminal(executor: RogG703ActionExecutor, correlation_id: str):
    for _ in range(200):
        current = executor.get(correlation_id)
        if current.status in {"online", "offline", "wake_timeout", "failed"}:
            return current
        await asyncio.sleep(0.01)
    raise AssertionError("ROG action did not reach a terminal state")


def test_magic_packet_is_canonical_and_format_normalization_is_stable() -> None:
    expected_mac = bytes.fromhex("AABBCCDDEEFF")
    expected = b"\xff" * 6 + expected_mac * 16

    assert build_magic_packet("AA:BB:CC:DD:EE:FF") == expected
    assert build_magic_packet("aa-bb-cc-dd-ee-ff") == expected
    assert build_magic_packet("aabb.ccdd.eeff") == expected
    assert len(expected) == 102

    for invalid in ("", "AA:BB:CC:DD:EE", "GG:BB:CC:DD:EE:FF", "01:BB:CC:DD:EE:FF", "00:00:00:00:00:00"):
        with pytest.raises(ValueError, match="invalid_rog_g703_mac"):
            parse_mac(invalid)


def test_wol_sender_uses_only_fixed_broadcast_and_bounded_burst(monkeypatch) -> None:
    sent: list[tuple[bytes, tuple[str, int]]] = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def setsockopt(self, *_):
            return None

        def sendto(self, payload, target):
            sent.append((payload, target))

    monkeypatch.setattr("panel_agent.rog_g703_power.socket.socket", lambda *_: FakeSocket())
    sender = WakeOnLanSender(
        mac=parse_mac("AA:BB:CC:DD:EE:FF"),
        broadcast_address="255.255.255.255",
        broadcast_interface="",
        repeats=99,
    )

    assert sender.send() == 3
    assert len(sent) == 3
    assert {target for _, target in sent} == {("255.255.255.255", 9)}
    assert {payload for payload, _ in sent} == {build_magic_packet("AA:BB:CC:DD:EE:FF")}


def test_action_request_has_no_browser_target_or_command_fields() -> None:
    with pytest.raises(ValidationError):
        RogG703ActionRequest.model_validate(
            {
                "actionId": ROG_G703_WAKE_ACTION,
                "targetId": "anything",
                "mac": "AA:BB:CC:DD:EE:FF",
                "command": "shutdown.exe /s",
            }
        )


def test_wol_send_success_does_not_claim_online_without_companion_health(tmp_path) -> None:
    async def scenario() -> None:
        companion = FakeCompanion([False])
        device = RogG703Device(rog_settings(), companion=companion)
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        executor = RogG703ActionExecutor(
            rog_settings(),
            access,
            device=device,
            wol_sender=lambda: 3,
        )

        started = await executor.start(RogG703ActionRequest(actionId=ROG_G703_WAKE_ACTION))
        finished = await wait_terminal(executor, started.correlationId)

        assert finished.status == "wake_timeout"
        assert finished.result == {"packetsSent": 3, "onlineConfirmed": False}
        assert device.status == "offline"

    asyncio.run(scenario())


def test_health_appearance_confirms_online_and_cooldown_blocks_burst(tmp_path) -> None:
    async def scenario() -> None:
        companion = FakeCompanion([False, True])
        settings = rog_settings()
        device = RogG703Device(settings, companion=companion)
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        calls = 0

        def send() -> int:
            nonlocal calls
            calls += 1
            return 3

        executor = RogG703ActionExecutor(settings, access, device=device, wol_sender=send)
        started = await executor.start(RogG703ActionRequest(actionId=ROG_G703_WAKE_ACTION))
        finished = await wait_terminal(executor, started.correlationId)

        assert finished.status == "online"
        assert finished.result == {"packetsSent": 3, "onlineConfirmed": True}
        assert calls == 1
        assert executor.availability(ROG_G703_WAKE_ACTION)["availability"] == "cooldown"

    asyncio.run(scenario())


def test_hibernate_requires_online_state_and_confirms_unreachable(tmp_path) -> None:
    async def scenario() -> None:
        settings = rog_settings()
        companion = FakeCompanion([True])
        device = RogG703Device(settings, companion=companion)
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        executor = RogG703ActionExecutor(settings, access, device=device, wol_sender=lambda: 3)

        blocked = executor.availability(ROG_G703_HIBERNATE_ACTION)
        assert blocked["availability"] == "precondition_failed"
        await device.set_status("online")

        started = await executor.start(
            RogG703ActionRequest(actionId=ROG_G703_HIBERNATE_ACTION)
        )
        finished = await wait_terminal(executor, started.correlationId)

        assert finished.status == "offline"
        assert finished.result == {"offlineConfirmed": True}
        assert companion.hibernate_calls == 1
        assert device.status == "offline"

    asyncio.run(scenario())


def test_hibernate_does_not_treat_reachable_invalid_health_as_offline() -> None:
    class ReachableButInvalidCompanion:
        async def health(self) -> bool:
            raise CompanionRequestError("invalid_companion_response")

        async def hibernate(self) -> None:
            return None

    async def scenario() -> None:
        device = RogG703Device(
            rog_settings(),
            companion=ReachableButInvalidCompanion(),
        )
        await device.set_status("online")

        assert await device.wait_until_offline(0.01) is False
        assert device.status == "online"

    asyncio.run(scenario())


def test_action_router_exposes_only_safe_status_metadata_and_fixed_routes(tmp_path) -> None:
    settings = rog_settings()
    device = RogG703Device(settings, companion=FakeCompanion([False]))
    access = AccessPolicyStore(tmp_path / "policy.json")
    executor = RogG703ActionExecutor(settings, access, device=device, wol_sender=lambda: 3)
    app = FastAPI()
    app.include_router(build_rog_g703_action_router(executor))
    client = TestClient(app)

    response = client.get("/api/v1/actions/system/rog-g703/availability")
    assert response.status_code == 200
    body = json.dumps(response.json())
    assert "AA:BB:CC:DD:EE:FF" not in body
    assert "255.255.255.255" not in body
    assert "s" * 48 not in body
    assert response.json()["targetId"] == ROG_G703_TARGET_ID

    rejected = client.post(
        "/api/v1/actions/system/rog-g703",
        json={"actionId": ROG_G703_WAKE_ACTION, "command": "anything"},
    )
    assert rejected.status_code == 422


def test_enabled_environment_rejects_invalid_machine_configuration(monkeypatch) -> None:
    monkeypatch.setenv("PANEL_ROG_G703_ENABLED", "true")
    monkeypatch.setenv("PANEL_ROG_G703_MAC", "not-a-mac")
    monkeypatch.setenv("PANEL_ROG_G703_COMPANION_BASE_URL", "http://192.168.1.25:8769")
    monkeypatch.setenv("PANEL_ROG_G703_COMPANION_SECRET", "s" * 48)

    with pytest.raises(RuntimeError, match="PANEL_ROG_G703_MAC"):
        IntegrationSettings.from_env()


def test_companion_http_contract_requires_auth_and_invokes_fixed_s4_operation(monkeypatch, tmp_path) -> None:
    companion_path = Path(__file__).resolve().parents[3] / "scripts" / "windows" / "rog_g703_companion.py"
    spec = importlib.util.spec_from_file_location("rog_g703_companion_test", companion_path)
    assert spec and spec.loader
    companion_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(companion_module)

    secret = "test-secret-" + "x" * 37
    config_path = tmp_path / "companion.json"
    config_path.write_text(
        json.dumps({"listenAddress": "127.0.0.1", "port": 8769, "secret": secret}),
        encoding="utf-8",
    )
    hibernated = threading.Event()

    class FakeServer:
        def __init__(self):
            self.secret = secret
            self.handler = None

        def schedule_hibernate(self):
            assert self.handler is not None
            assert b"202 Accepted" in self.handler.wfile.getvalue()
            hibernated.set()

    def request(method: str, path: str, *, headers=None, body=b""):
        handler = object.__new__(companion_module.CompanionRequestHandler)
        handler.server = FakeServer()
        handler.server.handler = handler
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.headers = Message()
        for key, value in (headers or {}).items():
            handler.headers[key] = value
        if body:
            handler.headers["Content-Length"] = str(len(body))
        handler.path = path
        handler.request_version = "HTTP/1.1"
        handler.requestline = f"{method} {path} HTTP/1.1"
        handler.command = method
        handler.close_connection = False
        getattr(handler, f"do_{method}")()
        output = handler.wfile.getvalue()
        first_line = output.splitlines()[0].decode("ascii")
        return int(first_line.split(" ", 2)[1]), output

    assert request("GET", "/health")[0] == 401
    assert request("GET", "/health", headers={"Authorization": "Bearer wrong"})[0] == 401
    assert request("GET", "/health", headers={"Authorization": f"Bearer {secret}"})[0] == 200
    assert request("GET", "/unknown", headers={"Authorization": f"Bearer {secret}"})[0] == 404
    assert request("PUT", "/health", headers={"Authorization": f"Bearer {secret}"})[0] == 405
    assert request("POST", "/hibernate", headers={"Authorization": f"Bearer {secret}"}, body=b"{}")[0] == 400
    status_code, body = request(
        "POST",
        "/hibernate",
        headers={"Authorization": f"Bearer {secret}"},
    )
    assert status_code == 202
    assert b"accepted" in body
    assert hibernated.is_set()

    calls = []

    def fake_popen(arguments, **kwargs):
        calls.append((arguments, kwargs))
        return SimpleNamespace()

    monkeypatch.setattr(companion_module.subprocess, "Popen", fake_popen)
    companion_module.FixedHibernateExecutor()()
    assert calls == [(["shutdown.exe", "/h"], {"close_fds": True})]

    source = companion_path.read_text(encoding="utf-8")
    for forbidden in ("/exec", "/command", "/powershell", "/shell", "/run", "/process", "/url", "/proxy"):
        assert forbidden not in source
    assert secret not in body.decode("utf-8")
