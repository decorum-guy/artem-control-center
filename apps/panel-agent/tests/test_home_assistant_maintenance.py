import asyncio
import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.home_assistant_maintenance import (
    HomeServerMaintenanceError, HomeServerMaintenanceExecutor, HomeServerSshTransport, _safe_helper_failure,
    RESTART_ACTION, RESTART_BOT_ACTION, RESTART_CADDY_ACTION, UPDATE_CORE_ACTION,
    build_home_assistant_maintenance_router, _read_stable_version,
)
from panel_agent.settings import IntegrationSettings


class FakeTransport:
    def __init__(self, results=None): self.results, self.calls = results or {}, []
    def configured(self): return True
    async def run(self, operation):
        self.calls.append(operation)
        result = self.results.get(operation)
        if isinstance(result, Exception): raise result
        if operation == "status":
            return result or {"schemaVersion": 1, "ok": True, "operation": "status", "services": {"homeAssistant": {"running": True, "healthy": True}, "caddy": {"running": True, "healthy": True}, "bot": {"running": True, "healthy": True}}}
        return result or {"schemaVersion": 1, "ok": True, "operation": operation, "status": "success"}


def make(tmp_path, *, profile="full", transport=None):
    policy = AccessPolicyStore(tmp_path / "policy.json", audit_dir=tmp_path / "audit")
    policy.set_pin("1234")
    if profile == "full": policy.set_profile("full", pin="1234")
    if profile == "standard": policy.set_profile("standard")
    settings = IntegrationSettings(writes_enabled=True, home_server_maintenance_enabled=True)
    return HomeServerMaintenanceExecutor(settings, policy, transport=transport or FakeTransport())


def test_default_gate_is_off(): assert IntegrationSettings().home_server_maintenance_enabled is False


def test_fixed_ssh_argv_has_pinned_known_hosts_and_one_operation(tmp_path):
    identity, known = tmp_path / "control", tmp_path / "known_hosts"; identity.touch(); known.touch()
    transport = HomeServerSshTransport(IntegrationSettings(home_server_ssh_host="home-server.internal", home_server_ssh_user="panel-control", home_server_ssh_identity_file=str(identity), home_server_ssh_known_hosts_file=str(known)))
    argv = transport.argv("ssh", "restart-ha")
    assert argv[-2:] == ("home-server.internal", "restart-ha")
    assert ("-F", os.devnull) == (argv[1], argv[2])
    assert ("-l", "panel-control") == (argv[argv.index("-l")], argv[argv.index("-l") + 1])
    assert "StrictHostKeyChecking=yes" in argv and f"UserKnownHostsFile={known}" in argv and "IdentitiesOnly=yes" in argv


def test_nonzero_helper_preserves_only_closed_safe_envelope():
    assert _safe_helper_failure(b'{"schemaVersion":1,"ok":false,"error":"maintenance_busy"}\n') == "maintenance_busy"
    assert _safe_helper_failure(b'{"schemaVersion":1,"ok":false,"error":"docker: secret"}\n') == "helper_failed"
    assert _safe_helper_failure(b'not json') == "helper_failed"


def test_unknown_operation_is_rejected(tmp_path):
    transport = HomeServerSshTransport(IntegrationSettings())
    async def run():
        try: await transport.run("rm -rf /")
        except HomeServerMaintenanceError as error: assert error.code == "helper_failed"; return
        assert False
    asyncio.run(run())


def http_app(executor):
    app = FastAPI()
    app.include_router(build_home_assistant_maintenance_router(executor))
    return TestClient(app)


def test_browser_json_reaches_each_fixed_action_and_replays_only_its_target(tmp_path):
    transport = FakeTransport()
    with http_app(make(tmp_path, transport=transport)) as client:
        endpoint = "/api/v1/actions/home-assistant/maintenance"
        for action, operation in [(UPDATE_CORE_ACTION, "update-ha"), (RESTART_ACTION, "restart-ha"),
                                  (RESTART_BOT_ACTION, "restart-bot"), (RESTART_CADDY_ACTION, "restart-caddy")]:
            body = {"actionId": action, "requestId": str(uuid4())}
            assert client.post(endpoint, json=body).status_code == 202
            assert client.post(endpoint, json=body).status_code == 200
            assert transport.calls.count(operation) == 1
            assert client.get(f"{endpoint}/{body['requestId']}").json()["status"] == "success"
            other = RESTART_ACTION if action != RESTART_ACTION else UPDATE_CORE_ACTION
            assert client.post(endpoint, json={**body, "actionId": other}).status_code == 409
        for invalid in ({"requestId": "wrong"}, {"actionId": "invalid"}, {"command": "extra"}):
            assert client.post(endpoint, json={**body, **invalid}).status_code == 422


@pytest.mark.parametrize(("latest", "state"), [("2026.11.2", "available"), ("2026.9.3", "up_to_date"), ("2026.9.2", "ahead")])
def test_check_reads_only_status_and_catalog_without_write_permission(tmp_path, latest, state):
    async def release():
        return latest
    ha = {"running": True, "installedVersion": "2026.9.3", "configuredImage": "ghcr.io/home-assistant/home-assistant:stable"}
    transport = FakeTransport({"status": {"schemaVersion": 1, "ok": True, "operation": "status", "services": {"homeAssistant": ha}}})
    executor = HomeServerMaintenanceExecutor(IntegrationSettings(), AccessPolicyStore(tmp_path / "policy.json"),
                                             transport=transport, stable_version=release)
    endpoint = "/api/v1/actions/home-assistant/maintenance"
    with http_app(executor) as client:
        response = client.get(endpoint + "/update-check")
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        body = response.json()
        assert body["state"] == state and body["installedVersion"] == "2026.9.3" and body["latestVersion"] == latest and body["checkedAt"]
        assert transport.calls == ["status"] and not executor.executions
        rejected = client.post(endpoint, json={"actionId": UPDATE_CORE_ACTION, "requestId": str(uuid4())})
        assert rejected.status_code == 409 and rejected.json()["detail"] == "gate_disabled"
        assert set(transport.calls) == {"status"}


