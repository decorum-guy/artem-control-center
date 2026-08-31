"""Panel-owned, source-registered device presentation visibility."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Mapping

from .contracts import (
    DeviceVisibilityPatch,
    DeviceVisibilitySettingsResponse,
    DeviceVisibilityState,
    OwnerFacingDeviceKey,
)

SCHEMA_VERSION = "device.visibility.v1"
MAX_FILE_BYTES = 64 * 1024


@dataclass(frozen=True)
class OwnerFacingDeviceDefinition:
    key: OwnerFacingDeviceKey
    label: str
    default_visible: bool
    service_id: str
    data_contract: str


# This is the only source-owned registry. Browser input can select its key,
# but cannot add an entity, service, route, or backend registration.
OWNER_FACING_DEVICE_REGISTRY: tuple[OwnerFacingDeviceDefinition, ...] = (
    OwnerFacingDeviceDefinition(
        key="kettle",
        label="Чайник",
        default_visible=True,
        service_id="kettle",
        data_contract="home.kettle.v1",
    ),
)
_BY_KEY = {definition.key: definition for definition in OWNER_FACING_DEVICE_REGISTRY}


class DeviceVisibilityStoreError(ValueError):
    pass


class DeviceVisibilityRevisionConflict(DeviceVisibilityStoreError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def device_visibility_store_path() -> Path:
    configured = os.getenv("PANEL_DEVICE_VISIBILITY_PATH", "").strip()
    if configured:
        return Path(configured)
    root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
    return root / "device-visibility.json"


def _empty_document() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": 0,
        "updatedAt": _utc_now(),
        "visibility": {},
    }


class DeviceVisibilitySettingsStore:
    def __init__(self, path: str | Path, *, writes_enabled: bool = False) -> None:
        self.path = Path(path)
        self.writes_enabled = writes_enabled
        self._write_lock = Lock()

    def _read_raw(self) -> Mapping[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                return None
            raw = json.loads(self.path.read_bytes().decode("utf-8"))
            return raw if isinstance(raw, dict) else None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _canonical(self, raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if raw is None or raw.get("schemaVersion") != SCHEMA_VERSION:
            return None
        revision = raw.get("revision")
        updated_at = raw.get("updatedAt")
        visibility = raw.get("visibility")
        if (
            type(revision) is not int
            or revision < 0
            or not isinstance(updated_at, str)
            or not isinstance(visibility, dict)
        ):
            return None
        if any(key not in _BY_KEY or type(value) is not bool for key, value in visibility.items()):
            return None
        return {
            "schemaVersion": SCHEMA_VERSION,
            "revision": revision,
            "updatedAt": updated_at,
            "visibility": dict(visibility),
        }

    def _response(self, *, document: Mapping[str, Any], available: bool, warning: bool = False) -> DeviceVisibilitySettingsResponse:
        visibility = document["visibility"] if available else {}
        return DeviceVisibilitySettingsResponse(
            schemaVersion=SCHEMA_VERSION,
            revision=document["revision"],
            updatedAt=document["updatedAt"],
            devices=[
                DeviceVisibilityState(
                    key=definition.key,
                    label=definition.label,
                    defaultVisible=definition.default_visible,
                    visible=visibility.get(definition.key, definition.default_visible),
                )
                for definition in OWNER_FACING_DEVICE_REGISTRY
            ],
            available=available,
            warnings=["stored_device_visibility_unavailable"] if warning else [],
            writesEnabled=self.writes_enabled,
        )

    def read(self) -> DeviceVisibilitySettingsResponse:
        raw = self._read_raw()
        canonical = self._canonical(raw)
        if canonical is None:
            return self._response(
                document=_empty_document(),
                available=not self.path.exists(),
                warning=self.path.exists(),
            )
        return self._response(document=canonical, available=True)

    def write(self, patch: DeviceVisibilityPatch) -> DeviceVisibilitySettingsResponse:
        if patch.deviceKey not in _BY_KEY:
            raise DeviceVisibilityStoreError("device_visibility_key_unknown")
        with self._write_lock:
            current = self.read()
            if not current.available:
                raise DeviceVisibilityStoreError("stored_device_visibility_unavailable")
            if current.revision != patch.expectedRevision:
                raise DeviceVisibilityRevisionConflict("revision_conflict")
            document = {
                **_empty_document(),
                "revision": patch.expectedRevision + 1,
                "visibility": {
                    device.key: device.visible
                    for device in current.devices
                    if device.key != patch.deviceKey
                },
            }
            document["visibility"][patch.deviceKey] = patch.visible
            self._atomic_write(document)
            return self._response(document=document, available=True)

    def _atomic_write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        temporary_path: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent, delete=False) as handle:
                temporary_path = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except OSError:
                    pass
