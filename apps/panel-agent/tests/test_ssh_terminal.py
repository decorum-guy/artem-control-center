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


def test_terminal_parser_rejects_unterminated_terminal_marker():
    parser = TerminalEnvelopeParser(channel="status", operation="details-stage")
    parser.feed(_marker()[:-1])
    with pytest.raises(TerminalEnvelopeError):
        parser.finish()


class _ControlledStream:
    def __init__(self, initial: list[bytes], final: bytes = b"") -> None:
        self._initial = initial
        self._final = final
        self.waiting_for_final = asyncio.Event()
        self.release_final = asyncio.Event()
        self._final_sent = False

    async def read(self, _size: int) -> bytes:
        if self._initial:
            return self._initial.pop(0)
        self.waiting_for_final.set()
        if not self._final_sent and self._final:
            await self.release_final.wait()
            self._final_sent = True
            return self._final
        await asyncio.Event().wait()
        return b""


class _ControlledHangingProcess:
    def __init__(self, stdout: _ControlledStream, stderr: _ControlledStream) -> None:
        self.stdout, self.stderr = stdout, stderr
        self.returncode = None
        self.terminated = asyncio.Event()
        self._reaped = asyncio.get_running_loop().create_future()

    async def wait(self):
        return await self._reaped

    def terminate(self):
        self.returncode = -15
        self.terminated.set()
        if not self._reaped.done(): self._reaped.set_result(-15)

    def kill(self):
        self.returncode = -9
        self.terminated.set()
        if not self._reaped.done(): self._reaped.set_result(-9)


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


def test_action_terminal_marker_before_final_stdout_chunk_waits_for_complete_frame(tmp_path, monkeypatch):
    async def scenario():
        stdout = _ControlledStream([b'{"ok":true}'], b"\n")
        stderr = _ControlledStream([_marker("action", "smoke-stage")])
        process = _ControlledHangingProcess(stdout, stderr)

        async def spawn(*_args, **_kwargs): return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        executor = AvalarActionExecutor(IntegrationSettings(avalar_action_ssh_host="avalar-control", avalar_action_remote_script="control-center"), AccessPolicyStore(tmp_path / "policy.json"), details_provider=object())
        task = asyncio.create_task(executor._run_fixed_command("smoke-stage"))
        await stdout.waiting_for_final.wait()
        await stderr.waiting_for_final.wait()
        assert not task.done()
        assert not process.terminated.is_set()
        stdout.release_final.set()
        assert await task == {"ok": True}
        assert process.terminated.is_set()

    asyncio.run(scenario())


def test_action_terminal_frame_rejects_extra_stdout_bytes(tmp_path, monkeypatch):
    async def scenario():
        process = _ControlledHangingProcess(_ControlledStream([b'{"ok":true}\nextra']), _ControlledStream([_marker("action", "smoke-stage")]))
        async def spawn(*_args, **_kwargs): return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        executor = AvalarActionExecutor(IntegrationSettings(avalar_action_ssh_host="avalar-control", avalar_action_remote_script="control-center"), AccessPolicyStore(tmp_path / "policy.json"), details_provider=object())
        with pytest.raises(RuntimeError, match="invalid_action_response"):
            await executor._run_fixed_command("smoke-stage")
        assert process.terminated.is_set()

    asyncio.run(scenario())


def test_status_terminal_marker_before_final_stdout_chunk_waits_for_complete_frame(monkeypatch):
    async def scenario():
        record = b'{"ok":true,"environment":"stage","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"stage","deployment_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","deployed_at":null,"working_tree":"clean","observed_at":"2026-09-17T00:00:00Z"}'
        stdout = _ControlledStream([record], b"\n")
        process = _ControlledHangingProcess(stdout, _ControlledStream([_marker("status", "details-stage")]))
        async def spawn(*_args, **_kwargs): return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        adapter = AvalarSshDetailsAdapter(IntegrationSettings(avalar_ssh_enabled=True, avalar_ssh_host="avalar-status", avalar_ssh_remote_script="control-center"))
        task = asyncio.create_task(adapter._run_fixed_command("details-stage"))
        await stdout.waiting_for_final.wait()
        await process.stderr.waiting_for_final.wait()
        assert not task.done()
        assert not process.terminated.is_set()
        stdout.release_final.set()
        assert (await task)["environment"] == "stage"
        assert process.terminated.is_set()

    asyncio.run(scenario())


def test_status_terminal_frame_rejects_extra_stdout_bytes(monkeypatch):
    async def scenario():
        record = b'{"ok":true,"environment":"stage","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"stage","deployment_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","deployed_at":null,"working_tree":"clean","observed_at":"2026-09-17T00:00:00Z"}\nextra'
        process = _ControlledHangingProcess(_ControlledStream([record]), _ControlledStream([_marker("status", "details-stage")]))
        async def spawn(*_args, **_kwargs): return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        adapter = AvalarSshDetailsAdapter(IntegrationSettings(avalar_ssh_enabled=True, avalar_ssh_host="avalar-status", avalar_ssh_remote_script="control-center"))
        with pytest.raises(SshDetailsError, match="invalid JSON"):
            await adapter._run_fixed_command("details-stage")
        assert process.terminated.is_set()

    asyncio.run(scenario())
