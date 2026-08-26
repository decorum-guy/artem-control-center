"""Bounded, Panel-owned Calendar display-color preferences.

This store never reaches a Calendar provider.  It retains only safe Planning
identity pairs and an owner-selected display colour.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .contracts import (
    CalendarDisplayColorOverride,
    CalendarDisplayPreferencesResponse,
)


SCHEMA_VERSION = "calendar.display-preferences.v1"
MAX_FILE_BYTES = 64 * 1024
MAX_OVERRIDES = 128


class CalendarDisplayPreferencesError(ValueError):
    pass


class CalendarDisplayPreferencesConflict(CalendarDisplayPreferencesError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _empty_document() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": 0,
        "updatedAt": _utc_now(),
        "overrides": [],
    }


class CalendarDisplayPreferencesStore:
    def __init__(self, path: str, *, writes_enabled: bool = False) -> None:
        self.path = Path(path or ".cache/calendar-display-colors.json")
        self.writes_enabled = writes_enabled

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
        entries = raw.get("overrides")
        if not isinstance(revision, int) or revision < 0 or not isinstance(updated_at, str) or not isinstance(entries, list) or len(entries) > MAX_OVERRIDES:
            return None
        normalized: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        try:
            for entry in entries:
                item = CalendarDisplayColorOverride.model_validate(entry)
                key = (item.providerId, item.calendarId)
                if key in seen:
                    return None
                seen.add(key)
                normalized.append(item.model_dump())
        except Exception:
            return None
        return {
            "schemaVersion": SCHEMA_VERSION,
            "revision": revision,
            "updatedAt": updated_at,
            "overrides": sorted(normalized, key=lambda item: (item["providerId"], item["calendarId"])),
        }

    def read(self) -> CalendarDisplayPreferencesResponse:
        raw = self._read_raw()
        canonical = self._canonical(raw)
        if canonical is None:
            return CalendarDisplayPreferencesResponse(
                **_empty_document(),
                available=not self.path.exists(),
                warnings=[] if not self.path.exists() else ["stored_preferences_unavailable"],
                writesEnabled=self.writes_enabled,
            )
        return CalendarDisplayPreferencesResponse(
            **canonical,
            available=True,
            warnings=[],
            writesEnabled=self.writes_enabled,
        )

    def write(
        self,
        *,
        provider_id: str,
        calendar_id: str,
        color: str | None,
        expected_revision: int,
        known_identities: Iterable[tuple[str, str]],
    ) -> CalendarDisplayPreferencesResponse:
        current = self.read()
        if current.revision != expected_revision:
            raise CalendarDisplayPreferencesConflict("revision_conflict")
        key = (provider_id, calendar_id)
        existing = {(entry.providerId, entry.calendarId): entry for entry in current.overrides}
        if key not in existing and key not in set(known_identities):
            raise CalendarDisplayPreferencesError("calendar_identity_unknown")
        if color is None:
            existing.pop(key, None)
        else:
            existing[key] = CalendarDisplayColorOverride(
                providerId=provider_id,
                calendarId=calendar_id,
                color=color,
            )
        document = {
            "schemaVersion": SCHEMA_VERSION,
            "revision": expected_revision + 1,
            "updatedAt": _utc_now(),
            "overrides": [entry.model_dump() for _, entry in sorted(existing.items())],
        }
        self._atomic_write(document)
        return CalendarDisplayPreferencesResponse(
            **document,
            available=True,
            warnings=[],
            writesEnabled=self.writes_enabled,
        )

    def _atomic_write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise CalendarDisplayPreferencesError("preferences_exceed_storage_limit")
        temporary_path: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
                delete=False,
            ) as handle:
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
