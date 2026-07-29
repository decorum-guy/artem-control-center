from __future__ import annotations

import asyncio

import httpx

from panel_agent.home_assistant import HomeAssistantAdapter
from panel_agent.http_integrations import HttpIntegrationAdapter
from panel_agent.settings import IntegrationSettings


def _ha_states():
    return [
        {
            "entity_id": "switch.kofemashina",
            "state": "on",
            "last_changed": "2026-07-29T11:54:09Z",
            "last_updated": "2026-07-29T11:54:09Z",
            "attributes": {},
        },
        {
            "entity_id": "input_number.coffee_warmup_minutes",
            "state": "13",
            "last_updated": "2026-07-29T11:59:30Z",
            "attributes": {},
        },
        {
            "entity_id": "input_number.coffee_long_running_minutes",
            "state": "60",
            "last_updated": "2026-07-29T11:59:31Z",
            "attributes": {},
        },
        {
            "entity_id": "input_datetime.coffee_last_turned_on",
            "state": "2026-07-29 11:54:09",
            "last_updated": "2026-07-29T11:54:09Z",
            "attributes": {"timestamp": 1785326049},
        },
        {
            "entity_id": "water_heater.chainik",
            "state": "off",
            "last_updated": "2026-07-29T11:59:30Z",
            "attributes": {},
        },
        *[
            {
                "entity_id": entity,
                "state": "off",
                "last_updated": "2026-07-29T11:59:30Z",
                "attributes": {},
            }
            for entity in (
                "switch.chainik_podderzhanie_tepla",
                "switch.chainik_podsvetka",
                "switch.chainik_bez_zvuka",
            )
        ],
        {
            "entity_id": "sensor.not_allowlisted",
            "state": "private",
            "attributes": {"secret": "must-not-cache"},
        },
    ]


def test_ha_initial_snapshot_normalizes_canonical_helpers(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-token"
        return httpx.Response(200, json=_ha_states())

    settings = IntegrationSettings(
        ha_url="http://ha.test",
        ha_token="test-token",
        state_cache_path=str(tmp_path / "ha-cache.json"),
    )
    adapter = HomeAssistantAdapter(
        settings,
        transport=httpx.MockTransport(handler),
    )
    asyncio.run(adapter.fetch_initial_snapshot())
    services = {service.id: service for service in adapter.services()}
    coffee = services["coffee-machine"]

    assert coffee.source == "live"
    assert coffee.data["machine"]["authority"] == "home-assistant"
    assert coffee.data["machine"]["turnedOnAt"] == "2026-07-29T11:54:09+00:00"
    assert coffee.data["timingPolicy"]["source"] == "home-assistant"
    assert coffee.data["timingPolicy"]["warmupDurationSeconds"] == 780
    assert coffee.data["timingPolicy"]["longRunningThresholdSeconds"] == 3600
    assert coffee.actions and all(not action.enabled for action in coffee.actions)
    assert "not_allowlisted" not in (tmp_path / "ha-cache.json").read_text()


def test_http_adapters_keep_main_and_stage_capabilities_separate():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health/ready":
            return httpx.Response(200, json={"status": "ready"})
        if request.url.path == "/health/details":
            if request.url.host == "bot.test":
                return httpx.Response(
                    200,
                    json={
                        "home_assistant": "ready",
                        "timing_helpers": "ready",
                        "version": "1.0",
                        "commit": "bot-commit",
                    },
                )
            environment = "production" if request.url.host == "main.test" else "stage"
            return httpx.Response(
                200,
                json={
                    "environment": environment,
                    "version": "site-version",
                    "commit": "site-commit",
                    "deployment_revision": "deploy-1",
                },
            )
        return httpx.Response(404)

    adapter = HttpIntegrationAdapter(
        IntegrationSettings(
            avalar_main_url="https://main.test",
            avalar_stage_url="https://stage.test",
            alice_health_url="https://bot.test",
        ),
        transport=httpx.MockTransport(handler),
    )
    asyncio.run(adapter.refresh())
    services = {service.id: service for service in adapter.services()}

    main_actions = {action.id for action in services["avalar-site-main"].actions}
    stage_actions = {action.id for action in services["avalar-site-stage"].actions}
    assert main_actions == {"avalar.main.smoke"}
    assert stage_actions == {"avalar.stage.smoke", "avalar.stage.deploy"}
    assert all(not action.enabled for action in services["avalar-site-stage"].actions)
    assert services["avalar-site-main"].presentation.priority > services[
        "avalar-site-stage"
    ].presentation.priority
    assert services["alice-tg-bot"].data["coffeeTimingAuthority"] is False
