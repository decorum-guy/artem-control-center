from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .capabilities import CapabilityOverrideStore

from fastapi import APIRouter, Header, HTTPException, Response, status

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
    return _bool_env("PANEL_CAPABILITY_APPLY_ENABLED") and _command_path() is not None


def _require_intent(intent: str) -> None:
    if intent != "kiosk-control":
        raise HTTPException(status_code=403, detail="runtime_control_intent_required")


class CapabilityApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedRevision: int = Field(ge=0, le=2_147_483_647)


def _write_command(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


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
        return {"status": status_value, "revision": payload.get("revision"), "updatedAt": payload.get("updatedAt")}
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


@router.post("/hide", status_code=status.HTTP_202_ACCEPTED)
def hide_runtime(
    x_panel_intent: str = Header(default=""),
) -> dict:
    return _request_action("hide", x_panel_intent)


@router.post("/shutdown", status_code=status.HTTP_202_ACCEPTED)
def shutdown_runtime(
    x_panel_intent: str = Header(default=""),
) -> dict:
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
    document, available = CapabilityOverrideStore().read()
    if not available:
        raise HTTPException(status_code=409, detail="capability_store_unavailable")
    if document["revision"] != payload.expectedRevision:
        raise HTTPException(status_code=409, detail="revision_conflict")
    state_path = os.getenv("PANEL_CAPABILITY_APPLY_STATE_PATH", "").strip()
    if state_path:
        _write_command(Path(state_path), {
            "schemaVersion": 1,
            "status": "queued",
            "revision": payload.expectedRevision,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        })
    _write_command(path, {
        "schemaVersion": 1,
        "action": "apply_capabilities",
        "expectedRevision": payload.expectedRevision,
        "requestId": secrets.token_hex(12),
        "requestedAt": datetime.now(timezone.utc).isoformat(),
    })
    return {"accepted": True, "action": "apply_capabilities"}
