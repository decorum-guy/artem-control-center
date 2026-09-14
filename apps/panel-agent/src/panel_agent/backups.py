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
import subprocess
import tempfile
import threading
import time
import tarfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol, Sequence
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
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_B2A_TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

AVALAR_STAGE_PROFILE_ID = "avalar-stage-site"
AVALAR_STAGE_PROJECT_ID = "avalar-site"
AVALAR_STAGE_ENVIRONMENT_ID = "stage"
AVALAR_STAGE_SERVICE_ID = "website"
AVALAR_STAGE_ARCHIVE_FORMAT = "tar.gz"
AVALAR_TRANSPORT_SCHEMA = "avalar.stage.backup.transport.v1"
AVALAR_MANIFEST_SCHEMA = "avalar.stage.backup.v1"
AVALAR_HELPER_CONTRACT = "avalar.stage.backup.v1"
AVALAR_BACKUP_OPERATION = "backup-stage"
MAX_AVALAR_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_AVALAR_METADATA_BYTES = 16 * 1024
MAX_AVALAR_ARCHIVE_TEXT_BYTES = 256 * 1024


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
    "backup_remote_disabled",
    "backup_remote_busy",
    "backup_remote_timeout",
    "backup_remote_failed",
    "backup_transport_invalid",
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
    stage_keys = required_keys | {"sourceCommit", "helperSha256"}
    accepted = (
        required_keys,
        required_keys | {"errorCode"},
        stage_keys,
        stage_keys | {"errorCode"},
    )
    if set(entry) not in accepted:
        return False
    profile_id = entry.get("profileId")
    if profile_id not in {PROFILE_ID, AVALAR_STAGE_PROFILE_ID} or entry.get("destinationId") != DESTINATION_ID:
        return False
    if profile_id == AVALAR_STAGE_PROFILE_ID:
        if (
            entry.get("project") != AVALAR_STAGE_PROJECT_ID
            or entry.get("environment") != AVALAR_STAGE_ENVIRONMENT_ID
            or entry.get("service") != AVALAR_STAGE_SERVICE_ID
            or entry.get("archiveFormat") != AVALAR_STAGE_ARCHIVE_FORMAT
            or entry.get("destinationId") != DESTINATION_ID
            or entry.get("includedSourceIds") != []
            or entry.get("missingOptionalSourceIds") != []
        ):
            return False
    elif profile_id == PROFILE_ID:
        if "sourceCommit" in entry or "helperSha256" in entry:
            return False
    if (
        not isinstance(entry.get("startedAt"), str)
        or not isinstance(entry.get("completedAt"), str)
        or not isinstance(entry.get("includedSourceIds"), list)
        or not isinstance(entry.get("missingOptionalSourceIds"), list)
    ):
        return False
    if profile_id == PROFILE_ID and (
        entry.get("project") != PROJECT_ID
        or entry.get("environment") != ENVIRONMENT_ID
        or entry.get("service") != SERVICE_ID
        or entry.get("archiveFormat") != ARCHIVE_FORMAT
        or not set(entry["includedSourceIds"]).issubset(PANEL_SOURCE_ID_SET)
        or not set(entry["missingOptionalSourceIds"]).issubset(PANEL_SOURCE_ID_SET)
        or set(entry["includedSourceIds"]) & set(entry["missingOptionalSourceIds"])
    ):
        return False
    if profile_id == AVALAR_STAGE_PROFILE_ID and (entry["includedSourceIds"] or entry["missingOptionalSourceIds"]):
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
    if profile_id == AVALAR_STAGE_PROFILE_ID and entry["result"] == "failed":
        if entry.get("sourceCommit") is not None or entry.get("helperSha256") is not None:
            return False
    if profile_id == AVALAR_STAGE_PROFILE_ID and entry["result"] == "success":
        if (
            not isinstance(entry.get("sourceCommit"), str)
            or not _COMMIT_PATTERN.fullmatch(entry["sourceCommit"])
            or not isinstance(entry.get("helperSha256"), str)
            or not SHA256_PATTERN.fullmatch(entry["helperSha256"])
        ):
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
        "registered": True,
        "executable": True,
        "runtimeEnabled": True,
        "sourceItemCount": len(PANEL_SOURCE_ITEMS),
        "destinationConfigured": destination_configured,
        "available": destination_available,
    }


