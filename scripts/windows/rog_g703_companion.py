"""Minimal authenticated ASUS companion for the ROG G703GI integration.

The process intentionally has no general-purpose command surface. It only
reports a small health document and schedules one of the two fixed Windows
power operations after sending the HTTP response.
"""

from __future__ import annotations

import argparse
import ctypes
import hmac
import ipaddress
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

MAX_REQUEST_BODY_BYTES = 4 * 1024
MAX_SECRET_LENGTH = 512
POWER_TRANSITION_DELAY_SECONDS = 0.15


def load_config(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("companion config must be an object")
    address = payload.get("listenAddress")
    port = payload.get("port")
    secret = payload.get("secret")
    secret_file = payload.get("secretFile")
    if secret is None and isinstance(secret_file, str):
        secret_path = Path(secret_file)
        if not secret_path.is_absolute():
            secret_path = config_path.parent / secret_path
        secret = secret_path.read_text(encoding="utf-8").strip()
    if not isinstance(address, str):
        raise ValueError("companion listenAddress is required")
    try:
        parsed_address = ipaddress.ip_address(address)
    except ValueError as exc:
        raise ValueError("companion listenAddress must be an IP address") from exc
    if parsed_address.version != 4:
        raise ValueError("companion listenAddress must be IPv4")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("companion port must be between 1024 and 65535")
    if not isinstance(secret, str) or not 32 <= len(secret) <= MAX_SECRET_LENGTH:
        raise ValueError("companion secret length is invalid")
    if any(character.isspace() or ord(character) < 32 for character in secret):
        raise ValueError("companion secret contains whitespace")
    return {
        "listenAddress": address,
        "port": port,
        "secret": secret,
    }


class FixedHibernateExecutor:
    def __call__(self) -> None:
        subprocess.Popen(
            ["shutdown.exe", "/h"],
            close_fds=True,
        )


class FixedSleepExecutor:
    """Invoke Windows suspend without exposing a command or power-state input."""

    def __init__(self, *, suspend_call: Callable[[], bool] | None = None) -> None:
        self._suspend_call = suspend_call or self._suspend_windows

    @staticmethod
    def _suspend_windows() -> bool:
        if os.name != "nt":
            raise RuntimeError("windows_sleep_unavailable")
        # SetSuspendState(FALSE, TRUE, FALSE) means Sleep/suspend, not
        # hibernation.  The fixed call is intentionally kept in this
        # executor so the HTTP request cannot select a power state.
        return bool(ctypes.windll.powrprof.SetSuspendState(False, True, False))

    def __call__(self) -> None:
        if not self._suspend_call():
            raise RuntimeError("windows_sleep_failed")


class CompanionHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        config: dict[str, Any],
        hibernate_executor: Callable[[], None],
        sleep_executor: Callable[[], None],
        *,
        timer_factory: Callable[[float, Callable[[], None]], Any] = threading.Timer,
    ) -> None:
        self.secret = config["secret"]
        self.hibernate_executor = hibernate_executor
        self.sleep_executor = sleep_executor
        self.timer_factory = timer_factory
        super().__init__(server_address, CompanionRequestHandler)

    def schedule_hibernate(self) -> None:
        self._schedule(self.hibernate_executor)

    def schedule_sleep(self) -> None:
        self._schedule(self.sleep_executor)

    def _schedule(self, executor: Callable[[], None]) -> None:
        timer = self.timer_factory(POWER_TRANSITION_DELAY_SECONDS, executor)
        timer.daemon = True
        timer.start()


class CompanionRequestHandler(BaseHTTPRequestHandler):
    server: CompanionHTTPServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        if parsed.path != "/health" or parsed.query or parsed.fragment:
            self._send_error(404)
            return
        if not self._authorized():
            self._send_error(401)
            return
        self._send_json(
            200,
            {
                "schemaVersion": 1,
                "ok": True,
                "service": "rog-g703-companion",
                "status": "online",
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        if parsed.path == "/hibernate":
            operation = ("hibernate", self.server.schedule_hibernate)
        elif parsed.path == "/sleep":
            operation = ("sleep", self.server.schedule_sleep)
        else:
            operation = None
        if operation is None or parsed.query or parsed.fragment:
            self._send_error(404)
            return
        if not self._authorized():
            self._send_error(401)
            return
        if self.headers.get("Transfer-Encoding"):
            self._send_error(400)
            return
        body_length = self._content_length()
        if body_length is None:
            self._send_error(400)
            return
        if body_length > MAX_REQUEST_BODY_BYTES:
            self._send_error(413)
            return
        if body_length:
            self.rfile.read(body_length)
            self._send_error(400)
            return

        self._send_json(
            202,
            {
                "schemaVersion": 1,
                "accepted": True,
                "operation": operation[0],
            },
        )
        self.wfile.flush()
        operation[1]()

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler API
        self._send_error(405)

    def do_PATCH(self) -> None:  # noqa: N802 - stdlib handler API
        self._send_error(405)

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib handler API
        self._send_error(405)

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.secret}"
        return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))

    def _content_length(self) -> int | None:
        raw = self.headers.get("Content-Length")
        if raw is None:
            return 0
        try:
            value = int(raw)
        except ValueError:
            return None
        return value if value >= 0 else None

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _send_error(self, code: int) -> None:
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def log_message(self, format: str, *args: Any) -> None:
        # Never write request headers or secrets to stdout/stderr.
        del format, args


def create_server(
    config_path: str | Path,
    *,
    hibernate_executor: Callable[[], None] | None = None,
    sleep_executor: Callable[[], None] | None = None,
) -> CompanionHTTPServer:
    config = load_config(config_path)
    return CompanionHTTPServer(
        (config["listenAddress"], config["port"]),
        config,
        hibernate_executor or FixedHibernateExecutor(),
        sleep_executor or FixedSleepExecutor(),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="ROG G703GI fixed power companion")
    parser.add_argument("--config-path", "-ConfigPath", required=True)
    arguments = parser.parse_args()
    server = create_server(arguments.config_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
