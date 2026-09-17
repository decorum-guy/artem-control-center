"""Strict parsing for the AVALAR forced-command terminal proof."""

from __future__ import annotations

import json
from dataclasses import dataclass


PREFIX = b"__ARTEM_AVALAR_TERMINAL__"
SCHEMA_VERSION = "avalar.ssh-terminal.v1"
_KEYS = frozenset({"schemaVersion", "channel", "operation", "exitCode"})


class TerminalEnvelopeError(RuntimeError):
    """The stderr terminal proof is malformed, ambiguous, or mismatched."""


@dataclass(frozen=True)
class TerminalEnvelope:
    channel: str
    operation: str
    exit_code: int


class TerminalEnvelopeParser:
    """Split stderr into ordinary helper output and exactly one strict marker."""

    def __init__(self, *, channel: str, operation: str) -> None:
        self._channel = channel
        self._operation = operation
        self._pending = bytearray()
        self.output = bytearray()
        self.envelope: TerminalEnvelope | None = None
        self.error: TerminalEnvelopeError | None = None

    def feed(self, data: bytes) -> TerminalEnvelope | None:
        self._pending.extend(data)
        while b"\n" in self._pending:
            line, _, rest = self._pending.partition(b"\n")
            self._pending[:] = rest
            self._consume_line(line, terminated=True)
        if self.error is not None:
            raise self.error
        return self.envelope

    def finish(self) -> None:
        if self._pending:
            self._consume_line(bytes(self._pending), terminated=False)
            self._pending.clear()
        if self.error is not None:
            raise self.error

    def _consume_line(self, line: bytes, *, terminated: bool) -> None:
        if not line.startswith(PREFIX):
            self.output.extend(line)
            if terminated:
                self.output.extend(b"\n")
            return
        if self.envelope is not None:
            self.error = TerminalEnvelopeError("duplicate SSH terminal envelope")
            return
        if b"\r" in line:
            self.error = TerminalEnvelopeError("invalid SSH terminal envelope")
            return
        try:
            value = json.loads(line[len(PREFIX):].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.error = TerminalEnvelopeError("invalid SSH terminal envelope")
            return
        if not isinstance(value, dict) or set(value) != _KEYS:
            self.error = TerminalEnvelopeError("invalid SSH terminal envelope")
            return
        if value.get("schemaVersion") != SCHEMA_VERSION:
            self.error = TerminalEnvelopeError("invalid SSH terminal envelope")
            return
        if value.get("channel") != self._channel or value.get("operation") != self._operation:
            self.error = TerminalEnvelopeError("mismatched SSH terminal envelope")
            return
        exit_code = value.get("exitCode")
        if type(exit_code) is not int or not 0 <= exit_code <= 255:
            self.error = TerminalEnvelopeError("invalid SSH terminal envelope")
            return
        self.envelope = TerminalEnvelope(self._channel, self._operation, exit_code)