@dataclass(frozen=True)
class BackupProfileRegistration:
    """Server-owned identity and executability state for one backup profile."""

    id: str
    project: str
    environment: str
    service: str
    registered: bool = True
    executable: bool = True


class BackupProfileCatalog:
    """Small explicit catalog; it contains no request-controlled handlers."""

    def __init__(self, profiles: Sequence[BackupProfileRegistration]) -> None:
        by_id: dict[str, BackupProfileRegistration] = {}
        for profile in profiles:
            if profile.id in by_id:
                raise ValueError("duplicate backup profile registration")
            if profile.executable and not profile.registered:
                raise ValueError("executable backup profile must be registered")
            by_id[profile.id] = profile
        self._profiles = by_id

    def get(self, profile_id: str) -> BackupProfileRegistration | None:
        return self._profiles.get(profile_id)

    def resolve(self, profile_id: str) -> BackupProfileRegistration | None:
        """Resolve only server-registered metadata; never project config."""

        return self.get(profile_id)

    def is_registered(self, profile_id: str) -> bool:
        profile = self.get(profile_id)
        return profile is not None and profile.registered

    def is_executable(self, profile_id: str) -> bool:
        profile = self.get(profile_id)
        return profile is not None and profile.registered and profile.executable


# This is deliberately an explicit server-owned list.  The Project Registry
# may declare additional opaque IDs, but those declarations do not add catalog
# entries or execution paths.
BACKUP_PROFILE_CATALOG = BackupProfileCatalog(
    (
        BackupProfileRegistration(
            id=PROFILE_ID,
            project=PROJECT_ID,
            environment=ENVIRONMENT_ID,
            service=SERVICE_ID,
        ),
        BackupProfileRegistration(
            id=AVALAR_STAGE_PROFILE_ID,
            project=AVALAR_STAGE_PROJECT_ID,
            environment=AVALAR_STAGE_ENVIRONMENT_ID,
            service=AVALAR_STAGE_SERVICE_ID,
        ),
    )
)


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


class BackupExecutor(Protocol):
    def start(self, profile_id: str) -> dict[str, Any]: ...
    def run_sync(self, profile_id: str) -> dict[str, Any]: ...
    def inventory(self) -> dict[str, Any]: ...


def _stage_inventory(*, enabled: bool, configured: bool, available: bool) -> dict[str, Any]:
    return {
        "id": AVALAR_STAGE_PROFILE_ID,
        "name": "AVALAR Stage",
        "project": AVALAR_STAGE_PROJECT_ID,
        "environment": AVALAR_STAGE_ENVIRONMENT_ID,
        "service": AVALAR_STAGE_SERVICE_ID,
        "destinationId": DESTINATION_ID,
        "archiveFormat": AVALAR_STAGE_ARCHIVE_FORMAT,
        "registered": True,
        "executable": True,
        "runtimeEnabled": enabled,
        "destinationConfigured": configured,
        "available": available,
    }


def _parse_sha256_inventory(payload: bytes) -> dict[str, str]:
    """Parse GNU sha256sum output without depending on a Unix utility."""
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        raise BackupFailure("backup_verification_failed") from None
    if not lines:
        raise BackupFailure("backup_verification_failed")
    result: dict[str, str] = {}
    for line in lines:
        escaped = line.startswith("\\")
        offset = 1 if escaped else 0
        if len(line) < offset + 66 or not SHA256_PATTERN.fullmatch(line[offset:offset + 64]):
            raise BackupFailure("backup_verification_failed")
        if line[offset + 64] != " " or line[offset + 65] not in {" ", "*"}:
            raise BackupFailure("backup_verification_failed")
        name = line[offset + 66:]
        if not name:
            raise BackupFailure("backup_verification_failed")
        if escaped:
            decoded: list[str] = []
            index = 0
            while index < len(name):
                if name[index] != "\\":
                    decoded.append(name[index])
                    index += 1
                    continue
                if index + 1 >= len(name) or name[index + 1] not in {"\\", "n"}:
                    raise BackupFailure("backup_verification_failed")
                if name[index + 1] == "n":
                    raise BackupFailure("backup_verification_failed")
                decoded.append("\\")
                index += 2
            name = "".join(decoded)
        if not _safe_checksum_path(name) or name in result:
            raise BackupFailure("backup_verification_failed")
        result[name] = line[offset:offset + 64]
    return result


