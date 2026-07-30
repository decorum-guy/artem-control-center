from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Response, status

RuntimeAction = Literal["hide", "shutdown"]

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


def _require_intent(intent: str) -> None:
    if intent != "kiosk-control":
        raise HTTPException(status_code=403, detail="runtime_control_intent_required")


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

    payload = {
        "schemaVersion": 1,
        "action": action,
        "requestedAt": datetime.now(timezone.utc).isoformat(),
    }
    # The supervisor command must exist before the HTTP handler returns. A previous
    # BackgroundTasks implementation could acknowledge the request without ever
    # materialising the command on the Windows host.
    _write_command(path, payload)
    return {"accepted": True, "action": action}


@router.get("")
def runtime_status(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {
        "enabled": _enabled(),
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
