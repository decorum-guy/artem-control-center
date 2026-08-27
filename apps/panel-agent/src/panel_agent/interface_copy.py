"""Typed, Panel-owned presentation copy settings.

The checked-in catalog is the only source of shipped defaults.  Stored data
contains only explicit overrides for that closed catalog; it cannot introduce
routes, actions, capabilities, providers, paths, or renderable markup.
"""

from __future__ import annotations

import json
import os
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Mapping

from .contracts import (
    InterfaceCopyCatalog,
    InterfaceCopyField,
    InterfaceCopyOverrides,
    InterfaceCopyPatch,
    InterfaceCopySettingsResponse,
)

SCHEMA_VERSION = "interface.copy-settings.v1"
MAX_FILE_BYTES = 64 * 1024
FIXTURE_INTERFACE_COPY_SCENARIOS = (
    "defaults-only",
    "custom-navigation",
    "custom-page-copy",
    "removed-subtitle",
    "revision-conflict",
    "malformed",
    "unsupported",
    "oversized",
    "unavailable",
)

_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_CATALOG_PATH = _REPOSITORY_ROOT / "packages" / "config" / "interface-copy-catalog.json"
with _CATALOG_PATH.open("r", encoding="utf-8") as _catalog_file:
    DEFAULT_CATALOG = InterfaceCopyCatalog.model_validate(json.load(_catalog_file))

_FIELDS: tuple[InterfaceCopyField, ...] = (
    "navigation.overview",
    "navigation.weather",
    "navigation.home",
    "navigation.services",
    "navigation.calendar",
    "navigation.tasks",
    "navigation.reminders",
    "navigation.backups",
    "navigation.apps",
    "navigation.system",
    "navigation.settings",
    "navigationGroup.planning",
    "page.overview.title",
    "page.overview.subtitle",
    "page.weather.title",
    "page.weather.subtitle",
    "page.home.title",
    "page.home.subtitle",
    "page.services.title",
    "page.services.subtitle",
    "page.calendar.title",
    "page.calendar.subtitle",
    "page.tasks.title",
    "page.tasks.subtitle",
    "page.reminders.title",
    "page.reminders.subtitle",
    "page.backups.title",
    "page.backups.subtitle",
    "page.apps.title",
    "page.apps.subtitle",
    "page.system.title",
    "page.system.subtitle",
    "page.settings.title",
    "page.settings.subtitle",
)


class InterfaceCopyStoreError(ValueError):
    pass


