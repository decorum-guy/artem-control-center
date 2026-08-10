from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.connectivity_actions import (
    ConnectivityActionExecutor,
    ConnectivityActionRequest,
)
from panel_agent.settings import IntegrationSettings


class FakeHomeAssistant:
    def __init__(self, *, live: bool = True) -> None:
        self.live = live
        self.fetches = 0

    async def fetch_initial_snapshot(self) -> None:
        self.fetches += 1

    def services(self):
        return [
            SimpleNamespace(
                id="home-assistant",
                source="live" if self.live else "stale",
                health="healthy" if self.live else "stale",
                data={
                    "transport": {
                        "websocketConnected": self.live,
                        "snapshotConfirmed": self.live,
                    }
                },
            )
        ]


class FakeHttp:
    def __init__(self, *, alice_live: bool = True) -> None:
        self.alice_live = alice_live
        self.refreshes = 0

    async def refresh(self) -> bool:
        self.refreshes += 1
        return self.alice_live

    def services(self):
        return [
            SimpleNamespace(
                id="alice-tg-bot",
                source="live" if self.alice_live else "unavailable",
                health="healthy" if self.alice_live else "offline",
                data={},
            )
        ]


class FakeRuntime:
    def __init__(self, *, ha_live: bool = True, alice_live: bool = True) -> None:
        self.home_assistant = FakeHomeAssistant(live=ha_live)
        self.http = FakeHttp(alice_live=alice_live)


def settings(*, loopback: bool = True) -> IntegrationSettings:
    return IntegrationSettings(
        ha_url="http://127.0.0.1:18123" if loopback else "https://ha.example",
        alice_health_url="http://127.0.0.1:18088" if loopback else "https://bot.example",
    )


async def wait_terminal(executor: ConnectivityActionExecutor, correlation_id: str):
    for _ in range(200):
        current = executor.get(correlation_id)
        if current.status in {"connected", "degraded", "failed"}:
            return current
        await asyncio.sleep(0.01)
    raise AssertionError("connectivity action did not reach a terminal state")


def test_connectivity_recovery_is_standard_level_and_read_only_is_blocked(tmp_path):
    async def scenario() -> None:
        calls = 0

        async def restart() -> None:
            nonlocal calls
            calls += 1

        async def ready(_: str, __: int) -> bool:
            return True

        access = AccessPolicyStore(tmp_path / "policy.json")
        executor = ConnectivityActionExecutor(
            settings(),
            access,
            runtime=FakeRuntime(),
            restart_runner=restart,
            port_probe=ready,
            forwards_timeout_seconds=1,
            verification_timeout_seconds=1,
        )

        assert executor.availability()["availability"] == "profile_blocked"
        with pytest.raises(HTTPException) as blocked:
            await executor.start(
                ConnectivityActionRequest(actionId="system.connectivity.restart")
            )
        assert blocked.value.detail == "profile_blocked"
        assert calls == 0

        access.set_profile("standard")
        assert executor.availability()["allowed"] is True
        assert executor.availability()["availability"] == "allowed"

        started = await executor.start(
            ConnectivityActionRequest(actionId="system.connectivity.restart")
        )
        finished = await wait_terminal(executor, started.correlationId)
        assert finished.status == "connected"
        assert calls == 1
        assert finished.result == {
            "homeAssistantForwardReady": True,
            "aliceForwardReady": True,
            "homeAssistantLive": True,
            "homeAssistantWebSocket": True,
            "homeAssistantSnapshotConfirmed": True,
            "aliceLive": True,
            "aliceHealthy": True,
        }

    asyncio.run(scenario())


def test_connectivity_request_rejects_browser_supplied_process_or_command_fields():
    with pytest.raises(ValidationError):
        ConnectivityActionRequest.model_validate(
            {
                "actionId": "system.connectivity.restart",
                "taskName": "Anything Else",
                "pid": 123,
                "command": "arbitrary",
            }
        )


def test_partial_forward_recovery_is_degraded_not_success(tmp_path):
    async def scenario() -> None:
        async def restart() -> None:
            return None

        async def only_ha(_: str, port: int) -> bool:
            return port == 18123

        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        executor = ConnectivityActionExecutor(
            settings(),
            access,
            runtime=FakeRuntime(),
            restart_runner=restart,
            port_probe=only_ha,
            forwards_timeout_seconds=1,
            verification_timeout_seconds=1,
        )

        started = await executor.start(
            ConnectivityActionRequest(actionId="system.connectivity.restart")
        )
        finished = await wait_terminal(executor, started.correlationId)
        assert finished.status == "degraded"
        assert finished.error == "partial_forward_recovery"
        assert finished.result == {
            "homeAssistantForwardReady": True,
            "aliceForwardReady": False,
        }

    asyncio.run(scenario())


def test_downstream_health_must_be_fresh_after_both_forwards_return(tmp_path):
    async def scenario() -> None:
        async def restart() -> None:
            return None

        async def ready(_: str, __: int) -> bool:
            return True

        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        executor = ConnectivityActionExecutor(
            settings(),
            access,
            runtime=FakeRuntime(ha_live=True, alice_live=False),
            restart_runner=restart,
            port_probe=ready,
            forwards_timeout_seconds=1,
            verification_timeout_seconds=1,
        )

        started = await executor.start(
            ConnectivityActionRequest(actionId="system.connectivity.restart")
        )
        finished = await wait_terminal(executor, started.correlationId)
        assert finished.status == "degraded"
        assert finished.error == "downstream_verification_incomplete"
        assert finished.result is not None
        assert finished.result["homeAssistantLive"] is True
        assert finished.result["aliceLive"] is False

    asyncio.run(scenario())


def test_duplicate_restart_is_rejected_while_first_action_is_active(tmp_path):
    async def scenario() -> None:
        release = asyncio.Event()

        async def restart() -> None:
            await release.wait()

        async def ready(_: str, __: int) -> bool:
            return True

        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_profile("standard")
        executor = ConnectivityActionExecutor(
            settings(),
            access,
            runtime=FakeRuntime(),
            restart_runner=restart,
            port_probe=ready,
            forwards_timeout_seconds=1,
            verification_timeout_seconds=1,
        )

        first = await executor.start(
            ConnectivityActionRequest(actionId="system.connectivity.restart")
        )
        await asyncio.sleep(0)
        assert executor.availability()["availability"] == "busy"
        with pytest.raises(HTTPException) as duplicate:
            await executor.start(
                ConnectivityActionRequest(actionId="system.connectivity.restart")
            )
        assert duplicate.value.detail == "busy"

        release.set()
        finished = await wait_terminal(executor, first.correlationId)
        assert finished.status == "connected"

    asyncio.run(scenario())


def test_non_loopback_connectivity_configuration_fails_closed(tmp_path):
    async def unused_restart() -> None:
        raise AssertionError("non-loopback configuration must never execute")

    access = AccessPolicyStore(tmp_path / "policy.json")
    access.set_profile("standard")
    executor = ConnectivityActionExecutor(
        settings(loopback=False),
        access,
        runtime=FakeRuntime(),
        restart_runner=unused_restart,
    )
    assert executor.availability()["availability"] == "integration_unavailable"
