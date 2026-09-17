from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from .avalar_health import (
    avalar_target_for_url_env,
    legacy_avalar_service_id,
)
from .settings import IntegrationSettings
from .ssh_terminal import PREFIX, TerminalEnvelopeError, TerminalEnvelopeParser

_HOST_PATTERN = re.compile(r"^[A-Za-z0-9._@-]+$")
_SCRIPT_PATTERN = re.compile(r"^[A-Za-z0-9._/~+-]+$")
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
_BRANCH_PATTERN = re.compile(r"^(main|stage|detached)$")
_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
_OPERATIONS = {
    "avalar-site-main": "details-main",
    "avalar-site-stage": "details-stage",
}
_ALLOWED_FIELDS = {
    "ok",
    "environment",
    "version",
    "commit",
    "branch",
    "deployment_revision",
    "deployed_at",
    "working_tree",
    "observed_at",
}


class SshDetailsError(RuntimeError):
    pass


CommandRunner = Callable[[str], Awaitable[Dict[str, Any]]]


class AvalarSshDetailsAdapter:
    """Optional short-lived SSH details reader; it never executes action IDs."""

    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        command_runner: Optional[CommandRunner] = None,
    ) -> None:
        self._settings = settings
        self._command_runner = command_runner or self._run_fixed_command
        self._details: Dict[str, Dict[str, Any]] = {}
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def enabled(self) -> bool:
        return self._settings.avalar_ssh_enabled

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if not self.enabled:
            return
        await self.refresh()
        if not self.running:
            self._task = asyncio.create_task(self._poll())

    async def close(self) -> None:
        task = self._task
        self._task = None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def refresh(self) -> None:
        if not self.enabled:
            return
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        async with self._lock:
            for service_id, operation in _OPERATIONS.items():
                try:
                    payload = await self._command_runner(operation)
                    self._details[service_id] = _sanitize_payload(payload)
                except (OSError, ValueError, asyncio.TimeoutError, SshDetailsError):
                    cached = self._details.get(service_id)
                    if cached:
                        cached["details_source"] = "stale"

    def details_for(self, service_id: str) -> Dict[str, Any]:
        return dict(self._details.get(service_id, {}))

    def details_for_url_env(self, url_env: str) -> Dict[str, Any]:
        """Resolve a registered project target to the existing SSH cache."""

        target = avalar_target_for_url_env(url_env)
        if target is None:
            return {}
        return self.details_for(legacy_avalar_service_id(target))

    async def _poll(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._settings.avalar_ssh_refresh_seconds)
                await self.refresh()
            except asyncio.CancelledError:
                raise

    async def _run_fixed_command(self, operation: str) -> Dict[str, Any]:
        if operation not in _OPERATIONS.values():
            raise SshDetailsError("SSH operation is not allow-listed")
        host = self._settings.avalar_ssh_host
        script = self._settings.avalar_ssh_remote_script
        if not _HOST_PATTERN.fullmatch(host) or not _SCRIPT_PATTERN.fullmatch(script):
            raise SshDetailsError("Unsafe SSH host or remote script configuration")

        process = await asyncio.create_subprocess_exec(
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={self._settings.avalar_ssh_timeout_seconds}",
            host,
            script,
            operation,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        limit = self._settings.avalar_ssh_output_limit_bytes
        envelope_ready: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        payload_ready: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()
        parser = TerminalEnvelopeParser(channel="status", operation=operation)
        deadline = asyncio.get_running_loop().time() + self._settings.avalar_ssh_timeout_seconds
        stdout_task = asyncio.create_task(_read_status_stdout(process.stdout, limit, payload_ready))
        stderr_task = asyncio.create_task(_read_status_stderr(process.stderr, limit, parser, envelope_ready))
        wait_task = asyncio.create_task(process.wait())
        try:
            done, _ = await asyncio.wait(
                {wait_task, envelope_ready}, timeout=max(0.01, deadline - asyncio.get_running_loop().time()),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                raise asyncio.TimeoutError
            if envelope_ready in done:
                if envelope_ready.result() != 0:
                    await _terminate_and_reap(process)
                    raise SshDetailsError("SSH status command failed")
                try:
                    stdout = await asyncio.wait_for(
                        asyncio.shield(payload_ready), timeout=max(0.01, deadline - asyncio.get_running_loop().time()),
                    )
                except (asyncio.TimeoutError, RuntimeError):
                    await _terminate_and_reap(process)
                    raise SshDetailsError("SSH status command returned invalid JSON") from None
                await _terminate_and_reap(process)
                return _parse_command_output(stdout, b"", 0, limit)
            returncode = wait_task.result()
            stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
            return _parse_command_output(stdout, stderr, returncode, limit)
        except (asyncio.TimeoutError, TerminalEnvelopeError):
            await _terminate_and_reap(process)
            raise SshDetailsError("SSH status command timed out" if not parser.error else "SSH terminal envelope is invalid") from None
        finally:
            for task in (stdout_task, stderr_task, wait_task):
                if not task.done(): task.cancel()
            await asyncio.gather(stdout_task, stderr_task, wait_task, return_exceptions=True)


async def _read_limited(
    stream: asyncio.StreamReader | None,
    limit: int,
) -> bytes:
    if stream is None:
        return b""
    data = bytearray()
    while True:
        chunk = await stream.read(min(4096, limit + 1 - len(data)))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > limit:
            raise SshDetailsError("SSH output exceeded configured limit")


def _parse_command_output(
    stdout: bytes,
    stderr: bytes,
    returncode: int,
    limit: int,
) -> Dict[str, Any]:
    if len(stdout) > limit or len(stderr) > limit:
        raise SshDetailsError("SSH output exceeded configured limit")
    if returncode != 0:
        raise SshDetailsError("SSH status command failed")
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SshDetailsError("SSH status command returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise SshDetailsError("SSH status command must return a JSON object")
    return payload


async def _read_status_stdout(
    stream: asyncio.StreamReader | None, limit: int, ready: asyncio.Future[bytes],
) -> bytes:
    if stream is None:
        raise SshDetailsError("SSH status stream is unavailable")
    data = bytearray()
    while True:
        chunk = await stream.read(min(4096, limit + 1 - len(data)))
        if not chunk:
            if not ready.done(): ready.set_result(bytes(data))
            return bytes(data)
        data.extend(chunk)
        if len(data) > limit or PREFIX in data:
            error = SshDetailsError("SSH output exceeded configured limit")
            if not ready.done(): ready.set_exception(error)
            raise error
        if b"\n" not in data:
            continue
        if not data.endswith(b"\n") or data.count(b"\n") != 1:
            if not ready.done():
                ready.set_exception(SshDetailsError("SSH status command returned invalid JSON"))
            continue
        if not ready.done():
            ready.set_result(bytes(data))


async def _read_status_stderr(
    stream: asyncio.StreamReader | None, limit: int, parser: TerminalEnvelopeParser,
    ready: asyncio.Future[int],
) -> bytes:
    if stream is None:
        return b""
    try:
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                parser.finish()
                return bytes(parser.output)
            if len(parser.output) + len(chunk) > limit:
                raise SshDetailsError("SSH output exceeded configured limit")
            envelope = parser.feed(chunk)
            if envelope is not None and not ready.done(): ready.set_result(envelope.exit_code)
    except (TerminalEnvelopeError, SshDetailsError) as exc:
        if not ready.done(): ready.set_exception(exc)
        raise


async def _terminate_and_reap(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=0.25)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


def _sanitize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    if payload.get("ok") is not True:
        raise SshDetailsError("SSH details payload reports failure")
    environment = payload.get("environment")
    if environment not in {"production", "stage"}:
        raise SshDetailsError("SSH details payload has invalid environment")
    working_tree = payload.get("working_tree")
    if working_tree not in {"clean", "dirty"}:
        raise SshDetailsError("SSH details payload has invalid working tree")
    if not _COMMIT_PATTERN.fullmatch(str(payload.get("commit", ""))):
        raise SshDetailsError("SSH details payload has invalid commit")
    version = payload.get("version")
    if version is not None and not _VERSION_PATTERN.fullmatch(str(version)):
        raise SshDetailsError("SSH details payload has invalid version")
    if not _BRANCH_PATTERN.fullmatch(str(payload.get("branch", ""))):
        raise SshDetailsError("SSH details payload has invalid branch")
    revision = payload.get("deployment_revision")
    if revision is not None and not _COMMIT_PATTERN.fullmatch(str(revision)):
        raise SshDetailsError("SSH details payload has invalid deployment revision")
    for field in ("deployed_at", "observed_at"):
        value = payload.get(field)
        if value is not None and not _TIMESTAMP_PATTERN.fullmatch(str(value)):
            raise SshDetailsError(f"SSH details payload has invalid {field}")
    clean = {key: payload.get(key) for key in _ALLOWED_FIELDS}
    clean["details_source"] = "live"
    clean["details_observed_at"] = datetime.now(timezone.utc).isoformat()
    return clean