def test_check_does_not_advertise_other_images_or_an_unreadable_version(tmp_path):
    async def unreachable():
        raise HomeServerMaintenanceError("release_feed_unavailable")
    ha = {"running": True, "installedVersion": "2026.9.3", "configuredImage": "custom:stable"}
    transport = FakeTransport({"status": {"schemaVersion": 1, "ok": True, "operation": "status", "services": {"homeAssistant": ha}}})
    executor = make(tmp_path, transport=transport)
    executor.stable_version = unreachable
    endpoint = "/api/v1/actions/home-assistant/maintenance/update-check"
    with http_app(executor) as client:
        assert client.get(endpoint).json()["detail"] == "unsupported_release_channel"
        ha["configuredImage"] = "ghcr.io/home-assistant/home-assistant:stable"
        assert client.get(endpoint).json()["detail"] == "release_feed_unavailable"
        ha["installedVersion"] = ""
        assert client.get(endpoint).json()["detail"] == "installed_version_unknown"
        transport.results["status"] = HomeServerMaintenanceError("ssh_timeout")
        assert client.get(endpoint).json()["detail"] == "ssh_timeout"
    assert set(transport.calls) == {"status"} and not executor.executions


def test_official_release_feed_falls_back_and_validates_bounded_json(monkeypatch):
    original_client = httpx.AsyncClient
    responses = [httpx.Response(403), httpx.Response(200, json={"channel": "stable", "homeassistant": {"default": "2026.11.2"}})]
    def handler(request):
        assert request.method == "GET" and request.url.host in {"version.home-assistant.io", "raw.githubusercontent.com"}
        return responses.pop(0)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(handler), **kw))
    assert asyncio.run(_read_stable_version()) == "2026.11.2"
    responses.extend([httpx.Response(200, content=b" " * 34_000),
                      httpx.Response(200, json={"channel": "beta", "homeassistant": {"default": "2026.11.2"}})])
    with pytest.raises(HomeServerMaintenanceError, match="release_feed_unavailable"):
        asyncio.run(_read_stable_version())


def test_all_four_actions_dispatch_only_fixed_operations(tmp_path):
    transport = FakeTransport(); executor = make(tmp_path, transport=transport)
    async def run():
        for action in (RESTART_ACTION, UPDATE_CORE_ACTION, RESTART_CADDY_ACTION, RESTART_BOT_ACTION):
            await executor.submit(type("Request", (), {"actionId": action, "requestId": uuid4()})())
            await asyncio.sleep(0)
    asyncio.run(run())
    assert {"status", "restart-ha", "update-ha", "restart-caddy", "restart-bot"}.issubset(set(transport.calls))


def test_full_access_is_required(tmp_path):
    executor = make(tmp_path, profile="standard")
    async def run():
        try: await executor.submit(type("Request", (), {"actionId": RESTART_ACTION, "requestId": uuid4()})())
        except Exception as error: assert getattr(error, "detail", None) == "elevation_required"
        else: assert False
    asyncio.run(run())


def test_up_to_date_and_failure_are_truthful(tmp_path):
    transport = FakeTransport({"update-ha": {"schemaVersion": 1, "ok": True, "operation": "update-ha", "status": "up_to_date"}})
    executor = make(tmp_path, transport=transport)
    async def run():
        result, _ = await executor.submit(type("Request", (), {"actionId": UPDATE_CORE_ACTION, "requestId": uuid4()})()); await asyncio.sleep(0)
        assert executor.operation(result["requestId"])["result"] == "up_to_date"
    asyncio.run(run())


def test_duplicate_request_and_active_operation_are_bounded(tmp_path):
    executor = make(tmp_path); request = type("Request", (), {"actionId": RESTART_ACTION, "requestId": uuid4()})()
    async def run():
        _, first = await executor.submit(request); _, duplicate = await executor.submit(request)
        assert first and not duplicate
    asyncio.run(run())


def test_ssh_completion_does_not_wait_for_windows_transport_eof():
    from panel_agent.home_assistant_maintenance import _read_ssh_result

    async def exercise():
        class Channel:
            stdout = asyncio.StreamReader()
            stderr = asyncio.StreamReader()

            async def wait(self):
                await asyncio.Future()

        channel = Channel()
        channel.stdout.feed_data(b'{"schemaVersion":1,"ok":true,"operation":"status"}\n')
        channel.stderr.feed_data(b"__ARTEM_HOME_RESULT__ status 0\n")
        data, code = await asyncio.wait_for(_read_ssh_result(channel, "status", 512), .5)
        assert code == 0 and b'"ok":true' in data
        channel.stdout.feed_data(b'{"ok":true}\n')
        channel.stderr.feed_data(b"__ARTEM_HOME_RESULT__ restart-bot 0\n")
        try:
            await _read_ssh_result(channel, "status", 512)
        except HomeServerMaintenanceError as exc:
            assert exc.code == "ssh_invalid_response"
        else:
            raise AssertionError("wrong operation acknowledged")
    asyncio.run(exercise())


def test_compose_pull_progress_does_not_consume_the_result_json_budget():
    from panel_agent.home_assistant_maintenance import _terminal_status

    async def exercise():
        stderr = asyncio.StreamReader(limit=512)
        stderr.feed_data(b"Pulling image layer\n" * 6000 + b"__ARTEM_HOME_RESULT__ update-ha 0\n")
        assert await _terminal_status(stderr, "update-ha", 512) == 0
    asyncio.run(exercise())