class InterfaceCopyRevisionConflict(InterfaceCopyStoreError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def interface_copy_store_path() -> Path:
    """Return the fixed Panel-owned runtime location.

    The environment override is a test/packaging seam, never a browser input.
    Production defaults to the same LOCALAPPDATA/.runtime family used by the
    other Panel-owned durable stores.
    """
    configured = os.getenv("PANEL_INTERFACE_COPY_PATH", "").strip()
    if configured:
        return Path(configured)
    root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
    return root / "interface-copy-settings.json"


def _empty_overrides() -> InterfaceCopyOverrides:
    return InterfaceCopyOverrides()


def _valid_text(field: InterfaceCopyField, value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    required = not field.endswith(".subtitle")
    if required and not normalized:
        raise InterfaceCopyStoreError("copy_value_blank")
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise InterfaceCopyStoreError("copy_value_control_character")
    if "<" in value or ">" in value:
        raise InterfaceCopyStoreError("copy_value_markup_not_allowed")
    limit = 48 if field.startswith("navigation") else 96 if field.endswith(".title") else 240
    if len(normalized) > limit:
        raise InterfaceCopyStoreError("copy_value_too_long")
    return normalized


def _override_value(overrides: InterfaceCopyOverrides, field: InterfaceCopyField) -> str | None:
    if field == "navigation.overview": return overrides.navigation.overview
    if field == "navigation.weather": return overrides.navigation.weather
    if field == "navigation.home": return overrides.navigation.home
    if field == "navigation.services": return overrides.navigation.services
    if field == "navigation.calendar": return overrides.navigation.calendar
    if field == "navigation.tasks": return overrides.navigation.tasks
    if field == "navigation.reminders": return overrides.navigation.reminders
    if field == "navigation.backups": return overrides.navigation.backups
    if field == "navigation.apps": return overrides.navigation.apps
    if field == "navigation.system": return overrides.navigation.system
    if field == "navigation.settings": return overrides.navigation.settings
    if field == "navigationGroup.planning": return overrides.navigationGroup.planning
    if field == "page.overview.title": return overrides.page.overview.title
    if field == "page.overview.subtitle": return overrides.page.overview.subtitle
    if field == "page.weather.title": return overrides.page.weather.title
    if field == "page.weather.subtitle": return overrides.page.weather.subtitle
    if field == "page.home.title": return overrides.page.home.title
    if field == "page.home.subtitle": return overrides.page.home.subtitle
    if field == "page.services.title": return overrides.page.services.title
    if field == "page.services.subtitle": return overrides.page.services.subtitle
    if field == "page.calendar.title": return overrides.page.calendar.title
    if field == "page.calendar.subtitle": return overrides.page.calendar.subtitle
    if field == "page.tasks.title": return overrides.page.tasks.title
    if field == "page.tasks.subtitle": return overrides.page.tasks.subtitle
    if field == "page.reminders.title": return overrides.page.reminders.title
    if field == "page.reminders.subtitle": return overrides.page.reminders.subtitle
    if field == "page.backups.title": return overrides.page.backups.title
    if field == "page.backups.subtitle": return overrides.page.backups.subtitle
    if field == "page.apps.title": return overrides.page.apps.title
    if field == "page.apps.subtitle": return overrides.page.apps.subtitle
    if field == "page.system.title": return overrides.page.system.title
    if field == "page.system.subtitle": return overrides.page.system.subtitle
    if field == "page.settings.title": return overrides.page.settings.title
    if field == "page.settings.subtitle": return overrides.page.settings.subtitle
    raise InterfaceCopyStoreError("copy_field_unknown")


def _set_override(
    overrides: InterfaceCopyOverrides,
    field: InterfaceCopyField,
    value: str | None,
) -> InterfaceCopyOverrides:
    if field.startswith("navigation."):
        navigation = overrides.navigation.model_copy(update={field.removeprefix("navigation."): value})
        return overrides.model_copy(update={"navigation": navigation})
    if field == "navigationGroup.planning":
        return overrides.model_copy(update={"navigationGroup": overrides.navigationGroup.model_copy(update={"planning": value})})
    page_name, page_field = field.removeprefix("page.").split(".", 1)
    page = getattr(overrides.page, page_name)
    page_update = page.model_copy(update={page_field: value})
    return overrides.model_copy(update={"page": overrides.page.model_copy(update={page_name: page_update})})


def _validate_overrides(overrides: InterfaceCopyOverrides) -> InterfaceCopyOverrides:
    normalized = overrides
    for field in _FIELDS:
        value = _override_value(normalized, field)
        if value is not None:
            # Stored values are never silently rewritten.  A hand-edited or
            # stale document with unsafe text is unavailable until replaced by
            # an intentional UI mutation.
            if _valid_text(field, value) != value:
                raise InterfaceCopyStoreError("stored_copy_value_not_canonical")
    return normalized


def _effective_catalog(overrides: InterfaceCopyOverrides) -> InterfaceCopyCatalog:
    effective = DEFAULT_CATALOG
    for field in _FIELDS:
        value = _override_value(overrides, field)
        if value is None:
            continue
        if field.startswith("navigation."):
            navigation = effective.navigation.model_copy(update={field.removeprefix("navigation."): value})
            effective = effective.model_copy(update={"navigation": navigation})
        elif field == "navigationGroup.planning":
            effective = effective.model_copy(update={"navigationGroup": effective.navigationGroup.model_copy(update={"planning": value})})
        else:
            page_name, page_field = field.removeprefix("page.").split(".", 1)
            page = getattr(effective.page, page_name).model_copy(update={page_field: value})
            effective = effective.model_copy(update={"page": effective.page.model_copy(update={page_name: page})})
    return effective


def _response(
    *,
    revision: int,
    recovery_revision: int | None = None,
    updated_at: str,
    overrides: InterfaceCopyOverrides,
    available: bool,
    warnings: list[str],
    writes_enabled: bool,
) -> InterfaceCopySettingsResponse:
    return InterfaceCopySettingsResponse(
        schemaVersion=SCHEMA_VERSION,
        revision=revision,
        recoveryRevision=recovery_revision,
        updatedAt=updated_at,
        defaults=DEFAULT_CATALOG,
        overrides=overrides,
        effective=_effective_catalog(overrides),
        available=available,
        warnings=warnings,
        writesEnabled=writes_enabled,
    )


class InterfaceCopySettingsStore:
    def __init__(self, path: str | Path | None = None, *, writes_enabled: bool = False) -> None:
        self.path = Path(path) if path else interface_copy_store_path()
        self.writes_enabled = writes_enabled
        self._write_lock = Lock()

    @classmethod
    def from_environment(cls, *, writes_enabled: bool = False) -> "InterfaceCopySettingsStore":
        return cls(interface_copy_store_path(), writes_enabled=writes_enabled)

    def _read_raw(self) -> Mapping[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                return None
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _canonical(self, raw: Mapping[str, Any] | None) -> tuple[int, str, InterfaceCopyOverrides] | None:
        if raw is None or set(raw) != {"schemaVersion", "revision", "updatedAt", "overrides"}:
            return None
        if raw.get("schemaVersion") != SCHEMA_VERSION:
            return None
        revision = raw.get("revision")
        updated_at = raw.get("updatedAt")
        if type(revision) is not int or revision < 0 or not isinstance(updated_at, str):
            return None
        try:
            overrides = _validate_overrides(InterfaceCopyOverrides.model_validate(raw.get("overrides")))
        except Exception:
            return None
        return revision, updated_at, overrides

    def read(self) -> InterfaceCopySettingsResponse:
        raw = self._read_raw()
        canonical = self._canonical(raw)
        if canonical is None:
            exists = self.path.exists()
            return _response(
                revision=0,
                recovery_revision=0 if exists else None,
                updated_at=_utc_now(),
                overrides=_empty_overrides(),
                available=not exists,
                warnings=[] if not exists else ["stored_copy_settings_unavailable"],
                writes_enabled=self.writes_enabled,
            )
        revision, updated_at, overrides = canonical
        return _response(
            revision=revision,
            updated_at=updated_at,
            overrides=overrides,
            available=True,
            warnings=[],
            writes_enabled=self.writes_enabled,
        )

    def write(self, patch: InterfaceCopyPatch) -> InterfaceCopySettingsResponse:
        with self._write_lock:
            current = self.read()
            if not current.available:
                # A corrupt/unsupported document cannot be used as a source
                # of revision truth.  The sole recovery mutation is the
                # explicit owner-confirmed global reset against recovery
                # revision 0; it replaces the fixed store atomically.
                if not patch.resetAll:
                    raise InterfaceCopyStoreError("stored_copy_settings_unavailable")
                if current.recoveryRevision is None or patch.expectedRevision != current.recoveryRevision:
                    raise InterfaceCopyRevisionConflict("revision_conflict")
                overrides = _empty_overrides()
                document = {
                    "schemaVersion": SCHEMA_VERSION,
                    "revision": 1,
                    "updatedAt": _utc_now(),
                    "overrides": overrides.model_dump(exclude_none=True),
                }
                self._atomic_write(document)
                return _response(
                    revision=document["revision"],
                    updated_at=document["updatedAt"],
                    overrides=overrides,
                    available=True,
                    warnings=[],
                    writes_enabled=self.writes_enabled,
                )
            if current.revision != patch.expectedRevision:
                raise InterfaceCopyRevisionConflict("revision_conflict")
            if patch.resetAll:
                overrides = _empty_overrides()
            else:
                if patch.field is None or "value" not in patch.model_fields_set:
                    raise InterfaceCopyStoreError("copy_patch_shape_invalid")
                value = _valid_text(patch.field, patch.value)
                overrides = _set_override(current.overrides, patch.field, value)
            document = {
                "schemaVersion": SCHEMA_VERSION,
                "revision": patch.expectedRevision + 1,
                "updatedAt": _utc_now(),
                "overrides": overrides.model_dump(exclude_none=True),
            }
            self._atomic_write(document)
            return _response(
                revision=document["revision"],
                updated_at=document["updatedAt"],
                overrides=overrides,
                available=True,
                warnings=[],
                writes_enabled=self.writes_enabled,
            )

    def _atomic_write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise InterfaceCopyStoreError("copy_settings_too_large")
        temporary: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def fixture_interface_copy_response(scenario: str) -> InterfaceCopySettingsResponse | None:
    """Return deterministic, read-only fixture responses for browser tests."""
    if scenario not in FIXTURE_INTERFACE_COPY_SCENARIOS:
        return None
    overrides = _empty_overrides()
    revision = 0
    available = True
    warnings: list[str] = []
    if scenario == "custom-navigation":
        overrides = _set_override(overrides, "navigation.overview", "Главная")
        overrides = _set_override(overrides, "navigation.calendar", "Расписание")
        revision = 2
    elif scenario == "custom-page-copy":
        overrides = _set_override(overrides, "page.overview.title", "Мой день")
        overrides = _set_override(overrides, "page.overview.subtitle", "Сегодня — всё важное на первом экране")
        revision = 3
    elif scenario == "removed-subtitle":
        overrides = _set_override(overrides, "page.overview.subtitle", "")
        revision = 4
    elif scenario == "revision-conflict":
        revision = 7
    elif scenario in {"malformed", "unsupported", "oversized", "unavailable"}:
        available = False
        warnings = ["stored_copy_settings_unavailable"]
    return _response(
        revision=revision,
        recovery_revision=0 if not available else None,
        updated_at="2026-08-27T00:00:00Z",
        overrides=overrides,
        available=available,
        warnings=warnings,
        writes_enabled=False,
    )


def interface_copy_fields() -> tuple[InterfaceCopyField, ...]:
    return _FIELDS
