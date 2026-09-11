"""Verified local backups for the closed Panel-owned configuration profile.

This module intentionally does not implement a generic filesystem exporter.  A
single server-owned source handler exposes a small allow-list of Panel state
files and a single local destination.  Future profiles can register their own
handler and destination without changing the execution lifecycle here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Sequence
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response, status

from .access_policy import AccessPolicyStore


PROFILE_ID = "artem-control-center-config"
SOURCE_HANDLER_ID = "panel-config"
DESTINATION_ID = "laptop-primary"
PROJECT_ID = "artem-control-center"
ENVIRONMENT_ID = "local-panel"
SERVICE_ID = "panel-agent"
ARCHIVE_FORMAT = "zip"
MANIFEST_SCHEMA = "backup.manifest.v1"
HISTORY_SCHEMA = "backup.history.v1"
API_SCHEMA = "backups.api.v1"
RUN_SCHEMA = "backup.run.v1"
HISTORY_FILENAME = "backup-history.v1.json"
HISTORY_LIMIT = 50
MAX_HISTORY_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MIN_FREE_SPACE_BYTES = 1 * 1024 * 1024
MAX_FREE_SPACE_BYTES = 1 * 1024 * 1024 * 1024 * 1024
MAX_SOURCE_BYTES = 256 * 1024
MAX_SMALL_SOURCE_BYTES = 64 * 1024
MAX_CAPABILITY_SOURCE_BYTES = 16 * 1024
ACTIVE_STATES = frozenset({"preparing", "exporting", "verifying"})
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class BackupFailure(Exception):
    """Internal failure carrying only a bounded public error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class BackupRequestError(Exception):
    """A bounded request-level error raised before an execution starts."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SourceItem:
    logical_id: str
    member_name: str
    optional: bool = True
    max_bytes: int = MAX_SOURCE_BYTES


PANEL_SOURCE_ITEMS: tuple[SourceItem, ...] = (
    SourceItem("overview.layout", "panel-config/overview-layout.json"),
    SourceItem("calendar.display-colors", "panel-config/calendar-display-colors.json", max_bytes=MAX_SMALL_SOURCE_BYTES),
    SourceItem("device.visibility", "panel-config/device-visibility.json", max_bytes=MAX_SMALL_SOURCE_BYTES),
    SourceItem("interface.copy", "panel-config/interface-copy-settings.json", max_bytes=MAX_SMALL_SOURCE_BYTES),
    SourceItem("project.registry", "panel-config/projects.yaml"),
    SourceItem("capability.overrides", "panel-config/capability-overrides.json", max_bytes=MAX_CAPABILITY_SOURCE_BYTES),
)
PANEL_SOURCE_ID_SET = frozenset(item.logical_id for item in PANEL_SOURCE_ITEMS)
PUBLIC_ERROR_CODES = frozenset({
    "backup_destination_unavailable",
    "backup_insufficient_free_space",
    "backup_history_unavailable",
    "backup_source_not_allowed",
    "backup_source_unavailable",
    "backup_source_too_large",
    "backup_archive_failed",
    "backup_artifact_collision",
    "backup_verification_failed",
    "backup_manifest_failed",
    "backup_history_write_failed",
    "backup_failed",
})


@dataclass(frozen=True)
class PanelConfigSource:
    """The server-owned `panel-config` handler.

    The mapping is assembled by the backend from existing stores.  It is not
    built from request data or the example YAML's old `paths` field.
    """

    paths: Mapping[str, Path]

    @classmethod
    def from_store_paths(
        cls,
        *,
        overview_layout: str | Path,
        calendar_display_colors: str | Path,
        device_visibility: str | Path,
        interface_copy: str | Path,
        project_registry: str | Path,
        capability_overrides: str | Path,
    ) -> "PanelConfigSource":
        return cls(
            paths={
                "overview.layout": Path(overview_layout),
                "calendar.display-colors": Path(calendar_display_colors),
                "device.visibility": Path(device_visibility),
                "interface.copy": Path(interface_copy),
                "project.registry": Path(project_registry),
                "capability.overrides": Path(capability_overrides),
            }
        )

    def path_for(self, logical_id: str) -> Path:
        path = self.paths.get(logical_id)
        if path is None:
            raise BackupFailure("backup_source_not_allowed")
        return path


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_member_name(name: str) -> bool:
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        return False
    path = PurePosixPath(name)
    if path.is_absolute() or name.startswith("/"):
        return False
    parts = name.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def _absolute_without_resolving(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _contains_symlink(path: Path) -> bool:
    """Check existing path components without resolving the final target."""
    absolute = _absolute_without_resolving(path)
    current = Path(absolute.anchor) if absolute.anchor else Path.cwd()
    parts = absolute.parts
    if absolute.anchor:
        parts = parts[1:]
    for part in parts:
        current = current / part
        try:
            if current.is_symlink():
                return True
        except OSError:
            return True
    return False


def _safe_server_path(path: Path) -> bool:
    return bool(path.is_absolute()) and not any(
        ord(character) < 32 for character in os.fspath(path)
    )


def _ensure_directory(path: Path, *, create: bool) -> None:
    if not _safe_server_path(path) or _contains_symlink(path):
        raise BackupFailure("backup_destination_unavailable")
    try:
        if path.exists():
            if not path.is_dir():
                raise BackupFailure("backup_destination_unavailable")
            return
        if not create:
            parent = path.parent
            if not parent.exists() or not parent.is_dir():
                raise BackupFailure("backup_destination_unavailable")
            return
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir() or _contains_symlink(path):
            raise BackupFailure("backup_destination_unavailable")
    except (OSError, ValueError):
        raise BackupFailure("backup_destination_unavailable") from None


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(os.fspath(path), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        # Directory fsync is not available on every supported Windows
        # filesystem.  File fsync and os.replace remain the required barriers.
        pass


def _safe_unlink(path: Path | None) -> None:
    if path is None:
        return
    try:
        if path.exists() or os.path.lexists(os.fspath(path)):
            path.unlink()
    except OSError:
        pass


def _read_bounded_source(path: Path, maximum: int) -> bytes:
    path = _absolute_without_resolving(path)
    if not _safe_server_path(path) or _contains_symlink(path):
        raise BackupFailure("backup_source_not_allowed")
    if not os.path.lexists(os.fspath(path)):
        raise BackupFailure("backup_source_unavailable")
    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(os.fspath(path), flags)
        metadata = os.fstat(descriptor)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise BackupFailure("backup_source_not_allowed")
        if metadata.st_size > maximum:
            raise BackupFailure("backup_source_too_large")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            data = handle.read(maximum + 1)
        if len(data) > maximum:
            raise BackupFailure("backup_source_too_large")
        return data
    except BackupFailure:
        raise
    except (OSError, ValueError):
        raise BackupFailure("backup_source_unavailable") from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _atomic_json_write(path: Path, payload: Mapping[str, Any], maximum: int, code: str) -> None:
    try:
        encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > maximum:
            raise BackupFailure(code)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{path.name}.",
            suffix=".partial",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except BackupFailure:
        raise
    except (OSError, TypeError, ValueError):
        try:
            _safe_unlink(temporary)  # type: ignore[possibly-undefined]
        except UnboundLocalError:
            pass
        raise BackupFailure(code) from None


def _validate_history_entry(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    required_keys = {
        "backupId", "profileId", "project", "environment", "service", "startedAt",
        "completedAt", "artifactFilename", "byteSize", "sha256", "archiveFormat",
        "includedSourceIds", "missingOptionalSourceIds", "verificationStatus",
        "destinationId", "result",
    }
    if set(entry) not in (required_keys, required_keys | {"errorCode"}):
        return False
    if entry.get("profileId") != PROFILE_ID or entry.get("destinationId") != DESTINATION_ID:
        return False
    if (
        entry.get("project") != PROJECT_ID
        or entry.get("environment") != ENVIRONMENT_ID
        or entry.get("service") != SERVICE_ID
        or entry.get("archiveFormat") != ARCHIVE_FORMAT
        or not isinstance(entry.get("startedAt"), str)
        or not isinstance(entry.get("completedAt"), str)
        or not isinstance(entry.get("includedSourceIds"), list)
        or not isinstance(entry.get("missingOptionalSourceIds"), list)
        or not set(entry["includedSourceIds"]).issubset(PANEL_SOURCE_ID_SET)
        or not set(entry["missingOptionalSourceIds"]).issubset(PANEL_SOURCE_ID_SET)
        or set(entry["includedSourceIds"]) & set(entry["missingOptionalSourceIds"])
    ):
        return False
    artifact = entry.get("artifactFilename")
    if artifact is not None and (not isinstance(artifact, str) or not _safe_member_name(artifact)):
        return False
    checksum = entry.get("sha256")
    if checksum is not None and (not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum)):
        return False
    byte_size = entry.get("byteSize")
    if byte_size is not None and (not isinstance(byte_size, int) or byte_size <= 0):
        return False
    if entry.get("result") not in {"success", "failed"}:
        return False
    if entry["result"] == "success":
        if entry.get("artifactFilename") is None or entry.get("byteSize") is None or entry.get("sha256") is None:
            return False
        if entry.get("verificationStatus") != "verified" or "errorCode" in entry:
            return False
    else:
        if entry.get("artifactFilename") is not None or entry.get("byteSize") is not None or entry.get("sha256") is not None:
            return False
        if entry.get("verificationStatus") != "failed" or entry.get("errorCode") not in PUBLIC_ERROR_CODES:
            return False
    if not isinstance(entry.get("backupId"), str) or not entry["backupId"]:
        return False
    return True


def _read_history(path: Path) -> tuple[bool, list[dict[str, Any]]]:
    if _contains_symlink(path):
        return False, []
    if not path.exists():
        return True, []
    try:
        if path.stat().st_size > MAX_HISTORY_BYTES:
            return False, []
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("schemaVersion") != HISTORY_SCHEMA:
            return False, []
        entries = payload.get("entries")
        if not isinstance(entries, list) or len(entries) > HISTORY_LIMIT:
            return False, []
        if not all(_validate_history_entry(entry) for entry in entries):
            return False, []
        return True, [dict(entry) for entry in entries]
    except (OSError, UnicodeError, TypeError, ValueError, json.JSONDecodeError):
        return False, []


def _history_document(entries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": HISTORY_SCHEMA,
        "entries": [dict(entry) for entry in list(entries)[:HISTORY_LIMIT]],
    }


def _profile_inventory(destination_available: bool, destination_configured: bool) -> dict[str, Any]:
    return {
        "id": PROFILE_ID,
        "name": "Control Center",
        "project": PROJECT_ID,
        "environment": ENVIRONMENT_ID,
        "service": SERVICE_ID,
        "sourceHandlerId": SOURCE_HANDLER_ID,
        "destinationId": DESTINATION_ID,
        "archiveFormat": ARCHIVE_FORMAT,
        "sourceItemCount": len(PANEL_SOURCE_ITEMS),
        "destinationConfigured": destination_configured,
        "available": destination_available,
    }


class BackupEngine:
    """One fixed-profile executor with a bounded in-memory active run."""

    def __init__(
        self,
        source: PanelConfigSource,
        root: str | Path,
        *,
        min_free_bytes: int,
        now: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], str] | None = None,
        archive_writer: Callable[[Path, Sequence[tuple[str, bytes]]], None] | None = None,
        verification_hook: Callable[[Path], None] | None = None,
        lifecycle_hook: Callable[[str], None] | None = None,
    ) -> None:
        self.source = source
        self.root = Path(root) if root else Path("")
        self.min_free_bytes = max(MIN_FREE_SPACE_BYTES, min(MAX_FREE_SPACE_BYTES, int(min_free_bytes)))
        self.now = now
        self.id_factory = id_factory or (lambda: uuid4().hex)
        self.archive_writer = archive_writer
        self.verification_hook = verification_hook
        self.lifecycle_hook = lifecycle_hook
        self._lock = threading.RLock()
        self._current_run: dict[str, Any] | None = None
        self._thread: threading.Thread | None = None

    def _destination_configured(self) -> bool:
        return bool(self.root and _safe_server_path(self.root))

    def _destination_available(self) -> bool:
        if not self._destination_configured() or _contains_symlink(self.root):
            return False
        try:
            if self.root.exists():
                return self.root.is_dir()
            return self.root.parent.exists() and self.root.parent.is_dir()
        except OSError:
            return False

    def _safe_run(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._current_run) if self._current_run is not None else None

    def _notify_lifecycle(self, state: str) -> None:
        if self.lifecycle_hook is not None:
            try:
                self.lifecycle_hook(state)
            except Exception:
                # Test-only hooks cannot change the public lifecycle.
                pass

    def _set_state(self, run: dict[str, Any], state: str) -> None:
        with self._lock:
            run["state"] = state
            self._current_run = dict(run)
        self._notify_lifecycle(state)

    def _new_run(self) -> dict[str, Any]:
        started_at = _timestamp(self.now())
        return {
            "schemaVersion": RUN_SCHEMA,
            "backupId": self.id_factory(),
            "profileId": PROFILE_ID,
            "project": PROJECT_ID,
            "environment": ENVIRONMENT_ID,
            "service": SERVICE_ID,
            "state": "preparing",
            "startedAt": started_at,
            "completedAt": None,
            "artifactFilename": None,
            "byteSize": None,
            "verificationStatus": "pending",
            "destinationId": DESTINATION_ID,
            "includedSourceIds": [],
            "missingOptionalSourceIds": [],
            "result": None,
            "errorCode": None,
        }

    def start(self, profile_id: str = PROFILE_ID) -> dict[str, Any]:
        if profile_id != PROFILE_ID:
            raise BackupRequestError("backup_profile_unknown")
        with self._lock:
            if self._current_run is not None and self._current_run.get("state") in ACTIVE_STATES:
                raise BackupRequestError("backup_busy")
            run = self._new_run()
            self._current_run = dict(run)
            worker = threading.Thread(
                target=self._execute,
                args=(run,),
                name="panel-backup-engine",
                daemon=True,
            )
            self._thread = worker
            worker.start()
            return dict(run)

    def run_sync(self, profile_id: str = PROFILE_ID) -> dict[str, Any]:
        if profile_id != PROFILE_ID:
            raise BackupRequestError("backup_profile_unknown")
        with self._lock:
            if self._current_run is not None and self._current_run.get("state") in ACTIVE_STATES:
                raise BackupRequestError("backup_busy")
            run = self._new_run()
            self._current_run = dict(run)
        self._execute(run)
        return self._safe_run() or dict(run)

    def _preflight(self) -> tuple[Path, Path, list[dict[str, Any]]]:
        if not self._destination_configured():
            raise BackupFailure("backup_destination_unavailable")
        _ensure_directory(self.root, create=True)
        try:
            usage = shutil.disk_usage(self.root)
        except OSError:
            raise BackupFailure("backup_destination_unavailable") from None
        if usage.free < self.min_free_bytes:
            raise BackupFailure("backup_insufficient_free_space")
        history_path = self.root / HISTORY_FILENAME
        history_available, entries = _read_history(history_path)
        if not history_available:
            raise BackupFailure("backup_history_unavailable")
        return self.root, history_path, entries

    def _destination_directory(self, now: datetime) -> Path:
        destination = self.root / PROFILE_ID / now.astimezone(timezone.utc).strftime("%Y") / now.astimezone(timezone.utc).strftime("%m")
        try:
            _ensure_directory(destination, create=True)
        except BackupFailure:
            raise BackupFailure("backup_destination_unavailable") from None
        return destination

    def _create_archive(self, target: Path, contents: Sequence[tuple[str, bytes]]) -> None:
        try:
            with target.open("wb") as handle:
                with zipfile.ZipFile(handle, mode="w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
                    for member_name, data in contents:
                        if not _safe_member_name(member_name):
                            raise BackupFailure("backup_archive_failed")
                        archive.writestr(member_name, data)
                handle.flush()
                os.fsync(handle.fileno())
        except BackupFailure:
            raise
        except (OSError, ValueError, zipfile.BadZipFile, RuntimeError):
            raise BackupFailure("backup_archive_failed") from None

    def _verify_archive(
        self,
        archive_path: Path,
        included_source_ids: Sequence[str],
        contents: Sequence[tuple[str, bytes]],
    ) -> tuple[int, str]:
        try:
            if not archive_path.exists() or archive_path.stat().st_size <= 0:
                raise BackupFailure("backup_verification_failed")
            digest = hashlib.sha256()
            with archive_path.open("rb") as handle:
                for block in iter(lambda: handle.read(64 * 1024), b""):
                    digest.update(block)
            expected_members = {member_name for member_name, _ in contents}
            expected_by_name = dict(contents)
            with zipfile.ZipFile(archive_path, mode="r") as archive:
                names = archive.namelist()
                if len(names) != len(set(names)) or any(not _safe_member_name(name) for name in names):
                    raise BackupFailure("backup_verification_failed")
                if set(names) != expected_members:
                    raise BackupFailure("backup_verification_failed")
                if set(included_source_ids) != {
                    item.logical_id
                    for item in PANEL_SOURCE_ITEMS
                    if item.member_name in expected_members
                }:
                    raise BackupFailure("backup_verification_failed")
                for member_name in names:
                    if archive.read(member_name) != expected_by_name[member_name]:
                        raise BackupFailure("backup_verification_failed")
            if self.verification_hook is not None:
                self.verification_hook(archive_path)
            return archive_path.stat().st_size, digest.hexdigest()
        except BackupFailure:
            raise
        except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError):
            raise BackupFailure("backup_verification_failed") from None

    def _source_snapshot(self) -> tuple[list[tuple[str, bytes]], list[str], list[str]]:
        contents: list[tuple[str, bytes]] = []
        included: list[str] = []
        missing: list[str] = []
        for item in PANEL_SOURCE_ITEMS:
            path = self.source.path_for(item.logical_id)
            if not os.path.lexists(os.fspath(path)):
                if item.optional:
                    missing.append(item.logical_id)
                    continue
                raise BackupFailure("backup_source_unavailable")
            data = _read_bounded_source(path, item.max_bytes)
            contents.append((item.member_name, data))
            included.append(item.logical_id)
        return contents, included, missing

    def _manifest(
        self,
        run: Mapping[str, Any],
        *,
        completed_at: str,
        artifact_filename: str,
        byte_size: int,
        sha256: str,
        included: Sequence[str],
        missing: Sequence[str],
    ) -> dict[str, Any]:
        return {
            "schemaVersion": MANIFEST_SCHEMA,
            "backupId": run["backupId"],
            "profileId": PROFILE_ID,
            "project": PROJECT_ID,
            "environment": ENVIRONMENT_ID,
            "service": SERVICE_ID,
            "startedAt": run["startedAt"],
            "completedAt": completed_at,
            "artifactFilename": artifact_filename,
            "byteSize": byte_size,
            "sha256": sha256,
            "archiveFormat": ARCHIVE_FORMAT,
            "includedSourceIds": list(included),
            "missingOptionalSourceIds": list(missing),
            "verificationStatus": "verified",
            "destinationId": DESTINATION_ID,
            "result": "success",
        }

    def _validate_manifest(self, manifest: Mapping[str, Any], archive_filename: str) -> None:
        required = {
            "schemaVersion", "backupId", "profileId", "project", "environment", "service",
            "startedAt", "completedAt", "artifactFilename", "byteSize", "sha256",
            "archiveFormat", "includedSourceIds", "missingOptionalSourceIds",
            "verificationStatus", "destinationId", "result",
        }
        if set(manifest) != required:
            raise BackupFailure("backup_manifest_failed")
        if (
            manifest.get("schemaVersion") != MANIFEST_SCHEMA
            or manifest.get("profileId") != PROFILE_ID
            or manifest.get("project") != PROJECT_ID
            or manifest.get("environment") != ENVIRONMENT_ID
            or manifest.get("service") != SERVICE_ID
            or manifest.get("destinationId") != DESTINATION_ID
            or manifest.get("archiveFormat") != ARCHIVE_FORMAT
            or manifest.get("verificationStatus") != "verified"
            or manifest.get("result") != "success"
            or manifest.get("artifactFilename") != archive_filename
            or not _safe_member_name(str(manifest.get("artifactFilename")))
            or not isinstance(manifest.get("byteSize"), int)
            or manifest.get("byteSize", 0) <= 0
            or not isinstance(manifest.get("sha256"), str)
            or not SHA256_PATTERN.fullmatch(manifest["sha256"])
            or not isinstance(manifest.get("includedSourceIds"), list)
            or not isinstance(manifest.get("missingOptionalSourceIds"), list)
        ):
            raise BackupFailure("backup_manifest_failed")

    def _history_entry(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "backupId": manifest["backupId"],
            "profileId": manifest["profileId"],
            "project": manifest["project"],
            "environment": manifest["environment"],
            "service": manifest["service"],
            "startedAt": manifest["startedAt"],
            "completedAt": manifest["completedAt"],
            "artifactFilename": manifest["artifactFilename"],
            "byteSize": manifest["byteSize"],
            "sha256": manifest["sha256"],
            "archiveFormat": manifest["archiveFormat"],
            "includedSourceIds": list(manifest["includedSourceIds"]),
            "missingOptionalSourceIds": list(manifest["missingOptionalSourceIds"]),
            "verificationStatus": manifest["verificationStatus"],
            "destinationId": manifest["destinationId"],
            "result": manifest["result"],
        }

    def _failed_history_entry(self, run: Mapping[str, Any], completed_at: str, code: str) -> dict[str, Any]:
        return {
            "backupId": run["backupId"],
            "profileId": PROFILE_ID,
            "project": PROJECT_ID,
            "environment": ENVIRONMENT_ID,
            "service": SERVICE_ID,
            "startedAt": run["startedAt"],
            "completedAt": completed_at,
            "artifactFilename": None,
            "byteSize": None,
            "sha256": None,
            "archiveFormat": ARCHIVE_FORMAT,
            "includedSourceIds": list(run.get("includedSourceIds", [])),
            "missingOptionalSourceIds": list(run.get("missingOptionalSourceIds", [])),
            "verificationStatus": "failed",
            "destinationId": DESTINATION_ID,
            "result": "failed",
            "errorCode": code,
        }

    def _finish_failure(
        self,
        run: dict[str, Any],
        code: str,
        *,
        history_path: Path | None,
        history_entries: Sequence[Mapping[str, Any]] | None,
    ) -> None:
        completed_at = _timestamp(self.now())
        run.update({
            "state": "failed",
            "completedAt": completed_at,
            "verificationStatus": "failed",
            "result": "failed",
            "errorCode": code,
        })
        if history_path is not None and history_entries is not None:
            try:
                failure = self._failed_history_entry(run, completed_at, code)
                _atomic_json_write(
                    history_path,
                    _history_document([failure, *history_entries]),
                    MAX_HISTORY_BYTES,
                    "backup_history_write_failed",
                )
            except BackupFailure:
                # The original bounded failure remains the public result.  A
                # history write failure must never expose a raw filesystem
                # error or overwrite a known corrupt history file.
                pass
        with self._lock:
            self._current_run = dict(run)
        self._notify_lifecycle("failed")

    def _execute(self, run: dict[str, Any]) -> None:
        temporary_archive: Path | None = None
        published_archive: Path | None = None
        manifest_path: Path | None = None
        history_path: Path | None = None
        history_entries: list[dict[str, Any]] | None = None
        try:
            self._set_state(run, "preparing")
            _, history_path, history_entries = self._preflight()
            now = self.now()
            destination = self._destination_directory(now)
            timestamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_id = str(run["backupId"])
            archive_filename = f"{PROFILE_ID}-{timestamp}-{backup_id}.zip"
            published_archive = destination / archive_filename
            manifest_path = destination / f"{PROFILE_ID}-{timestamp}-{backup_id}.manifest.json"
            if published_archive.exists() or manifest_path.exists():
                raise BackupFailure("backup_artifact_collision")

            self._set_state(run, "exporting")
            contents, included, missing = self._source_snapshot()
            run["includedSourceIds"] = list(included)
            run["missingOptionalSourceIds"] = list(missing)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{PROFILE_ID}-{backup_id}.",
                suffix=".partial",
                dir=destination,
                delete=False,
            ) as handle:
                temporary_archive = Path(handle.name)
            if self.archive_writer is None:
                self._create_archive(temporary_archive, contents)
            else:
                self.archive_writer(temporary_archive, contents)
            if not temporary_archive.exists():
                raise BackupFailure("backup_archive_failed")

            self._set_state(run, "verifying")
            byte_size, sha256 = self._verify_archive(temporary_archive, included, contents)
            os.replace(temporary_archive, published_archive)
            temporary_archive = None
            _fsync_directory(destination)
            # Re-run the bounded checks against the atomically published
            # artifact.  A successful temp verification alone is not enough
            # to publish a success result.
            byte_size, sha256 = self._verify_archive(published_archive, included, contents)

            completed_at = _timestamp(self.now())
            manifest = self._manifest(
                run,
                completed_at=completed_at,
                artifact_filename=archive_filename,
                byte_size=byte_size,
                sha256=sha256,
                included=included,
                missing=missing,
            )
            _atomic_json_write(manifest_path, manifest, MAX_MANIFEST_BYTES, "backup_manifest_failed")
            try:
                loaded_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, TypeError, ValueError, json.JSONDecodeError):
                raise BackupFailure("backup_manifest_failed") from None
            if not isinstance(loaded_manifest, dict):
                raise BackupFailure("backup_manifest_failed")
            self._validate_manifest(loaded_manifest, archive_filename)

            history_entry = self._history_entry(loaded_manifest)
            _atomic_json_write(
                history_path,
                _history_document([history_entry, *history_entries]),
                MAX_HISTORY_BYTES,
                "backup_history_write_failed",
            )
            run.update({
                "state": "success",
                "completedAt": completed_at,
                "artifactFilename": archive_filename,
                "byteSize": byte_size,
                "verificationStatus": "verified",
                "result": "success",
                "errorCode": None,
            })
            with self._lock:
                self._current_run = dict(run)
            self._notify_lifecycle("success")
        except BackupFailure as failure:
            _safe_unlink(temporary_archive)
            _safe_unlink(published_archive)
            _safe_unlink(manifest_path)
            self._finish_failure(
                run,
                failure.code,
                history_path=history_path,
                history_entries=history_entries,
            )
        except (OSError, ValueError, TypeError, RuntimeError, zipfile.BadZipFile):
            _safe_unlink(temporary_archive)
            _safe_unlink(published_archive)
            _safe_unlink(manifest_path)
            self._finish_failure(
                run,
                "backup_failed",
                history_path=history_path,
                history_entries=history_entries,
            )
        except Exception:
            # Keep the API bounded even if a platform primitive raises an
            # unexpected exception.  The artifact is still best-effort
            # cleaned up and never recorded as successful.
            _safe_unlink(temporary_archive)
            _safe_unlink(published_archive)
            _safe_unlink(manifest_path)
            self._finish_failure(
                run,
                "backup_failed",
                history_path=history_path,
                history_entries=history_entries,
            )

    def api_payload(self) -> dict[str, Any]:
        configured = self._destination_configured()
        available = self._destination_available()
        history_available = False
        history_entries: list[dict[str, Any]] = []
        history_error: str | None = None
        if configured and available:
            history_available, history_entries = _read_history(self.root / HISTORY_FILENAME)
            if not history_available:
                history_error = "backup_history_unavailable"
        elif not configured:
            history_error = "backup_destination_unavailable"
        else:
            history_error = "backup_destination_unavailable"
        return {
            "schemaVersion": API_SCHEMA,
            "profiles": [_profile_inventory(available, configured)],
            "currentRun": self._safe_run(),
            "history": {
                "schemaVersion": HISTORY_SCHEMA,
                "available": history_available,
                "entries": history_entries if history_available else [],
                "errorCode": history_error,
            },
        }


def _error_status(code: str) -> int:
    if code == "backup_profile_unknown":
        return status.HTTP_404_NOT_FOUND
    if code == "backup_busy":
        return status.HTTP_409_CONFLICT
    if code in {"backup_destination_unavailable", "backup_history_unavailable"}:
        return status.HTTP_503_SERVICE_UNAVAILABLE
    return status.HTTP_409_CONFLICT


def build_backup_router(engine: BackupEngine, access_policy: AccessPolicyStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1/backups", tags=["backups"])

    @router.get("")
    def get_backups(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return engine.api_payload()

    @router.post("/{profile_id}/runs", status_code=status.HTTP_202_ACCEPTED)
    def start_backup(profile_id: str, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        try:
            access_policy.require("backup.create")
        except HTTPException as exc:
            access_policy.audit_capability("backup.create", result=f"http_{exc.status_code}")
            raise
        try:
            run = engine.start(profile_id)
        except BackupRequestError as exc:
            access_policy.audit_capability("backup.create", result=exc.code)
            raise HTTPException(status_code=_error_status(exc.code), detail=exc.code) from None
        access_policy.audit_capability("backup.create", result="accepted")
        return {"schemaVersion": API_SCHEMA, "run": run}

    return router
