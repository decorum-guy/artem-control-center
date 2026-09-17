import asyncio
import sys

import pytest

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.avalar_actions import AvalarActionExecutor
from panel_agent.settings import IntegrationSettings
from panel_agent.ssh_details import AvalarSshDetailsAdapter, SshDetailsError
from panel_agent.ssh_terminal import PREFIX, TerminalEnvelopeError, TerminalEnvelopeParser


def _marker(channel="status", operation="details-stage", exit_code=0):
    return PREFIX + (
        b'{"schemaVersion":"avalar.ssh-terminal.v1","channel":"'
        + channel.encode()
        + b'","operation":"' + operation.encode() + b'","exitCode":'
        + str(exit_code).encode() + b'}\n'
    )


def test_terminal_parser_keeps_helper_stderr_and_accepts_exact_matching_marker():
    parser = TerminalEnvelopeParser(channel="status", operation="details-stage")
    assert parser.feed(b"human diagnostic\n" + _marker()) is not None
    assert bytes(parser.output) == b"human diagnostic\n"
    assert parser.envelope is not None and parser.envelope.exit_code == 0


@pytest.mark.parametrize("marker", [
    PREFIX + b"not-json\n",
    PREFIX + b'{"schemaVersion":"avalar.ssh-terminal.v1","channel":"status","operation":"details-stage","exitCode":0,"extra":true}\n',
    PREFIX + b'{"schemaVersion":"avalar.ssh-terminal.v1","channel":"status","operation":"details-stage","exitCode":true}\n',
])
def test_terminal_parser_rejects_malformed_marker_looking_stderr(marker):
    with pytest.raises(TerminalEnvelopeError):
        TerminalEnvelopeParser(channel="status", operation="details-stage").feed(marker)


@pytest.mark.parametrize("channel,operation", [("action", "details-stage"), ("status", "status-stage")])
def test_terminal_parser_rejects_wrong_channel_or_operation(channel, operation):
    with pytest.raises(TerminalEnvelopeError):
        TerminalEnvelopeParser(channel="status", operation="details-stage").feed(_marker(channel, operation))


def test_terminal_parser_rejects_duplicate_marker():
    parser = TerminalEnvelopeParser(channel="status", operation="details-stage")
    with pytest.raises(TerminalEnvelopeError):
        parser.feed(_marker() + _marker())


def _hanging_remote(stdout: str, stderr: bytes) -> str:
    return (
        "import signal,sys;"
        f"sys.stdout.write({stdout!r});sys.stdout.flush();"
        f"sys.stderr.buffer.write({stderr!r});sys.stderr.flush();"
        "signal.pause()"
    )


def test_action_accepts_complete_matching_envelope_then_reaps_hanging_child(tmp_path, monkeypatch):
    created = []
    original = asyncio.create_subprocess_exec
    marker = _marker("action", "smoke-stage")

    async def spawn(*_args, **kwargs):
        process = await original(sys.executable, "-c", _hanging_remote('{"ok":true}\n', marker), **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    executor = AvalarActionExecutor(
        IntegrationSettings(avalar_action_ssh_host="avalar-control", avalar_action_remote_script="control-center"),
        AccessPolicyStore(tmp_path / "policy.json"), details_provider=object(),
    )
    result = asyncio.run(executor._run_fixed_command("smoke-stage"))
    assert result == {"ok": True}
    assert created and created[0].returncode is not None


def test_status_accepts_complete_matching_envelope_then_reaps_hanging_child(monkeypatch):
    created = []
    original = asyncio.create_subprocess_exec
    payload = '{"ok":true,"environment":"stage","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"stage","deployment_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","deployed_at":null,"working_tree":"clean","observed_at":"2026-09-17T00:00:00Z"}\n'
    marker = _marker("status", "details-stage")

    async def spawn(*_args, **kwargs):
        process = await original(sys.executable, "-c", _hanging_remote(payload, marker), **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    adapter = AvalarSshDetailsAdapter(IntegrationSettings(avalar_ssh_enabled=True, avalar_ssh_host="avalar-status", avalar_ssh_remote_script="control-center"))
    result = asyncio.run(adapter._run_fixed_command("details-stage"))
    assert result["environment"] == "stage"
    assert created and created[0].returncode is not None


def test_wrong_terminal_envelope_never_completes_action(monkeypatch, tmp_path):
    original = asyncio.create_subprocess_exec

    async def spawn(*_args, **kwargs):
        return await original(sys.executable, "-c", _hanging_remote('{"ok":true}\n', _marker("status", "smoke-stage")), **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    executor = AvalarActionExecutor(
        IntegrationSettings(avalar_action_ssh_host="avalar-control", avalar_action_remote_script="control-center"),
        AccessPolicyStore(tmp_path / "policy.json"), details_provider=object(),
    )
    with pytest.raises(RuntimeError, match="invalid_action_response"):
        asyncio.run(executor._run_fixed_command("smoke-stage"))
