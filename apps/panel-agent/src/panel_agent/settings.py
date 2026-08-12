from __future__ import annotations

import os
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
    writes_enabled: bool = False
    coffee_timing_writes_enabled: bool = False
    coffee_notification_writes_enabled: bool = False
    coffee_actions_enabled: bool = False
    access_temporary_minutes: int = 30
    sse_heartbeat_seconds: int = 20
    panel_planning_enabled: bool = False
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
            access_temporary_minutes=max(
                1,
                int(os.getenv("PANEL_ACCESS_TEMPORARY_MINUTES", "30")),
            ),
            sse_heartbeat_seconds=max(
                5,
                int(os.getenv("PANEL_SSE_HEARTBEAT_SECONDS", "20")),
            ),
            panel_planning_enabled=_bool_env("PANEL_PLANNING_ENABLED", False),
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
