from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore


SystemControlName = Literal["volume", "brightness"]

_CONTROL_CAPABILITY: dict[SystemControlName, str] = {
    "volume": "settings.system.volume",
    "brightness": "settings.system.brightness",
}
_MAX_OUTPUT_BYTES = 8_192


class SystemControlsError(RuntimeError):
    pass


class SystemControlPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    value: int = Field(ge=0, le=100)


def _default_script_path() -> Path:
    return Path(__file__).resolve().parents[4] / "scripts" / "windows" / "system-controls.ps1"


class WindowsSystemControls:
    """Narrow Windows volume/brightness bridge.

    The browser can select only a typed control and a bounded 0..100 value.
    PowerShell receives a fixed source-controlled helper plus a fixed action.
    """

    def __init__(
        self,
        *,
        platform: str | None = None,
        powershell: str = "powershell.exe",
        script_path: str | Path | None = None,
        runner: Callable[..., Any] = subprocess.run,
        timeout_seconds: float = 8.0,
    ) -> None:
        self.platform = platform or os.name
        self.powershell = powershell
        self.script_path = Path(script_path) if script_path is not None else _default_script_path()
        self._runner = runner
        self.timeout_seconds = timeout_seconds
        self._lock = Lock()

    @property
    def supported_platform(self) -> bool:
        return self.platform == "nt"

    def _invoke(self, action: str, value: int | None = None) -> dict[str, Any]:
        if not self.supported_platform or not self.script_path.is_file():
            raise SystemControlsError("system_controls_unavailable")
        argv = [
            self.powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.script_path),
            "-Action",
            action,
        ]
        if value is not None:
            argv.extend(["-Value", str(value)])

        if not self._lock.acquire(timeout=0.25):
            raise SystemControlsError("system_controls_busy")
        try:
            try:
                result = self._runner(
                    argv,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise SystemControlsError("system_controls_timeout") from exc
            except OSError as exc:
                raise SystemControlsError("system_controls_unavailable") from exc
        finally:
            self._lock.release()

        stdout = result.stdout if isinstance(result.stdout, str) else ""
        if result.returncode != 0:
            raise SystemControlsError("system_controls_unavailable")
        if not stdout or len(stdout.encode("utf-8")) > _MAX_OUTPUT_BYTES:
            raise SystemControlsError("system_controls_invalid_response")
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise SystemControlsError("system_controls_invalid_response") from exc
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
            raise SystemControlsError("system_controls_invalid_response")
        return payload

    @staticmethod
    def _control_state(payload: dict[str, Any], name: SystemControlName) -> dict[str, Any]:
        raw = payload.get(name)
        if not isinstance(raw, dict):
            return {"available": False, "value": None, "reason": "unavailable"}
        available = raw.get("available") is True
        value = raw.get("value")
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100:
            value = None
        if not available:
            value = None
        reason = raw.get("reason")
        if reason not in {"unsupported", "unavailable", None}:
            reason = "unavailable"
        return {
            "available": available and value is not None,
            "value": value if available else None,
            "reason": None if available and value is not None else (reason or "unavailable"),
        }

    def read(self) -> dict[SystemControlName, dict[str, Any]]:
        if not self.supported_platform:
            return {
                "volume": {"available": False, "value": None, "reason": "unsupported"},
                "brightness": {"available": False, "value": None, "reason": "unsupported"},
            }
        try:
            payload = self._invoke("status")
        except SystemControlsError:
            return {
                "volume": {"available": False, "value": None, "reason": "unavailable"},
                "brightness": {"available": False, "value": None, "reason": "unavailable"},
            }
        return {
            "volume": self._control_state(payload, "volume"),
            "brightness": self._control_state(payload, "brightness"),
        }

    def set_value(self, control: SystemControlName, value: int) -> dict[str, Any]:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            raise ValueError("system_control_value_out_of_range")
        payload = self._invoke(f"set-{control}", value)
        state = self._control_state(payload, control)
        if not state["available"] or state["value"] is None:
            raise SystemControlsError(f"{control}_unavailable")
        return state


def _http_error(error: SystemControlsError) -> HTTPException:
    code = str(error)
    if code == "system_controls_busy":
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=code)
    if code == "system_controls_timeout":
        return HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=code)
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=code)


def build_system_controls_router(
    controls: WindowsSystemControls,
    access: AccessPolicyStore,
    *,
    writes_enabled: Callable[[], bool],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/settings/system-controls", tags=["settings"])

    def project(states: dict[SystemControlName, dict[str, Any]]) -> dict[str, Any]:
        write_gate = bool(writes_enabled())
        projected: dict[str, Any] = {}
        for name in ("volume", "brightness"):
            typed_name: SystemControlName = name
            state_value = states[typed_name]
            decision = access.authorize(
                _CONTROL_CAPABILITY[typed_name],
                gate_enabled=write_gate,
                integration_available=bool(state_value["available"]),
            )
            projected[typed_name] = {
                **state_value,
                "writable": decision.allowed,
                "writeAvailability": decision.availability,
            }
        return {
            "schemaVersion": 1,
            "platform": "windows" if controls.supported_platform else "unsupported",
            "controls": projected,
        }

    @router.get("")
    def get_status(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return project(controls.read())

    def apply(control: SystemControlName, payload: SystemControlPatch, response: Response) -> dict[str, Any]:
        states = controls.read()
        state_value = states[control]
        capability = _CONTROL_CAPABILITY[control]
        access.require(
            capability,
            gate_enabled=bool(writes_enabled()),
            integration_available=bool(state_value["available"]),
        )
        try:
            controls.set_value(control, payload.value)
            access.audit_capability(capability, result="success")
        except SystemControlsError as exc:
            access.audit_capability(capability, result=str(exc))
            raise _http_error(exc)
        except ValueError as exc:
            access.audit_capability(capability, result=str(exc))
            raise HTTPException(status_code=422, detail=str(exc))
        response.headers["Cache-Control"] = "no-store"
        return project(controls.read())

    @router.patch("/volume")
    def set_volume(payload: SystemControlPatch, response: Response) -> dict[str, Any]:
        return apply("volume", payload, response)

    @router.patch("/brightness")
    def set_brightness(payload: SystemControlPatch, response: Response) -> dict[str, Any]:
        return apply("brightness", payload, response)

    return router
