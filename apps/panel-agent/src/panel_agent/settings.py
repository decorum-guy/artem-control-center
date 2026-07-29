from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class IntegrationSettings:
    ha_url: str = ""
    ha_token: str = ""
    ha_stale_after_seconds: int = 90
    state_cache_path: str = ""
    alice_health_url: str = ""
    alice_details_token: str = ""
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
    writes_enabled: bool = False

    @classmethod
    def from_env(cls) -> "IntegrationSettings":
        return cls(
            ha_url=os.getenv("PANEL_HA_URL", "").rstrip("/"),
            ha_token=os.getenv("PANEL_HA_TOKEN", ""),
            ha_stale_after_seconds=max(
                15,
                int(os.getenv("PANEL_HA_STALE_AFTER_SECONDS", "90")),
            ),
            state_cache_path=os.getenv("PANEL_STATE_CACHE_PATH", ""),
            alice_health_url=os.getenv("PANEL_ALICE_HEALTH_URL", "").rstrip("/"),
            alice_details_token=os.getenv("PANEL_ALICE_DETAILS_TOKEN", ""),
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
            writes_enabled=_bool_env("PANEL_WRITES_ENABLED", False),
        )


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}
