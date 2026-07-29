from __future__ import annotations

import asyncio

import httpx
import pytest

from panel_agent.alice_control import AliceControlClient, AliceControlError
from panel_agent.settings import IntegrationSettings


def test_alice_control_uses_dedicated_token_and_never_returns_it():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers["authorization"]
        return httpx.Response(
            200,
            json={
                "schemaVersion": 1,
                "source": "home-assistant",
                "transport": "alice-tg-bot",
                "revision": "r1",
                "observedAt": "2026-07-29T16:00:00Z",
                "warmupMinutes": 15,
                "longRunningMinutes": 60,
            },
        )

    client = AliceControlClient(
        IntegrationSettings(
            alice_base_url="https://alice.test",
            alice_control_center_token="dedicated-control-token",
        ),
        transport=httpx.MockTransport(handler),
    )
    payload, source = asyncio.run(client.get_timing())
    assert seen["authorization"] == "Bearer dedicated-control-token"
    assert source == "live"
    assert "dedicated-control-token" not in str(payload)


def test_timing_refresh_observes_telegram_side_change_and_caches_outage():
    state = {"warmup": 15, "available": True}

    def handler(request: httpx.Request) -> httpx.Response:
        if not state["available"]:
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(
            200,
            json={
                "schemaVersion": 1,
                "source": "home-assistant",
                "transport": "alice-tg-bot",
                "revision": f"r-{state['warmup']}",
                "observedAt": "2026-07-29T16:00:00Z",
                "warmupMinutes": state["warmup"],
                "longRunningMinutes": 60,
            },
        )

    client = AliceControlClient(
        IntegrationSettings(
            alice_base_url="https://alice.test",
            alice_control_center_token="token",
        ),
        transport=httpx.MockTransport(handler),
    )
    assert asyncio.run(client.get_timing())[0]["warmupMinutes"] == 15
    state["warmup"] = 13
    assert asyncio.run(client.get_timing())[0]["warmupMinutes"] == 13
    state["available"] = False
    cached, source = asyncio.run(client.get_timing())
    assert cached["warmupMinutes"] == 13
    assert source == "stale"


@pytest.mark.parametrize(
    ("upstream", "mapped"),
    [(400, 400), (409, 409), (401, 503), (503, 503)],
)
def test_alice_error_mapping_is_sanitized(upstream, mapped):
    client = AliceControlClient(
        IntegrationSettings(
            alice_base_url="https://alice.test",
            alice_control_center_token="token",
        ),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(upstream, json={"error": "revision_conflict"})
        ),
    )
    with pytest.raises(AliceControlError) as error:
        asyncio.run(
            client.patch_timing(
                {"expectedRevision": "r1", "warmupMinutes": 13}
            )
        )
    assert error.value.status_code == mapped
    assert "token" not in str(error.value)
