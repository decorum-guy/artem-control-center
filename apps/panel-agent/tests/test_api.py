import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch, mode: str):
    monkeypatch.setenv("PANEL_AGENT_MODE", mode)
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def test_fixture_snapshot_covers_bot_independence(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)

    response = client.get("/api/v1/snapshot?scenario=alice-down-ha-healthy")
    assert response.status_code == 200
    services = {service["id"]: service for service in response.json()["services"]}
    assert services["home-assistant"]["health"] == "healthy"
    assert services["coffee-machine"]["health"] == "healthy"
    assert services["coffee-machine"]["data"]["machine"]["state"] == "on"
    assert services["coffee-machine"]["data"]["timingPolicy"]["source"] == "home-assistant"
    assert services["coffee-machine"]["data"]["timingPolicy"]["sourceAvailable"] is True
    assert services["coffee-machine"]["data"]["timingPolicy"]["stale"] is False
    assert services["coffee-machine"]["presentation"]["overview"] == "primary"
    assert services["home-assistant"]["presentation"]["role"] == "home-authority"
    assert services["alice-tg-bot"]["health"] == "offline"
    assert services["alice-tg-bot"]["data"]["coffeeTimingAuthority"] is False


def test_fixture_service_update_is_visible(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)
    payload = {
        "id": "new-monitor",
        "title": "New Monitor",
        "enabled": True,
        "dataContract": "service.health.v1",
        "health": "healthy",
        "summary": "Created by deterministic test",
        "actions": [],
        "data": {},
    }

    assert client.post("/api/v1/fixtures/services", json=payload).status_code == 201
    services = client.get("/api/v1/snapshot").json()["services"]
    assert any(service["id"] == "new-monitor" for service in services)


def test_fixture_mutation_is_not_available_in_read_only(monkeypatch):
    module = load_app(monkeypatch, "read_only")
    client = TestClient(module.app)
    response = client.post(
        "/api/v1/fixtures/services",
        json={
            "id": "blocked-monitor",
            "title": "Blocked",
            "dataContract": "service.health.v1",
            "health": "healthy",
            "summary": "Must not be accepted",
            "actions": [],
            "data": {},
        },
    )
    assert response.status_code == 404
    assert client.get("/health/ready").json()["writesEnabled"] is False


def test_required_fixture_catalog_is_complete(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)
    scenarios = set(client.get("/api/v1/fixtures").json()["scenarios"])
    assert {
        "ha-healthy",
        "ha-degraded",
        "ha-offline",
        "coffee-off",
        "coffee-turning-on",
        "coffee-warming",
        "coffee-ready",
        "coffee-running-too-long",
        "coffee-stale",
        "kettle-on",
        "kettle-off",
        "kettle-unavailable",
        "alice-down-ha-healthy",
        "alice-down-policy-stale",
        "ha-offline-policy-available",
        "coffee-no-timing-policy",
        "coffee-policy-changed",
        "coffee-long-running-threshold-changed",
    }.issubset(scenarios)


def test_ha_offline_is_not_overridden_by_available_bot_policy(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)
    services = {
        service["id"]: service
        for service in client.get("/api/v1/snapshot?scenario=ha-offline-policy-available").json()["services"]
    }
    coffee = services["coffee-machine"]
    assert coffee["data"]["machine"]["available"] is False
    assert coffee["data"]["machine"]["state"] == "unavailable"
    assert coffee["data"]["timingPolicy"]["sourceAvailable"] is False
    assert coffee["data"]["timingPolicy"]["stale"] is True


def test_avalar_main_and_stage_are_registry_services_with_separate_policy(monkeypatch):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)
    services = client.get("/api/v1/snapshot").json()["services"]
    avalar = [
        service
        for service in services
        if service.get("presentation", {}).get("group") == "AVALAR"
    ]

    assert [service["id"] for service in avalar] == [
        "avalar-site-main",
        "avalar-site-stage",
    ]
    main_actions = {action["id"] for action in avalar[0]["actions"]}
    stage_actions = {action["id"] for action in avalar[1]["actions"]}
    assert "avalar.main.deploy" not in main_actions
    assert main_actions == {"avalar.main.smoke"}
    assert stage_actions == {"avalar.stage.smoke", "avalar.stage.deploy"}
    assert all(not action["enabled"] for service in avalar for action in service["actions"])


def test_coffee_settings_render_live_fixture_values_and_writes_are_narrowly_gated(
    monkeypatch,
):
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)
    timing = client.get("/api/v1/settings/coffee/timing").json()
    notifications = client.get("/api/v1/settings/notifications/coffee").json()

    assert (timing["warmupMinutes"], timing["longRunningMinutes"]) == (15, 60)
    assert timing["writesEnabled"] is False
    assert notifications["warmup"]["channels"] == {
        "telegram": False,
        "iphone": True,
    }
    assert client.patch(
        "/api/v1/settings/coffee/timing",
        json={"expectedRevision": timing["revision"], "warmupMinutes": 13},
    ).status_code == 403
    assert client.post(
        "/api/v1/actions/home/coffee",
        json={"action": "turn_on", "requestId": "fixture-request-01"},
    ).status_code == 403


def test_coffee_narrow_gates_enable_only_their_contracts(monkeypatch):
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_TIMING_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_ACTIONS_ENABLED", "true")
    module = load_app(monkeypatch, "fixtures")
    client = TestClient(module.app)

    timing = client.get("/api/v1/settings/coffee/timing").json()
    updated = client.patch(
        "/api/v1/settings/coffee/timing",
        json={"expectedRevision": timing["revision"], "warmupMinutes": 13},
    )
    assert updated.status_code == 200
    assert updated.json()["warmupMinutes"] == 13
    assert updated.headers["cache-control"] == "no-store"

    notifications = client.get("/api/v1/settings/notifications/coffee").json()
    assert notifications["writesEnabled"] is False
    assert client.patch(
        "/api/v1/settings/notifications/coffee",
        json={
            "expectedRevision": notifications["revision"],
            "warmup": {"enabled": False},
        },
    ).status_code == 403

    action = client.post(
        "/api/v1/actions/home/coffee",
        json={"action": "turn_on", "requestId": "fixture-request-02"},
    )
    assert action.status_code == 200
    assert action.json()["confirmedState"] == "on"
    assert action.headers["cache-control"] == "no-store"
