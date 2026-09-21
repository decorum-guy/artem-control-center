import asyncio
import os
from pathlib import Path
from uuid import uuid4

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.home_assistant_maintenance import (
    HomeServerMaintenanceError, HomeServerMaintenanceExecutor, HomeServerSshTransport, _safe_helper_failure,
    RESTART_ACTION, RESTART_BOT_ACTION, RESTART_CADDY_ACTION, UPDATE_CORE_ACTION,
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
