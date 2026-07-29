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
    avalar_details_token: str = ""
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
            avalar_details_token=os.getenv("PANEL_AVALAR_DETAILS_TOKEN", ""),
            writes_enabled=_bool_env("PANEL_WRITES_ENABLED", False),
        )


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}