def _safe_tar_member_name(name: str) -> bool:
    if not isinstance(name, str) or not name or "\x00" in name:
        return False
    if name.startswith("/"):
        return False
    trimmed = name[:-1] if name.endswith("/") else name
    return bool(trimmed) and all(part not in {"", ".", ".."} for part in trimmed.split("/"))


def _safe_checksum_path(name: str) -> bool:
    """Inventory format can represent a literal backslash; archive names cannot."""
    if not isinstance(name, str) or not name or "\x00" in name or name.startswith("/"):
        return False
    return all(part not in {"", ".", ".."} for part in name.split("/"))


class AvalarStageBackupEngine:
    """Fixed, binary-safe consumer for the accepted AVALAR Stage transport."""

    def __init__(
        self,
        root: str | Path,
        *,
        enabled: bool,
        ssh_host: str,
        ssh_command: str,
        timeout_seconds: int,
        min_free_bytes: int,
        now: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], str] | None = None,
        popen_factory: Callable[..., Any] = subprocess.Popen,
        verification_hook: Callable[[Path], None] | None = None,
        json_writer: Callable[[Path, Mapping[str, Any], int, str], None] = _atomic_json_write,
    ) -> None:
        self.root = Path(root) if root else Path("")
        self.enabled = enabled
        self.ssh_host = ssh_host
        self.ssh_command = ssh_command
        self.timeout_seconds = max(10, min(300, int(timeout_seconds)))
        self.min_free_bytes = max(MIN_FREE_SPACE_BYTES, min(MAX_FREE_SPACE_BYTES, int(min_free_bytes)))
        self.now, self.id_factory, self.popen_factory = now, id_factory or (lambda: uuid4().hex), popen_factory
        self.verification_hook, self.json_writer = verification_hook, json_writer

    def _configured(self) -> bool:
        return bool(self.root and _safe_server_path(self.root))

    def available(self) -> bool:
        if not self.enabled or not self._configured() or not self.ssh_host or not self.ssh_command:
            return False
        try:
            return self.root.exists() and self.root.is_dir() or (not self.root.exists() and self.root.parent.is_dir())
        except OSError:
            return False

    def inventory(self) -> dict[str, Any]:
        return _stage_inventory(enabled=self.enabled, configured=self._configured(), available=self.available())

    def start(self, profile_id: str = AVALAR_STAGE_PROFILE_ID) -> dict[str, Any]:
        if profile_id != AVALAR_STAGE_PROFILE_ID:
            raise BackupRequestError("backup_profile_unknown")
        raise BackupRequestError("backup_failed")

    def _new_run(self) -> dict[str, Any]:
        return {"schemaVersion": RUN_SCHEMA, "backupId": self.id_factory(), "profileId": AVALAR_STAGE_PROFILE_ID,
                "project": AVALAR_STAGE_PROJECT_ID, "environment": AVALAR_STAGE_ENVIRONMENT_ID, "service": AVALAR_STAGE_SERVICE_ID,
                "state": "preparing", "startedAt": _timestamp(self.now()), "completedAt": None, "artifactFilename": None,
                "byteSize": None, "verificationStatus": "pending", "destinationId": DESTINATION_ID, "includedSourceIds": [],
                "missingOptionalSourceIds": [], "result": None, "errorCode": None, "sha256": None, "sourceCommit": None, "helperSha256": None}

    def _stream_remote(self, partial: Path) -> dict[str, Any]:
        argv = ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={min(30, self.timeout_seconds)}", self.ssh_host, self.ssh_command, AVALAR_BACKUP_OPERATION]
        try:
            process = self.popen_factory(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
        except OSError:
            raise BackupFailure("backup_remote_failed") from None
        stderr = bytearray()
        overflow = threading.Event()
        stdout_done = threading.Event()
        stdout_error: list[BackupFailure] = []
        byte_count = [0]
        def read_stderr() -> None:
            stream = process.stderr
            if stream is None:
                return
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                if len(stderr) + len(chunk) > MAX_AVALAR_METADATA_BYTES:
                    overflow.set()
                    continue
                if not overflow.is_set():
                    stderr.extend(chunk)
        reader = threading.Thread(target=read_stderr, name="avalar-backup-stderr", daemon=True)
        reader.start()
        output_reader: threading.Thread | None = None
        deadline = time.monotonic() + self.timeout_seconds
        try:
            with partial.open("wb") as handle:
                stream = process.stdout
                if stream is None:
                    raise BackupFailure("backup_remote_failed")
                def read_stdout() -> None:
                    try:
                        while True:
                            chunk = stream.read(64 * 1024)
                            if not chunk:
                                return
                            byte_count[0] += len(chunk)
                            if byte_count[0] > MAX_AVALAR_ARCHIVE_BYTES:
                                stdout_error.append(BackupFailure("backup_transport_invalid"))
                                return
                            handle.write(chunk)
                    except (OSError, ValueError):
                        stdout_error.append(BackupFailure("backup_remote_failed"))
                    finally:
                        stdout_done.set()
                output_reader = threading.Thread(target=read_stdout, name="avalar-backup-stdout", daemon=True)
                output_reader.start()
                while not stdout_done.wait(timeout=0.05):
                    if overflow.is_set() or stdout_error:
                        raise BackupFailure("backup_transport_invalid")
                    if time.monotonic() > deadline:
                        raise BackupFailure("backup_remote_timeout")
                if overflow.is_set() or stdout_error:
                    raise stdout_error[0] if stdout_error else BackupFailure("backup_transport_invalid")
                handle.flush()
                os.fsync(handle.fileno())
            remaining = max(0.1, deadline - time.monotonic())
            try:
                returncode = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise BackupFailure("backup_remote_timeout") from None
            reader.join(timeout=1)
            if overflow.is_set():
                raise BackupFailure("backup_transport_invalid")
            if returncode != 0:
                raise BackupFailure({77: "backup_remote_disabled", 75: "backup_remote_busy", 124: "backup_remote_timeout"}.get(returncode, "backup_remote_failed"))
            try:
                metadata = json.loads(bytes(stderr).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise BackupFailure("backup_transport_invalid") from None
            if not isinstance(metadata, dict) or b"\r" in stderr or bytes(stderr).count(b"\n") > 1:
                raise BackupFailure("backup_transport_invalid")
            required = {"ok", "schemaVersion", "profileId", "helperContract", "byteSize", "sha256", "sourceCommit", "helperSha256"}
            if set(metadata) != required or metadata.get("ok") is not True or metadata.get("schemaVersion") != AVALAR_TRANSPORT_SCHEMA or metadata.get("profileId") != AVALAR_STAGE_PROFILE_ID or metadata.get("helperContract") != AVALAR_HELPER_CONTRACT:
                raise BackupFailure("backup_transport_invalid")
            if not isinstance(metadata.get("byteSize"), int) or metadata["byteSize"] <= 0 or not isinstance(metadata.get("sha256"), str) or not SHA256_PATTERN.fullmatch(metadata["sha256"]) or not isinstance(metadata.get("sourceCommit"), str) or not _COMMIT_PATTERN.fullmatch(metadata["sourceCommit"]) or not isinstance(metadata.get("helperSha256"), str) or not SHA256_PATTERN.fullmatch(metadata["helperSha256"]):
                raise BackupFailure("backup_transport_invalid")
            if byte_count[0] != metadata["byteSize"] or byte_count[0] == 0:
                raise BackupFailure("backup_transport_invalid")
            return metadata
        except BackupFailure:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            raise
        finally:
            reader.join(timeout=1)
            if output_reader is not None:
                output_reader.join(timeout=1)

    def _verify_archive(self, archive_path: Path, metadata: Mapping[str, Any]) -> tuple[int, str]:
        digest = hashlib.sha256()
        with archive_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(64 * 1024), b""):
                digest.update(chunk)
        size, sha256 = archive_path.stat().st_size, digest.hexdigest()
        if size != metadata["byteSize"] or sha256 != metadata["sha256"]:
            raise BackupFailure("backup_transport_invalid")
        try:
            with tarfile.open(archive_path, "r:gz") as archive:
                members = archive.getmembers()
                regular: dict[str, tarfile.TarInfo] = {}
                directory_identities: set[str] = set()
                member_names: set[str] = set()
                for member in members:
                    if not _safe_tar_member_name(member.name) or (member.isreg() and member.name.endswith("/")):
                        raise BackupFailure("backup_verification_failed")
                    canonical_name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
                    if member.name in member_names:
                        raise BackupFailure("backup_verification_failed")
                    member_names.add(member.name)
                    allowed = canonical_name in {"backup.manifest.json", "source-files.sha256", "data.json", "uploads"} or canonical_name.startswith("uploads/")
                    if not allowed or member.issym() or member.islnk() or member.isdev() or member.isfifo() or not (member.isdir() or member.isreg()):
                        raise BackupFailure("backup_verification_failed")
                    if member.isdir() and canonical_name != "uploads" and not canonical_name.startswith("uploads/"):
                        raise BackupFailure("backup_verification_failed")
                    if member.isdir():
                        if canonical_name in directory_identities:
                            raise BackupFailure("backup_verification_failed")
                        directory_identities.add(canonical_name)
                    if member.isreg():
                        if canonical_name in regular:
                            raise BackupFailure("backup_verification_failed")
                        regular[canonical_name] = member
                if {"backup.manifest.json", "source-files.sha256", "data.json"} - set(regular):
                    raise BackupFailure("backup_verification_failed")
                if "uploads" not in directory_identities:
                    raise BackupFailure("backup_verification_failed")
                def read_member(name: str) -> bytes:
                    extracted = archive.extractfile(regular[name])
                    if extracted is None:
                        raise BackupFailure("backup_verification_failed")
                    data = extracted.read(MAX_AVALAR_ARCHIVE_TEXT_BYTES + 1)
                    if len(data) > MAX_AVALAR_ARCHIVE_TEXT_BYTES:
                        raise BackupFailure("backup_verification_failed")
                    return data
                try:
                    manifest = json.loads(read_member("backup.manifest.json").decode("utf-8"))
                    json.loads(read_member("data.json").decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise BackupFailure("backup_verification_failed") from None
                expected = {"schemaVersion": AVALAR_MANIFEST_SCHEMA, "profileId": AVALAR_STAGE_PROFILE_ID, "project": AVALAR_STAGE_PROJECT_ID, "environment": AVALAR_STAGE_ENVIRONMENT_ID, "service": AVALAR_STAGE_SERVICE_ID, "sourceBranch": "stage", "sourceCommit": metadata["sourceCommit"], "helperContract": AVALAR_HELPER_CONTRACT, "helperSha256": metadata["helperSha256"], "includedScopes": ["data.json", "uploads"], "excludedScopes": ["git", "legacy-backups", "secrets", "external-config", "control-center-state"]}
                required_manifest_keys = set(expected) | {"createdAt"}
                if (
                    not isinstance(manifest, dict)
                    or set(manifest) != required_manifest_keys
                    or any(manifest.get(key) != value for key, value in expected.items())
                    or not isinstance(manifest.get("createdAt"), str)
                    or not _B2A_TIMESTAMP_PATTERN.fullmatch(manifest["createdAt"])
                ):
                    raise BackupFailure("backup_verification_failed")
                inventory = _parse_sha256_inventory(read_member("source-files.sha256"))
                payload_files = {name for name in regular if name == "data.json" or name.startswith("uploads/")}
                if set(inventory) != payload_files:
                    raise BackupFailure("backup_verification_failed")
                for name, expected_sha in inventory.items():
                    item = archive.extractfile(regular[name])
                    if item is None:
                        raise BackupFailure("backup_verification_failed")
                    payload_digest = hashlib.sha256()
                    for chunk in iter(lambda: item.read(64 * 1024), b""):
                        payload_digest.update(chunk)
                    if payload_digest.hexdigest() != expected_sha:
                        raise BackupFailure("backup_verification_failed")
        except BackupFailure:
            raise
        except (OSError, tarfile.TarError):
            raise BackupFailure("backup_verification_failed") from None
        if self.verification_hook is not None:
            self.verification_hook(archive_path)
        return size, sha256

    def _failed_history_entry(self, run: Mapping[str, Any], code: str) -> dict[str, Any]:
        return {
            "backupId": run["backupId"], "profileId": AVALAR_STAGE_PROFILE_ID,
            "project": AVALAR_STAGE_PROJECT_ID, "environment": AVALAR_STAGE_ENVIRONMENT_ID,
            "service": AVALAR_STAGE_SERVICE_ID, "startedAt": run["startedAt"],
            "completedAt": run["completedAt"], "artifactFilename": None, "byteSize": None,
            "sha256": None, "archiveFormat": AVALAR_STAGE_ARCHIVE_FORMAT,
            "includedSourceIds": [], "missingOptionalSourceIds": [],
            "verificationStatus": "failed", "destinationId": DESTINATION_ID,
            "result": "failed", "errorCode": code, "sourceCommit": None,
            "helperSha256": None,
        }

    def run_sync(
        self,
        profile_id: str = AVALAR_STAGE_PROFILE_ID,
        *,
        run: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if profile_id != AVALAR_STAGE_PROFILE_ID:
            raise BackupRequestError("backup_profile_unknown")
        run = run or self._new_run()
        if run.get("profileId") != AVALAR_STAGE_PROFILE_ID or not isinstance(run.get("backupId"), str):
            raise BackupRequestError("backup_profile_unknown")
        partial = final = local_manifest = None
        history_path: Path | None = None
        entries: list[dict[str, Any]] | None = None
        try:
            if not self.enabled:
                raise BackupFailure("backup_remote_disabled")
            if not self._configured():
                raise BackupFailure("backup_destination_unavailable")
            _ensure_directory(self.root, create=True)
            if shutil.disk_usage(self.root).free < self.min_free_bytes:
                raise BackupFailure("backup_insufficient_free_space")
            history_path = self.root / HISTORY_FILENAME
            ok, entries = _read_history(history_path)
            if not ok:
                entries = None
                raise BackupFailure("backup_history_unavailable")
            now = self.now(); destination = self.root / AVALAR_STAGE_PROFILE_ID / now.strftime("%Y") / now.strftime("%m")
            _ensure_directory(destination, create=True)
            token = f"{now.strftime('%Y%m%dT%H%M%SZ')}-{run['backupId']}"
            filename = f"{AVALAR_STAGE_PROFILE_ID}-{token}.tar.gz"; final = destination / filename; local_manifest = destination / f"{AVALAR_STAGE_PROFILE_ID}-{token}.manifest.json"
            if final.exists() or local_manifest.exists(): raise BackupFailure("backup_artifact_collision")
            partial = destination / f".{filename}.partial"; run["state"] = "exporting"
            metadata = self._stream_remote(partial); run["state"] = "verifying"
            size, sha256 = self._verify_archive(partial, metadata)
            os.replace(partial, final); partial = None; _fsync_directory(destination)
            size, sha256 = self._verify_archive(final, metadata)
            completed = _timestamp(self.now())
            manifest = {"schemaVersion": MANIFEST_SCHEMA, "backupId": run["backupId"], "profileId": AVALAR_STAGE_PROFILE_ID, "project": AVALAR_STAGE_PROJECT_ID, "environment": AVALAR_STAGE_ENVIRONMENT_ID, "service": AVALAR_STAGE_SERVICE_ID, "startedAt": run["startedAt"], "completedAt": completed, "artifactFilename": filename, "byteSize": size, "sha256": sha256, "archiveFormat": AVALAR_STAGE_ARCHIVE_FORMAT, "includedSourceIds": [], "missingOptionalSourceIds": [], "verificationStatus": "verified", "destinationId": DESTINATION_ID, "result": "success", "sourceCommit": metadata["sourceCommit"], "helperSha256": metadata["helperSha256"]}
            self.json_writer(local_manifest, manifest, MAX_MANIFEST_BYTES, "backup_manifest_failed")
            history_entry = {key: value for key, value in manifest.items() if key != "schemaVersion"}
            self.json_writer(history_path, _history_document([history_entry, *entries]), MAX_HISTORY_BYTES, "backup_history_write_failed")
            run.update({"state": "success", "completedAt": completed, "artifactFilename": filename, "byteSize": size, "sha256": sha256, "verificationStatus": "verified", "result": "success", "sourceCommit": metadata["sourceCommit"], "helperSha256": metadata["helperSha256"]})
        except BackupFailure as failure:
            _safe_unlink(partial); _safe_unlink(final); _safe_unlink(local_manifest)
            run.update({"state": "failed", "completedAt": _timestamp(self.now()), "verificationStatus": "failed", "result": "failed", "errorCode": failure.code})
            if history_path is not None and entries is not None:
                try:
                    self.json_writer(
                        history_path,
                        _history_document([self._failed_history_entry(run, failure.code), *entries]),
                        MAX_HISTORY_BYTES,
                        "backup_history_write_failed",
                    )
                except BackupFailure:
                    pass
        except Exception:
            _safe_unlink(partial); _safe_unlink(final); _safe_unlink(local_manifest)
            run.update({"state": "failed", "completedAt": _timestamp(self.now()), "verificationStatus": "failed", "result": "failed", "errorCode": "backup_failed"})
            if history_path is not None and entries is not None:
                try:
                    self.json_writer(
                        history_path,
                        _history_document([self._failed_history_entry(run, "backup_failed"), *entries]),
                        MAX_HISTORY_BYTES,
                        "backup_history_write_failed",
                    )
                except BackupFailure:
                    pass
        return run


class BackupService:
    """Explicit profile dispatch with one process-wide active backup."""
    def __init__(self, panel: BackupEngine, stage: AvalarStageBackupEngine) -> None:
        self.panel, self.stage = panel, stage
        self._lock = threading.Lock(); self._current: dict[str, Any] | None = None; self._thread: threading.Thread | None = None
    def _engine(self, profile_id: str) -> BackupEngine | AvalarStageBackupEngine:
        if profile_id == PROFILE_ID: return self.panel
        if profile_id == AVALAR_STAGE_PROFILE_ID: return self.stage
        raise BackupRequestError("backup_profile_unknown")
    def run_sync(self, profile_id: str) -> dict[str, Any]:
        engine = self._engine(profile_id)
        with self._lock:
            if self._current and self._current.get("state") in ACTIVE_STATES: raise BackupRequestError("backup_busy")
            self._current = {"state": "preparing", "profileId": profile_id}
        result = engine.run_sync(profile_id)
        with self._lock: self._current = dict(result)
        return result
    def start(self, profile_id: str) -> dict[str, Any]:
        engine = self._engine(profile_id)
        with self._lock:
            if self._current and self._current.get("state") in ACTIVE_STATES: raise BackupRequestError("backup_busy")
            if profile_id == PROFILE_ID:
                run = engine.start(profile_id)
                self._current = dict(run)
                def join_panel() -> None:
                    if self.panel._thread: self.panel._thread.join()
                    with self._lock: self._current = self.panel._safe_run()
                self._thread = threading.Thread(target=join_panel, daemon=True); self._thread.start(); return run
            run = self.stage._new_run()
            self._current = dict(run)
            def worker() -> None:
                result = self.stage.run_sync(profile_id, run=run)
                with self._lock: self._current = result
            self._thread = threading.Thread(target=worker, name="avalar-stage-backup", daemon=True)
            self._thread.start()
            return dict(run)
    def available(self, profile_id: str) -> bool:
        return profile_id == PROFILE_ID or (profile_id == AVALAR_STAGE_PROFILE_ID and self.stage.available())
    def api_payload(self) -> dict[str, Any]:
        base = self.panel.api_payload()
        base["profiles"] = [*base["profiles"], self.stage.inventory()]
        with self._lock: base["currentRun"] = dict(self._current) if self._current else None
        return base


def _error_status(code: str) -> int:
    if code == "backup_profile_unknown":
        return status.HTTP_404_NOT_FOUND
    if code == "backup_busy":
        return status.HTTP_409_CONFLICT
    if code in {"backup_destination_unavailable", "backup_history_unavailable"}:
        return status.HTTP_503_SERVICE_UNAVAILABLE
    return status.HTTP_409_CONFLICT


def build_backup_router(
    engine: BackupEngine,
    access_policy: AccessPolicyStore,
    profile_catalog: BackupProfileCatalog = BACKUP_PROFILE_CATALOG,
) -> APIRouter:
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
        if not profile_catalog.is_executable(profile_id):
            access_policy.audit_capability("backup.create", result="backup_profile_unknown")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="backup_profile_unknown",
            )
        try:
            run = engine.start(profile_id)
        except BackupRequestError as exc:
            access_policy.audit_capability("backup.create", result=exc.code)
            raise HTTPException(status_code=_error_status(exc.code), detail=exc.code) from None
        access_policy.audit_capability("backup.create", result="accepted")
        return {"schemaVersion": API_SCHEMA, "run": run}

    return router
