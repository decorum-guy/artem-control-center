"""Isolated Samsung dashboard using the protected Station OAuth file or a temporary lease."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

FINAL_HOURS = 48
PORT = 8797
ROOT = Path(__file__).resolve().parent
WINDOWS_DATA = Path(os.environ["LOCALAPPDATA"])
LIVE = WINDOWS_DATA / "ArtemControlCenter"
sys.path[:0] = [str(ROOT / "apps/panel-agent/src"), str(ROOT / "deps")]

from dotenv import dotenv_values
from websockets.exceptions import WebSocketException

from panel_agent.station_credentials import dpapi

# Only these values are borrowed from the canonical runtime in memory.
config = dotenv_values(LIVE / "runtime.env", interpolate=False)
ha = urlsplit(config.get("PANEL_HA_URL") or "")
if ha.scheme != "http" or ha.hostname not in {"127.0.0.1", "localhost"}:
    raise RuntimeError("The configured private HA connection is unavailable")
canonical = Path(config.get("PANEL_ACCESS_POLICY_PATH") or LIVE / "access-policy.json")
lease_path = ROOT / "lease.dpapi"
lease = json.loads(dpapi(lease_path.read_bytes(), decrypt=True))
if time.time() >= lease["expiresAt"]:
    raise RuntimeError("The preview lease expired")
oauth_file = ROOT / "station-credentials" / "oauth.dpapi"
has_oauth_file = oauth_file.is_file()
if not has_oauth_file and not lease.get("token"):
    raise RuntimeError("The preview needs an authorized Station credential")

isolated_profile = ROOT / "profile" / "ArtemControlCenter"
isolated_profile.mkdir(parents=True, exist_ok=True)
old_history = LIVE / "station-retention-pilot" / "retention.json"
new_history = isolated_profile / "station-retention.json"
if old_history.is_file() and not new_history.exists():
    shutil.copyfile(old_history, new_history)

for key in list(os.environ):
    if key.startswith("PANEL_"):
        os.environ.pop(key)
os.environ.update(
    LOCALAPPDATA=str(ROOT / "profile"),
    PANEL_AGENT_MODE="read_only",
    PANEL_TV_VOICE_ENABLED="true",
    PANEL_HA_URL=ha.geturl(),
    PANEL_HA_TOKEN=config.get("PANEL_HA_TOKEN") or "",
    PANEL_STATION_PLAYBACK_HOST=lease["host"],
    PANEL_STATION_PLAYBACK_CERT_SHA256=lease["fingerprint"],
    PANEL_STATION_PLAYBACK_DEVICE_ID=lease["device_id"],
    PANEL_STATION_RETENTION_ENABLED="true",
    PANEL_LIGHT_STRIP_PROVIDER="both",
    PANEL_BLE_STRIP_ADDRESS=lease["ble_address"],
    PANEL_TV_EXECUTOR_TOKEN_FILE=config.get("PANEL_TV_EXECUTOR_TOKEN_FILE") or "",
)
if has_oauth_file:
    os.environ["PANEL_STATION_PLAYBACK_CREDENTIAL_FILE"] = str(oauth_file)

import uvicorn

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.ble_strip import build_ble_strip_router
from panel_agent.capabilities import CapabilityOverrideStore
from panel_agent.main import app, ble_strip, runtime, startup_lifecycle, station_playback
from panel_agent.static_dashboard import install_dashboard_routes
from panel_agent.station_playback import RECONNECT_SECONDS, StationAuthRequired, StationReplyUnavailable
from panel_agent.tv_api import TVExecutorClient
from panel_agent.tv_voice import TVVoiceBridge

logging.getLogger("panel_agent.tv_voice").setLevel(logging.INFO)
logging.basicConfig(level=logging.WARNING)


def access():
    return AccessPolicyStore(canonical, audit_dir=ROOT / "audit", read_only=True)


def allowed(key: str) -> bool:
    current = dotenv_values(LIVE / "runtime.env", interpolate=False)
    toggle = {"true", "1", "yes", "on"}
    if startup_lifecycle.phase != "ready" or (current.get("PANEL_WRITES_ENABLED") or "").lower() not in toggle:
        return False
    enabled = (current.get(key) or "").lower() in toggle
    if key == "PANEL_LIGHT_STRIP_ACTIONS_ENABLED":
        overrides = Path(current.get("PANEL_CAPABILITY_OVERRIDES_PATH") or LIVE / "capability-overrides.json")
        saved, valid = CapabilityOverrideStore(overrides).read()
        if valid:
            enabled = saved["overrides"].get("light_strip_actions", enabled)
    return enabled


async def device_lease(settings):
    delay = RECONNECT_SECONDS
    while time.time() < lease["expiresAt"]:
        try:
            await station_playback._listen(settings, lease["token"])
        except StationAuthRequired:
            await station_playback.update("auth_required")
            return
        except (OSError, ValueError, TimeoutError, WebSocketException):
            await station_playback.update("stale")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


if not has_oauth_file:
    station_playback._run_session = device_lease
assert ble_strip is not None
app.include_router(build_ble_strip_router(ble_strip, access, lambda: allowed("PANEL_LIGHT_STRIP_ACTIONS_ENABLED")))
executor = TVExecutorClient(Path(config["PANEL_TV_EXECUTOR_TOKEN_FILE"]))
bridge = TVVoiceBridge(
    station_entity=lease["station_entity"], executor=executor,
    access=access, write_enabled=lambda: allowed("PANEL_WRITES_ENABLED"),
)
runtime.home_assistant.set_yandex_scenario_handler(bridge.handle)


@app.get("/__acceptance")
async def acceptance():
    state = station_playback.state
    return {
        "mode": "isolated",
        "ready": startup_lifecycle.phase == "ready",
        "station": state.status if state else "connecting",
        "stationCredentialSource": "windows_dpapi" if has_oauth_file else "temporary_device_lease",
        "stationObservedAt": state.observedAt if state else None,
        "metadata": {"title": bool(state and state.title), "artist": bool(state and state.artist),
                     "cover": bool(state and state.coverPath)},
        "ble": ble_strip.available,
        "bleLastGatt": ble_strip.checked_at,
        "bleWriteGate": allowed("PANEL_LIGHT_STRIP_ACTIONS_ENABLED"),
        "haScenarioSubscribed": runtime.home_assistant._yandex_scenario_subscribed,
        "access": access().effective_profile(),
        "revision": lease["revision"],
    }


install_dashboard_routes(app, ROOT / "dashboard")


async def serve():
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, proxy_headers=False, access_log=False))

    async def maintenance():
        probe = ROOT / "read-reminders-once"
        while time.time() < min(STARTED + FINAL_HOURS * 3600, lease["expiresAt"]) and not (ROOT / "stop").exists():
            if probe.is_file():
                probe.unlink()
                try:
                    response = await station_playback.request_reminder_list()
                    safe = {field: type(response[field]).__name__ for field in
                            ("card", "cards", "output_speech", "text", "is_streaming") if field in response}
                    result = {"result": "response_envelope", "knownFields": safe}
                except StationReplyUnavailable:
                    result = {"result": "no_correlated_content"}
                (ROOT / "reminder-check.json").write_text(json.dumps(result), encoding="utf-8")
            await asyncio.sleep(1)
        server.should_exit = True

    monitor = asyncio.create_task(maintenance())
    try:
        await server.serve()
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)
        await bridge.close()
        lease_path.unlink(missing_ok=True)


if __name__ == "__main__":
    STARTED = time.time()
    asyncio.run(serve())
