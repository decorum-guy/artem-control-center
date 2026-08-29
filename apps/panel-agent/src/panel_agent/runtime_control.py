from __future__ import annotations

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .capabilities import CapabilityOverrideStore
from .system_update import software_update_active

RuntimeAction = Literal["hide", "shutdown", "apply_capabilities"]

router = APIRouter(prefix="/api/v1/system/runtime", tags=["system"])


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _command_path() -> Path | None:
    raw = os.getenv("PANEL_RUNTIME_COMMAND_PATH", "").strip()
    return Path(raw) if raw else None


def _enabled() -> bool:
    return _bool_env("PANEL_KIOSK_CONTROLS_ENABLED") and _command_path() is not None


def _capability_apply_enabled() -> bool:
    # Applying a persisted delayed override is a write operation too. Keeping
    # this check here makes a previously staged command fail closed when the
    # global master is disabled after staging but before Apply.
    return (
        _bool_env("PANEL_WRITES_ENABLED")
        and _bool_env("PANEL_CAPABILITY_APPLY_ENABLED")
        and _command_path() is not None
    )


def _require_intent(intent: str) -> None:
    if intent != "kiosk-control":
        raise HTTPException(status_code=403, detail="runtime_control_intent_required")


class CapabilityApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedRevision: int = Field(ge=0, le=2_147_483_647)


class KioskPresenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    pageId: str = Field(pattern=r"^[0-9a-f]{24}$")


def _write_command(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    temporary_path: Path | None = None
    try:
        # Keep the temporary file beside the target so os.replace remains an
        # atomic publication on the same filesystem. delete=False is deliberate:
        # the file is closed by the context manager before os.replace, including
        # on Windows, and the finally path below owns its cleanup.
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(serialized)
            temporary.flush()
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass


def _request_action(action: RuntimeAction, intent: str) -> dict:
    _require_intent(intent)
    path = _command_path()
    if not _enabled() or path is None:
        raise HTTPException(status_code=409, detail="runtime_controls_disabled")

    requested_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "schemaVersion": 1,
        "action": action,
        "requestedAt": requested_at,
    }

    # Edge can move the visible kiosk window to a process whose command line no
    # longer carries the transient --kiosk flag. The independent Windows watcher
    # closes every process that uses only the dedicated panel profile. Write its
    # request first so it survives even when shutdown immediately stops the Agent.
    _write_command(
        path.parent / "kiosk-close-request.json",
        {
            "schemaVersion": 1,
            "action": action,
            "requestedAt": requested_at,
        },
    )

    # The supervisor command must exist before the HTTP handler returns. A previous
    # BackgroundTasks implementation could acknowledge the request without ever
    # materialising the command on the Windows host.
    _write_command(path, payload)
    return {"accepted": True, "action": action}


def _apply_state() -> dict:
    raw_path = os.getenv("PANEL_CAPABILITY_APPLY_STATE_PATH", "").strip()
    if not raw_path:
        return {"status": "idle"}
    try:
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
            raise ValueError("invalid")
        status_value = payload.get("status")
        if status_value not in {"idle", "queued", "building", "restarting", "success", "failed"}:
            raise ValueError("invalid")
        return {
            "status": status_value,
            "revision": payload.get("revision"),
            "updatedAt": payload.get("updatedAt"),
        }
    except (OSError, ValueError, json.JSONDecodeError):
        return {"status": "idle"}


@router.get("")
def runtime_status(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {
        "enabled": _enabled(),
        "capabilityApplyEnabled": _capability_apply_enabled(),
        "capabilityApply": _apply_state(),
        "platform": os.name,
    }


@router.post("/kiosk-presence", status_code=status.HTTP_204_NO_CONTENT)
def kiosk_presence(
    payload: KioskPresenceRequest,
    x_panel_intent: str = Header(default=""),
) -> Response:
    if x_panel_intent != "kiosk-presence":
        raise HTTPException(status_code=403, detail="kiosk_presence_intent_required")
    command_path = _command_path()
    if command_path is None:
        raise HTTPException(status_code=409, detail="runtime_path_unavailable")
    _write_command(
        command_path.parent / "kiosk-presence.json",
        {
            "schemaVersion": 1,
            "pageId": payload.pageId,
            "observedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "no-store"})


@router.post("/hide", status_code=status.HTTP_202_ACCEPTED)
def hide_runtime(x_panel_intent: str = Header(default="")) -> dict:
    return _request_action("hide", x_panel_intent)


@router.post("/shutdown", status_code=status.HTTP_202_ACCEPTED)
def shutdown_runtime(x_panel_intent: str = Header(default="")) -> dict:
    return _request_action("shutdown", x_panel_intent)


@router.post("/apply-capabilities", status_code=status.HTTP_202_ACCEPTED)
def apply_capabilities(
    payload: CapabilityApplyRequest,
    x_panel_intent: str = Header(default=""),
) -> dict:
    if x_panel_intent != "capability-apply":
        raise HTTPException(status_code=403, detail="capability_apply_intent_required")
    path = _command_path()
    if not _capability_apply_enabled() or path is None:
        raise HTTPException(status_code=409, detail="capability_apply_disabled")
    if software_update_active(path.parent):
        raise HTTPException(status_code=409, detail="software_update_active")

    document, available = CapabilityOverrideStore().read()
    if not available:
        raise HTTPException(status_code=409, detail="capability_store_unavailable")
    if document["revision"] != payload.expectedRevision:
        raise HTTPException(status_code=409, detail="revision_conflict")

    state_path_raw = os.getenv("PANEL_CAPABILITY_APPLY_STATE_PATH", "").strip()
    state_path = Path(state_path_raw) if state_path_raw else None
    requested_at = datetime.now(timezone.utc).isoformat()
    if state_path is not None:
        # Claim the Apply maintenance window before the final updater re-check.
        # An update that races us will now either see queued and yield, or will
        # already own update-lock and make this Apply yield below.
        _write_command(state_path, {
            "schemaVersion": 1,
            "status": "queued",
            "revision": payload.expectedRevision,
            "updatedAt": requested_at,
        })

    if software_update_active(path.parent):
        if state_path is not None:
            _write_command(state_path, {
                "schemaVersion": 1,
                "status": "failed",
                "revision": payload.expectedRevision,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "code": "software_update_active",
            })
        raise HTTPException(status_code=409, detail="software_update_active")

    if path.exists():
        if state_path is not None:
            _write_command(state_path, {
                "schemaVersion": 1,
                "status": "failed",
                "revision": payload.expectedRevision,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "code": "runtime_command_busy",
            })
        raise HTTPException(status_code=409, detail="runtime_command_busy")

    _write_command(path, {
        "schemaVersion": 1,
        "action": "apply_capabilities",
        "expectedRevision": payload.expectedRevision,
        "requestId": secrets.token_hex(12),
        "requestedAt": requested_at,
    })
    return {"accepted": True, "action": "apply_capabilities"}
