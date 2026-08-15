from __future__ import annotations

import os
import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class IntegrationSettings:
    ha_url: str = ""
    ha_token: str = ""
    ha_stale_after_seconds: int = 90
    state_cache_path: str = ""
    alice_health_url: str = ""
    alice_details_token: str = ""
    alice_base_url: str = ""
    alice_control_center_token: str = ""
    avalar_main_url: str = ""
    avalar_stage_url: str = ""
    http_refresh_seconds: int = 30
    http_request_timeout_seconds: int = 10
    integration_stale_after_seconds: int = 90
    integration_unavailable_after_seconds: int = 300
    integration_max_backoff_seconds: int = 120
    avalar_ssh_enabled: bool = False
    avalar_ssh_host: str = "avalar-reg"
    avalar_ssh_remote_script: str = "~/control-center-avalar.sh"
    avalar_ssh_refresh_seconds: int = 180
    avalar_ssh_timeout_seconds: int = 15
    avalar_ssh_output_limit_bytes: int = 32768
    avalar_actions_enabled: bool = False
    avalar_action_ssh_host: str = "avalar-control"
    avalar_action_remote_script: str = "~/control-center-avalar-action.sh"
    avalar_action_timeout_seconds: int = 150
    avalar_action_output_limit_bytes: int = 32768
    avalar_smoke_enabled: bool = False
    avalar_stage_restart_enabled: bool = False
    avalar_main_restart_enabled: bool = False
    avalar_stage_deploy_enabled: bool = False
    avalar_main_deploy_enabled: bool = False
    rog_g703_enabled: bool = False
    rog_g703_target_id: str = "rog_g703gi"
    rog_g703_mac: str = ""
    rog_g703_broadcast_address: str = "255.255.255.255"
    rog_g703_broadcast_interface: str = ""
    rog_g703_companion_base_url: str = ""
    rog_g703_companion_secret: str = ""
    rog_g703_wol_repeats: int = 3
    rog_g703_wol_cooldown_seconds: int = 5
    rog_g703_hibernate_cooldown_seconds: int = 10
    rog_g703_health_timeout_seconds: int = 60
    rog_g703_hibernate_timeout_seconds: int = 45
    rog_g703_http_timeout_seconds: float = 3.0
    rog_g703_health_poll_seconds: float = 15.0
    rog_g703_response_limit_bytes: int = 16 * 1024
    writes_enabled: bool = False
    coffee_timing_writes_enabled: bool = False
    coffee_notification_writes_enabled: bool = False
    coffee_actions_enabled: bool = False
    overview_layout_writes_enabled: bool = False
    overview_layout_path: str = ".cache/overview-layout.json"
    access_temporary_minutes: int = 30
    sse_heartbeat_seconds: int = 20
    panel_planning_enabled: bool = False
    panel_planning_reminder_mutations_enabled: bool = False
    panel_planning_task_mutations_enabled: bool = False
    panel_planning_base_url: str = ""
    panel_planning_internal_secret: str = ""
    panel_planning_secret: str = ""
    panel_planning_refresh_seconds: int = 20
    panel_planning_status_refresh_seconds: int = 300
    panel_planning_stale_after_seconds: int = 90
    panel_planning_unavailable_after_seconds: int = 300
    panel_planning_max_backoff_seconds: int = 120
    panel_planning_cache_path: str = ".cache/planning-snapshot.json"
    panel_planning_response_limit_bytes: int = 256 * 1024
    panel_planning_timezone: str = "Europe/Moscow"
    panel_planning_fixture_scenario: str = "healthy"

    @classmethod
    def from_env(cls) -> "IntegrationSettings":
        settings = cls(
            ha_url=os.getenv("PANEL_HA_URL", "").rstrip("/"),
            ha_token=os.getenv("PANEL_HA_TOKEN", ""),
            ha_stale_after_seconds=max(
                15,
                int(os.getenv("PANEL_HA_STALE_AFTER_SECONDS", "90")),
            ),
            state_cache_path=os.getenv("PANEL_STATE_CACHE_PATH", ""),
            alice_health_url=os.getenv("PANEL_ALICE_HEALTH_URL", "").rstrip("/"),
            alice_details_token=os.getenv("PANEL_ALICE_DETAILS_TOKEN", ""),
            alice_base_url=os.getenv("PANEL_ALICE_BASE_URL", "").rstrip("/"),
            alice_control_center_token=os.getenv(
                "PANEL_ALICE_CONTROL_CENTER_TOKEN",
                "",
            ),
            avalar_main_url=os.getenv("PANEL_AVALAR_MAIN_URL", "").rstrip("/"),
            avalar_stage_url=os.getenv("PANEL_AVALAR_STAGE_URL", "").rstrip("/"),
            http_refresh_seconds=max(
                5,
                int(os.getenv("PANEL_HTTP_REFRESH_SECONDS", "30")),
            ),
            http_request_timeout_seconds=max(
                1,
                int(os.getenv("PANEL_HTTP_REQUEST_TIMEOUT_SECONDS", "10")),
            ),
            integration_stale_after_seconds=max(
                15,
                int(os.getenv("PANEL_INTEGRATION_STALE_AFTER_SECONDS", "90")),
            ),
            integration_unavailable_after_seconds=max(
                30,
                int(os.getenv("PANEL_INTEGRATION_UNAVAILABLE_AFTER_SECONDS", "300")),
            ),
            integration_max_backoff_seconds=max(
                30,
                int(os.getenv("PANEL_INTEGRATION_MAX_BACKOFF_SECONDS", "120")),
            ),
            avalar_ssh_enabled=_bool_env("PANEL_AVALAR_SSH_ENABLED", False),
            avalar_ssh_host=os.getenv("PANEL_AVALAR_SSH_HOST", "avalar-reg").strip(),
            avalar_ssh_remote_script=os.getenv(
                "PANEL_AVALAR_SSH_STATUS_COMMAND",
                "~/control-center-avalar.sh",
            ).strip(),
            avalar_ssh_refresh_seconds=max(
                60,
                int(os.getenv("PANEL_AVALAR_SSH_REFRESH_SECONDS", "180")),
            ),
            avalar_ssh_timeout_seconds=max(
                1,
                int(os.getenv("PANEL_AVALAR_SSH_TIMEOUT_SECONDS", "15")),
            ),
            avalar_ssh_output_limit_bytes=max(
                1024,
                int(os.getenv("PANEL_AVALAR_SSH_OUTPUT_LIMIT_BYTES", "32768")),
            ),
            avalar_actions_enabled=_bool_env("PANEL_AVALAR_ACTIONS_ENABLED", False),
            avalar_action_ssh_host=os.getenv(
                "PANEL_AVALAR_ACTION_SSH_HOST",
                "avalar-control",
            ).strip(),
            avalar_action_remote_script=os.getenv(
                "PANEL_AVALAR_ACTION_COMMAND",
                "~/control-center-avalar-action.sh",
            ).strip(),
            avalar_action_timeout_seconds=min(
                180,
                max(10, int(os.getenv("PANEL_AVALAR_ACTION_TIMEOUT_SECONDS", "150"))),
            ),
            avalar_action_output_limit_bytes=max(
                1024,
                int(os.getenv("PANEL_AVALAR_ACTION_OUTPUT_LIMIT_BYTES", "32768")),
            ),
            avalar_smoke_enabled=_bool_env("PANEL_AVALAR_SMOKE_ENABLED", False),
            avalar_stage_restart_enabled=_bool_env(
                "PANEL_AVALAR_STAGE_RESTART_ENABLED",
                False,
            ),
            avalar_main_restart_enabled=_bool_env(
                "PANEL_AVALAR_MAIN_RESTART_ENABLED",
                False,
            ),
            avalar_stage_deploy_enabled=_bool_env(
                "PANEL_AVALAR_STAGE_DEPLOY_ENABLED",
                False,
            ),
            avalar_main_deploy_enabled=_bool_env(
                "PANEL_AVALAR_MAIN_DEPLOY_ENABLED",
                False,
            ),
            rog_g703_enabled=_bool_env("PANEL_ROG_G703_ENABLED", False),
            rog_g703_target_id=os.getenv(
                "PANEL_ROG_G703_TARGET_ID",
                "rog_g703gi",
            ).strip(),
            rog_g703_mac=os.getenv("PANEL_ROG_G703_MAC", "").strip(),
            rog_g703_broadcast_address=os.getenv(
                "PANEL_ROG_G703_BROADCAST_ADDRESS",
                "255.255.255.255",
            ).strip(),
            rog_g703_broadcast_interface=os.getenv(
                "PANEL_ROG_G703_BROADCAST_INTERFACE",
                "",
            ).strip(),
            rog_g703_companion_base_url=os.getenv(
                "PANEL_ROG_G703_COMPANION_BASE_URL",
                "",
            ).strip().rstrip("/"),
            rog_g703_companion_secret=os.getenv(
                "PANEL_ROG_G703_COMPANION_SECRET",
                "",
            ),
            rog_g703_wol_repeats=min(
                3,
                max(1, int(os.getenv("PANEL_ROG_G703_WOL_REPEATS", "3"))),
            ),
            rog_g703_wol_cooldown_seconds=min(
                60,
                max(3, int(os.getenv("PANEL_ROG_G703_WOL_COOLDOWN_SECONDS", "5"))),
            ),
            rog_g703_hibernate_cooldown_seconds=min(
                120,
                max(5, int(os.getenv("PANEL_ROG_G703_HIBERNATE_COOLDOWN_SECONDS", "10"))),
            ),
            rog_g703_health_timeout_seconds=min(
                180,
                max(5, int(os.getenv("PANEL_ROG_G703_HEALTH_TIMEOUT_SECONDS", "60"))),
            ),
            rog_g703_hibernate_timeout_seconds=min(
                120,
                max(5, int(os.getenv("PANEL_ROG_G703_HIBERNATE_TIMEOUT_SECONDS", "45"))),
            ),
            rog_g703_http_timeout_seconds=min(
                10.0,
                max(0.5, float(os.getenv("PANEL_ROG_G703_HTTP_TIMEOUT_SECONDS", "3"))),
            ),
            rog_g703_health_poll_seconds=min(
                120.0,
                max(5.0, float(os.getenv("PANEL_ROG_G703_HEALTH_POLL_SECONDS", "15"))),
            ),
            rog_g703_response_limit_bytes=min(
                64 * 1024,
                max(1024, int(os.getenv("PANEL_ROG_G703_RESPONSE_LIMIT_BYTES", str(16 * 1024)))),
            ),
            writes_enabled=_bool_env("PANEL_WRITES_ENABLED", False),
            coffee_timing_writes_enabled=_bool_env(
                "PANEL_COFFEE_TIMING_WRITES_ENABLED",
                False,
            ),
            coffee_notification_writes_enabled=_bool_env(
                "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED",
                False,
            ),
            coffee_actions_enabled=_bool_env(
                "PANEL_COFFEE_ACTIONS_ENABLED",
                False,
            ),
            overview_layout_writes_enabled=_bool_env(
                "PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED",
                False,
            ),
            overview_layout_path=os.getenv(
                "PANEL_OVERVIEW_LAYOUT_PATH",
                ".cache/overview-layout.json",
            ).strip(),
            access_temporary_minutes=max(
                1,
                int(os.getenv("PANEL_ACCESS_TEMPORARY_MINUTES", "30")),
            ),
            sse_heartbeat_seconds=max(
                5,
                int(os.getenv("PANEL_SSE_HEARTBEAT_SECONDS", "20")),
            ),
            panel_planning_enabled=_bool_env("PANEL_PLANNING_ENABLED", False),
            panel_planning_reminder_mutations_enabled=_bool_env(
                "PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED",
                False,
            ),
            panel_planning_task_mutations_enabled=_bool_env(
                "PANEL_PLANNING_TASK_MUTATIONS_ENABLED",
                False,
            ),
            panel_planning_base_url=os.getenv("PANEL_PLANNING_BASE_URL", "").strip().rstrip("/"),
            panel_planning_internal_secret=os.getenv("PANEL_PLANNING_INTERNAL_SECRET", ""),
            panel_planning_secret=os.getenv("PANEL_PLANNING_SECRET", ""),
            panel_planning_refresh_seconds=max(
                5,
                min(300, int(os.getenv("PANEL_PLANNING_REFRESH_SECONDS", "20"))),
            ),
            panel_planning_status_refresh_seconds=max(
                60,
                min(3600, int(os.getenv("PANEL_PLANNING_STATUS_REFRESH_SECONDS", "300"))),
            ),
            panel_planning_stale_after_seconds=max(
                15,
                int(os.getenv("PANEL_PLANNING_STALE_AFTER_SECONDS", "90")),
            ),
            panel_planning_unavailable_after_seconds=max(
                30,
                int(os.getenv("PANEL_PLANNING_UNAVAILABLE_AFTER_SECONDS", "300")),
            ),
            panel_planning_max_backoff_seconds=max(
                30,
                min(3600, int(os.getenv("PANEL_PLANNING_MAX_BACKOFF_SECONDS", "120"))),
            ),
            panel_planning_cache_path=os.getenv(
                "PANEL_PLANNING_CACHE_PATH",
                ".cache/planning-snapshot.json",
            ).strip(),
            panel_planning_response_limit_bytes=max(
                4096,
                min(
                    2 * 1024 * 1024,
                    int(os.getenv("PANEL_PLANNING_RESPONSE_LIMIT_BYTES", str(256 * 1024))),
                ),
            ),
            panel_planning_timezone=os.getenv(
                "PANEL_PLANNING_TIMEZONE",
                "Europe/Moscow",
            ).strip(),
            panel_planning_fixture_scenario=os.getenv(
                "PANEL_PLANNING_FIXTURE_SCENARIO",
                "healthy",
            ).strip(),
        )
        if settings.panel_planning_enabled:
            _validate_planning_settings(settings)
        if settings.rog_g703_enabled:
            _validate_rog_g703_settings(settings)
        return settings


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _validate_planning_settings(settings: IntegrationSettings) -> None:
    if not settings.panel_planning_base_url:
        raise RuntimeError(
            "PANEL_PLANNING_ENABLED requires PANEL_PLANNING_BASE_URL"
        )
    if not settings.panel_planning_internal_secret or not settings.panel_planning_secret:
        raise RuntimeError(
            "PANEL_PLANNING_ENABLED requires both Planning server secrets"
        )
    parsed = urlsplit(settings.panel_planning_base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("PANEL_PLANNING_BASE_URL must use http or https")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError(
            "PANEL_PLANNING_BASE_URL must not contain credentials, query, or fragment"
        )
    if parsed.path not in {"", "/"}:
        raise RuntimeError("PANEL_PLANNING_BASE_URL must be an origin without a path")
    try:
        ZoneInfo(settings.panel_planning_timezone)
    except ZoneInfoNotFoundError as exc:
        raise RuntimeError("PANEL_PLANNING_TIMEZONE must be an IANA timezone") from exc
    if settings.panel_planning_status_refresh_seconds < settings.panel_planning_refresh_seconds:
        raise RuntimeError(
            "PANEL_PLANNING_STATUS_REFRESH_SECONDS must not be faster than domain polling"
        )
    if settings.panel_planning_unavailable_after_seconds < settings.panel_planning_stale_after_seconds:
        raise RuntimeError(
            "PANEL_PLANNING_UNAVAILABLE_AFTER_SECONDS must be at least stale threshold"
        )


def _validate_rog_g703_settings(settings: IntegrationSettings) -> None:
    if settings.rog_g703_target_id != "rog_g703gi":
        raise RuntimeError("PANEL_ROG_G703_TARGET_ID must be rog_g703gi")

    compact_mac = re.sub(r"[-:.]", "", settings.rog_g703_mac)
    if not re.fullmatch(r"[0-9a-fA-F]{12}", compact_mac):
        raise RuntimeError(
            "PANEL_ROG_G703_MAC must be a valid 12-digit Ethernet MAC address"
        )
    mac_bytes = bytes.fromhex(compact_mac)
    if mac_bytes == b"\x00" * 6 or mac_bytes[0] & 1:
        raise RuntimeError("PANEL_ROG_G703_MAC must be a unicast, non-zero MAC address")

    for name, value in (
        ("PANEL_ROG_G703_BROADCAST_ADDRESS", settings.rog_g703_broadcast_address),
        ("PANEL_ROG_G703_BROADCAST_INTERFACE", settings.rog_g703_broadcast_interface),
    ):
        if not value and name.endswith("INTERFACE"):
            continue
        try:
            address = ipaddress.ip_address(value)
        except ValueError as exc:
            raise RuntimeError(f"{name} must be an IPv4 address") from exc
        if address.version != 4:
            raise RuntimeError(f"{name} must be an IPv4 address")
        if name.endswith("ADDRESS") and (
            address.is_unspecified or address.is_loopback or address.is_multicast
        ):
            raise RuntimeError(
                "PANEL_ROG_G703_BROADCAST_ADDRESS must be a LAN broadcast address"
            )

    if not settings.rog_g703_companion_secret or len(settings.rog_g703_companion_secret) < 32:
        raise RuntimeError(
            "PANEL_ROG_G703_COMPANION_SECRET must contain at least 32 characters"
        )
    if any(character.isspace() or ord(character) < 32 for character in settings.rog_g703_companion_secret):
        raise RuntimeError("PANEL_ROG_G703_COMPANION_SECRET must not contain whitespace")

    parsed = urlsplit(settings.rog_g703_companion_base_url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise RuntimeError(
            "PANEL_ROG_G703_COMPANION_BASE_URL must be an http origin"
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError(
            "PANEL_ROG_G703_COMPANION_BASE_URL must not contain credentials, query, or fragment"
        )
    if parsed.path not in {"", "/"}:
        raise RuntimeError(
            "PANEL_ROG_G703_COMPANION_BASE_URL must be an origin without a path"
        )

    if settings.rog_g703_wol_repeats > 3:
        raise RuntimeError("PANEL_ROG_G703_WOL_REPEATS must be at most 3")
