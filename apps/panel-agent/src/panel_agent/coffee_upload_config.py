"""Configuration validation for the narrow Coffee Diary mobile ingress."""

from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit


COFFEE_UPLOAD_ORIGIN_ENV = "PANEL_COFFEE_DIARY_UPLOAD_ORIGIN"
COFFEE_UPLOAD_BIND_HOST_ENV = "PANEL_COFFEE_DIARY_UPLOAD_INGRESS_BIND_HOST"
COFFEE_UPLOAD_PORT_ENV = "PANEL_COFFEE_DIARY_UPLOAD_INGRESS_PORT"
COFFEE_UPLOAD_UPSTREAM_URL = "http://127.0.0.1:8787/api/v1/coffee-diary/photo-upload"
COFFEE_UPLOAD_DEFAULT_PORT = 8788
PANEL_AGENT_PORT = 8787

_HOSTNAME_PATTERN = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"
)


class CoffeeUploadConfigurationError(ValueError):
    """A public, bounded configuration error safe to return to the owner UI."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class CoffeeUploadIngressConfig:
    bind_host: str
    port: int
    origin: str


def _origin_host_is_unreachable(hostname: str) -> bool:
    normalized = hostname.rstrip(".").lower()
    if normalized in {"localhost", "localhost.localdomain"}:
        return True
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


def _valid_hostname(hostname: str) -> bool:
    if len(hostname) > 253 or not hostname or ".." in hostname:
        return False
    return _HOSTNAME_PATTERN.fullmatch(hostname.rstrip(".")) is not None


def parse_coffee_upload_origin(raw: str | None) -> str:
    """Return a canonical, phone-reachable origin or raise a public error.

    The origin is deliberately explicit.  A request Host header is never a
    fallback because the panel's loopback listener is not a phone-reachable
    address.
    """

    raw_value = raw or ""
    configured = raw_value.strip()
    if not configured:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_required")
    if raw_value != configured:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_invalid")
    if len(configured) > 512 or any(character.isspace() or ord(character) < 0x20 for character in configured):
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_invalid")
    try:
        parsed = urlsplit(configured)
        port = parsed.port
    except ValueError as exc:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_invalid") from exc

    hostname = parsed.hostname
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or port is not None and not 1 <= port <= 65535
        or _origin_host_is_unreachable(hostname)
    ):
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_invalid")

    try:
        is_ip = ipaddress.ip_address(hostname).version in {4, 6}
    except ValueError:
        is_ip = False
    if not is_ip and not _valid_hostname(hostname):
        raise CoffeeUploadConfigurationError("coffee_diary_upload_origin_invalid")

    # urlsplit preserves the configured host casing and explicit port.  The
    # path is normalized away so the QR contract always owns /coffee-upload.
    return f"{parsed.scheme}://{parsed.netloc}"


def configured_coffee_upload_origin() -> str:
    return parse_coffee_upload_origin(os.getenv(COFFEE_UPLOAD_ORIGIN_ENV))


def _parse_bind_host(raw: str | None) -> str:
    raw_value = raw or ""
    host = raw_value.strip()
    if (
        not host
        or raw_value != host
        or len(host) > 253
        or any(character.isspace() or ord(character) < 0x20 for character in host)
    ):
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    if host in {"127.0.0.1", "::1", "localhost", "localhost.localdomain"}:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not _valid_hostname(host):
            raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    else:
        if address.is_loopback:
            raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    return host


def _parse_bind_port(raw: str | None) -> int:
    raw_value = raw or ""
    value = raw_value.strip()
    if raw_value != value:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid") from exc
    if not 1024 <= port <= 65535 or port == PANEL_AGENT_PORT:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    return port


def configured_coffee_upload_ingress() -> CoffeeUploadIngressConfig:
    """Validate the optional direct LAN bridge configuration.

    A deployment may instead point the origin at an already-maintained narrow
    reverse proxy and leave bind host/port unset.  The in-process bridge is
    enabled only when all three explicit values are present.
    """

    origin = configured_coffee_upload_origin()
    bind_host_raw = os.getenv(COFFEE_UPLOAD_BIND_HOST_ENV, "")
    port_raw = os.getenv(COFFEE_UPLOAD_PORT_ENV, "")
    if not bind_host_raw.strip() and not port_raw.strip():
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_not_configured")
    if not bind_host_raw.strip() or not port_raw.strip():
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")

    bind_host = _parse_bind_host(bind_host_raw)
    port = _parse_bind_port(port_raw)
    parsed: SplitResult = urlsplit(origin)
    if parsed.scheme != "http":
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    origin_port = parsed.port or 80
    if origin_port != port:
        raise CoffeeUploadConfigurationError("coffee_diary_upload_ingress_invalid")
    return CoffeeUploadIngressConfig(bind_host=bind_host, port=port, origin=origin)
