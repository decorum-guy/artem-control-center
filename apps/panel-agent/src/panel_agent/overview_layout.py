"""Fixed, server-owned Overview layout persistence.

This module deliberately knows one layout resource only.  It does not expose
generic file or JSON storage and it never executes data from a saved layout.
Migration and recovery helpers are pure; filesystem work is confined to the
storage class at the bottom of the module.
"""

from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .contracts import (
    OverviewLayoutItemRequest,
    OverviewLayoutPatch,
    OverviewLayoutResponse,
    OverviewPlacement,
    OverviewUnplacedWidget,
)

SCHEMA_VERSION = "overview.layout.v2"
PROFILE_ID = "samsung-control"
PRESET_ID = "overview.default"
PRESET_VERSION = 2
VIEWPORT_CLASS = "landscape-12"
CANONICAL_COLUMNS = 12
MAX_ITEMS = 32
MAX_FILE_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 128 * 1024
DEFAULT_UPDATED_AT = "1970-01-01T00:00:00+00:00"

_SCHEMA_PATH = Path(__file__).resolve().parents[4] / "config" / "overview-appearance-schema.json"
with _SCHEMA_PATH.open("r", encoding="utf-8") as _schema_file:
    APPEARANCE_SCHEMA: Dict[str, Any] = json.load(_schema_file)
if APPEARANCE_SCHEMA.get("schemaVersion") != "overview.appearance.v1":
    raise RuntimeError("Unsupported trusted Overview appearance schema")


WIDGETS: Dict[str, Dict[str, Any]] = {
    "home.coffee-machine": {
        "singleton": True,
        "sizes": {"compact": (4, 3), "standard": (7, 4), "large": (8, 5)},
        "default": "standard",
    },
    "system.rog-g703-operational": {
        "singleton": True,
        "sizes": {"compact": (6, 1), "standard": (12, 1), "detail": (6, 2)},
        "default": "standard",
    },
    "planning.summary": {
        "singleton": True,
        "sizes": {"compact": (4, 3), "standard": (5, 4), "large": (7, 5)},
        "default": "standard",
    },
    "home.quick-actions": {
        "singleton": True,
        "sizes": {"compact": (4, 2), "standard": (7, 2)},
        "default": "standard",
    },
    "system.health-summary": {
        "singleton": True,
        "sizes": {"compact": (5, 2), "large": (7, 3)},
        "default": "compact",
    },
    "weather.alert": {
        "singleton": True,
        "sizes": {"compact": (4, 1), "standard": (6, 2)},
        "default": "standard",
    },
    "planning.calendar-agenda": {
        "singleton": True,
        "sizes": {"compact": (4, 3), "standard": (6, 4), "large": (8, 5)},
        "default": "standard",
    },
    "planning.task-list": {
        "singleton": True,
        "sizes": {"compact": (4, 3), "standard": (6, 4), "large": (8, 5)},
        "default": "standard",
    },
}

DEFAULT_INSTANCE_IDS = {
    "system.rog-g703-operational": "fixture.rog",
    "home.coffee-machine": "fixture.coffee",
    "planning.summary": "fixture.planning",
    "home.quick-actions": "fixture.quick-actions",
    "system.health-summary": "fixture.health",
}


class OverviewLayoutValidationError(ValueError):
    """An explicit candidate is unsafe and must not be repaired or written."""


class OverviewRevisionConflict(RuntimeError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default_config(widget_type: str) -> Dict[str, Any]:
    widget = APPEARANCE_SCHEMA.get("widgets", {}).get(widget_type, {})
    defaults = widget.get("defaults", {})
    return dict(defaults) if isinstance(defaults, dict) else {}


def _controls(widget_type: str) -> Dict[str, Dict[str, Any]]:
    widget = APPEARANCE_SCHEMA.get("widgets", {}).get(widget_type, {})
    controls = widget.get("controls", [])
    if not isinstance(controls, list):
        return {}
    return {
        str(control.get("key")): control
        for control in controls
        if isinstance(control, dict) and isinstance(control.get("key"), str)
    }


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _validate_config(widget_type: str, raw: Any, *, strict: bool) -> Dict[str, Any]:
    if raw is None:
        raw = {}
    if not _is_plain_object(raw):
        raise OverviewLayoutValidationError(f"{widget_type}: config must be a flat object")
    controls = _controls(widget_type)
    result: Dict[str, Any] = {}
    errors: List[str] = []
    for key, value in raw.items():
        if key not in controls:
            errors.append(f"unknown config key {key}")
            continue
        descriptor = controls[key]
        control = descriptor.get("control")
        if control == "boolean":
            valid = type(value) is bool
        elif control == "integer_range":
            valid = (
                type(value) is int
                and int(descriptor.get("min", 0)) <= value <= int(descriptor.get("max", 0))
                and (value - int(descriptor.get("min", 0))) % int(descriptor.get("step", 1)) == 0
            )
        elif control == "enum":
            values = descriptor.get("values", [])
            allowed = {
                entry.get("value")
                for entry in values
                if isinstance(entry, dict) and isinstance(entry.get("value"), str)
            }
            valid = type(value) is str and value in allowed
        else:
            valid = False
        if not valid:
            errors.append(f"invalid config value {key}")
            continue
        result[key] = value
    if errors and strict:
        raise OverviewLayoutValidationError("; ".join(errors))
    if not strict:
        for key, descriptor in controls.items():
            if key in result:
                continue
            default = descriptor.get("defaultValue", _default_config(widget_type).get(key))
            result[key] = default
        return result
    for key, descriptor in controls.items():
        if key not in result:
            result[key] = descriptor.get("defaultValue", _default_config(widget_type).get(key))
    return result


def _placement_dict(x: int, y: int, w: int, h: int) -> Dict[str, int]:
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def _item(
    instance_id: str,
    widget_type: str,
    size_variant: str,
    x: int,
    y: int,
    *,
    visibility: str = "visible",
    config: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    w, h = WIDGETS[widget_type]["sizes"][size_variant]
    return {
        "instanceId": instance_id,
        "widgetType": widget_type,
        "visibility": visibility,
        "placement": _placement_dict(x, y, w, h),
        "sizeVariant": size_variant,
        "config": _validate_config(widget_type, config or {}, strict=False),
    }


def shipped_items() -> List[Dict[str, Any]]:
    return [
        _item("fixture.rog", "system.rog-g703-operational", "standard", 0, 0),
        _item("fixture.coffee", "home.coffee-machine", "standard", 0, 1),
        _item("fixture.planning", "planning.summary", "standard", 7, 1),
        _item("fixture.quick-actions", "home.quick-actions", "standard", 0, 5),
        _item("fixture.health", "system.health-summary", "compact", 7, 5),
    ]


def shipped_layout(*, revision: int = 0, updated_at: str = DEFAULT_UPDATED_AT) -> Dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": PROFILE_ID,
        "presetId": PRESET_ID,
        "presetVersion": PRESET_VERSION,
        "revision": revision,
        "viewportClass": VIEWPORT_CLASS,
        "updatedAt": updated_at,
        "items": deepcopy(shipped_items()),
    }


def _rectangle_overlap(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    return (
        first["x"] < second["x"] + second["w"]
        and second["x"] < first["x"] + first["w"]
        and first["y"] < second["y"] + second["h"]
        and second["y"] < first["y"] + first["h"]
    )


def _first_fit(
    size: Tuple[int, int], occupied: Sequence[Mapping[str, Any]], start_y: int = 0
) -> Dict[str, int]:
    w, h = size
    first_row = max(0, int(start_y))
    bottom = max([first_row, *[int(rect["y"]) + int(rect["h"]) for rect in occupied]])
    for y in range(first_row, bottom + 1):
        for x in range(0, CANONICAL_COLUMNS - w + 1):
            candidate = _placement_dict(x, y, w, h)
            if not any(_rectangle_overlap(candidate, rect) for rect in occupied):
                return candidate
    return _placement_dict(0, max(first_row, bottom), w, h)


def _safe_identifier(value: Any, fallback: str) -> str:
    if isinstance(value, str) and 1 <= len(value) <= 80 and value[:1].isalnum():
        if all(char.isalnum() or char in "._-" for char in value):
            return value
    return fallback


def _variant_for_dimensions(widget_type: str, w: int, h: int) -> Optional[str]:
    for variant, size in WIDGETS[widget_type]["sizes"].items():
        if size == (w, h):
            return variant
    return None


def _canonical_item_from_request(item: OverviewLayoutItemRequest) -> Dict[str, Any]:
    widget_type = item.widgetType
    if widget_type not in WIDGETS:
        raise OverviewLayoutValidationError(f"unknown widget type {widget_type}")
    widget = WIDGETS[widget_type]
    if item.sizeVariant not in widget["sizes"]:
        raise OverviewLayoutValidationError(f"unsupported size variant {item.sizeVariant}")
    expected_w, expected_h = widget["sizes"][item.sizeVariant]
    placement = item.placement.model_dump()
    if (placement["w"], placement["h"]) != (expected_w, expected_h):
        raise OverviewLayoutValidationError(
            f"{widget_type}: placement does not match {item.sizeVariant}"
        )
    if placement["x"] + placement["w"] > CANONICAL_COLUMNS:
        raise OverviewLayoutValidationError(f"{item.instanceId}: placement leaves the 12-column grid")
    return {
        "instanceId": item.instanceId,
        "widgetType": widget_type,
        "visibility": item.visibility,
        "placement": placement,
        "sizeVariant": item.sizeVariant,
        "config": _validate_config(widget_type, item.config, strict=True),
    }


def validate_explicit_patch(patch: OverviewLayoutPatch) -> List[Dict[str, Any]]:
    """Validate a complete candidate without repairing any user error."""
    if len(patch.items) > MAX_ITEMS:
        raise OverviewLayoutValidationError("too many Overview items")
    items = [_canonical_item_from_request(item) for item in patch.items]
    instance_ids = [item["instanceId"] for item in items]
    if len(instance_ids) != len(set(instance_ids)):
        raise OverviewLayoutValidationError("duplicate instanceId")
    visible = [item for item in items if item["visibility"] == "visible"]
    singleton_types: set[str] = set()
    for item in items:
        widget_type = item["widgetType"]
        if WIDGETS[widget_type]["singleton"]:
            if widget_type in singleton_types:
                raise OverviewLayoutValidationError(f"duplicate singleton {widget_type}")
            singleton_types.add(widget_type)
    for index, first in enumerate(visible):
        for second in visible[index + 1 :]:
            if _rectangle_overlap(first["placement"], second["placement"]):
                raise OverviewLayoutValidationError("overlap after final layout state")
    if not items:
        raise OverviewLayoutValidationError("at least one item is required")
    return items


def _response(
    layout: Mapping[str, Any],
    *,
    writes_enabled: bool,
    warnings: Optional[Iterable[str]] = None,
    unplaced: Optional[Iterable[Mapping[str, str]]] = None,
) -> OverviewLayoutResponse:
    return OverviewLayoutResponse(
        **deepcopy(dict(layout)),
        warnings=list(warnings or []),
        unplaced=[OverviewUnplacedWidget(**record) for record in (unplaced or [])],
        writesEnabled=writes_enabled,
    )


def _normalize_v1_item(raw: Mapping[str, Any], index: int) -> Optional[Dict[str, Any]]:
    widget_type = raw.get("widgetType") or raw.get("widget_id") or raw.get("widgetId")
    if isinstance(widget_type, str) and widget_type.startswith("widget."):
        widget_type = {
            "widget.coffee.primary": "home.coffee-machine",
            "widget.rog.primary": "system.rog-g703-operational",
            "widget.planning.summary": "planning.summary",
            "widget.quick-actions": "home.quick-actions",
            "widget.health": "system.health-summary",
        }.get(widget_type, widget_type)
    if not isinstance(widget_type, str) or widget_type not in WIDGETS:
        return {
            "instanceId": _safe_identifier(
                raw.get("instanceId") or raw.get("widget_id"),
                f"legacy.unknown.{index}",
            ),
            "widgetType": str(widget_type or "unknown"),
            "reason": "legacy widget is not registered",
        }
    placement = raw.get("placement") if isinstance(raw.get("placement"), dict) else raw
    try:
        w = int(placement.get("w", placement.get("width")))
        h = int(placement.get("h", placement.get("height")))
        x = int(placement.get("x", 0))
        y = int(placement.get("y", 0))
    except (TypeError, ValueError):
        w, h, x, y = 0, 0, -1, -1
    variant = raw.get("sizeVariant") or _variant_for_dimensions(widget_type, w, h)
    if not isinstance(variant, str) or variant not in WIDGETS[widget_type]["sizes"]:
        variant = WIDGETS[widget_type]["default"]
    return {
        "instanceId": _safe_identifier(
            raw.get("instanceId") or raw.get("widget_id"),
            DEFAULT_INSTANCE_IDS.get(widget_type, f"legacy.{widget_type}.{index}"),
        ),
        "widgetType": widget_type,
        "visibility": "hidden" if raw.get("visibility") == "hidden" else "visible",
        "placement": _placement_dict(x, y, w, h),
        "sizeVariant": variant,
        "config": raw.get("config", {}),
    }


def migrate_v1_to_v2(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """Pure migration for the earlier configured/default layout vocabulary."""
    source_items: Any = raw.get("items")
    if not isinstance(source_items, list):
        profiles = raw.get("profiles")
        if isinstance(profiles, list) and profiles:
            profile = next((entry for entry in profiles if isinstance(entry, dict) and entry.get("id") == "desk"), profiles[0])
            source_items = profile.get("items", []) if isinstance(profile, dict) else []
    if not isinstance(source_items, list):
        source_items = []
    items = [_normalize_v1_item(item, index) for index, item in enumerate(source_items) if isinstance(item, dict)]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": PROFILE_ID,
        "presetId": PRESET_ID,
        "presetVersion": PRESET_VERSION,
        "revision": int(raw.get("revision", 0)) if type(raw.get("revision", 0)) is int else 0,
        "viewportClass": VIEWPORT_CLASS,
        "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), str) else DEFAULT_UPDATED_AT,
        "items": [item for item in items if item is not None],
    }


def _recover_item(
    raw: Mapping[str, Any],
    index: int,
    occupied: List[Dict[str, int]],
    seen_ids: set[str],
    singleton_types: set[str],
    warnings: List[str],
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, str]]]:
    instance_id = _safe_identifier(raw.get("instanceId"), f"stored.item.{index}")
    widget_type = raw.get("widgetType")
    if not isinstance(widget_type, str) or widget_type not in WIDGETS:
        return None, {
            "instanceId": instance_id,
            "widgetType": str(widget_type or "unknown"),
            "reason": "widget type is not registered",
        }
    if instance_id in seen_ids:
        warnings.append(f"{instance_id}: duplicate instanceId skipped")
        return None, None
    if WIDGETS[widget_type]["singleton"] and widget_type in singleton_types:
        warnings.append(f"{widget_type}: duplicate singleton skipped")
        return None, None
    seen_ids.add(instance_id)
    singleton_types.add(widget_type)

    variant = raw.get("sizeVariant")
    if not isinstance(variant, str) or variant not in WIDGETS[widget_type]["sizes"]:
        variant = WIDGETS[widget_type]["default"]
        warnings.append(f"{instance_id}: unsupported sizeVariant recovered to {variant}")
    expected_w, expected_h = WIDGETS[widget_type]["sizes"][variant]
    placement = raw.get("placement")
    valid_placement = (
        isinstance(placement, dict)
        and all(type(placement.get(key)) is int for key in ("x", "y", "w", "h"))
    )
    if not valid_placement:
        placement = _first_fit((expected_w, expected_h), occupied, max([rect["y"] + rect["h"] for rect in occupied], default=0))
        warnings.append(f"{instance_id}: malformed placement reflowed")
    else:
        placement = _placement_dict(placement["x"], placement["y"], placement["w"], placement["h"])
        if (placement["w"], placement["h"]) != (expected_w, expected_h):
            placement = _first_fit((expected_w, expected_h), occupied, max([rect["y"] + rect["h"] for rect in occupied], default=0))
            warnings.append(f"{instance_id}: placement recovered to named size {variant}")
        else:
            x = max(0, min(placement["x"], CANONICAL_COLUMNS - expected_w))
            y = max(0, placement["y"])
            if x != placement["x"] or y != placement["y"]:
                warnings.append(f"{instance_id}: placement clamped to grid bounds")
            placement = _placement_dict(x, y, expected_w, expected_h)
            if any(_rectangle_overlap(placement, rect) for rect in occupied):
                placement = _first_fit((expected_w, expected_h), occupied, max([rect["y"] + rect["h"] for rect in occupied], default=0))
                warnings.append(f"{instance_id}: overlapping placement reflowed")
    config = _validate_config(widget_type, raw.get("config", {}), strict=False)
    if raw.get("config") is not None and not isinstance(raw.get("config"), dict):
        warnings.append(f"{instance_id}: malformed config recovered to defaults")
    item = {
        "instanceId": instance_id,
        "widgetType": widget_type,
        "visibility": "hidden" if raw.get("visibility") == "hidden" else "visible",
        "placement": placement,
        "sizeVariant": variant,
        "config": config,
    }
    if item["visibility"] == "visible":
        occupied.append(placement)
    return item, None


def recover_stored_layout(raw: Mapping[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[str], List[Dict[str, str]]]:
    """Recover stored/legacy data without writing it back."""
    if raw.get("schemaVersion") == "overview.layout.v1" or raw.get("version") == 1:
        raw = migrate_v1_to_v2(raw)
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        return None, ["stored layout schema is not recognized"], []
    if raw.get("profileId") not in {None, PROFILE_ID}:
        return None, ["stored layout profile is not recognized"], []
    if raw.get("presetId") not in {None, PRESET_ID}:
        return None, ["stored layout preset is not recognized"], []
    if raw.get("presetVersion") not in {None, PRESET_VERSION}:
        return None, ["stored layout preset version is not recognized"], []
    if raw.get("viewportClass") not in {None, VIEWPORT_CLASS}:
        return None, ["stored layout viewport is not recognized"], []
    raw_items = raw.get("items")
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ITEMS:
        return None, ["stored layout item collection is invalid"], []
    revision = raw.get("revision", 0)
    if type(revision) is not int or revision < 0:
        revision = 0
    updated_at = raw.get("updatedAt") if isinstance(raw.get("updatedAt"), str) else DEFAULT_UPDATED_AT
    warnings: List[str] = []
    unplaced: List[Dict[str, str]] = []
    items: List[Dict[str, Any]] = []
    occupied: List[Dict[str, int]] = []
    seen_ids: set[str] = set()
    singleton_types: set[str] = set()
    for index, candidate in enumerate(raw_items):
        if not isinstance(candidate, dict):
            warnings.append(f"item {index}: malformed item skipped")
            continue
        item, unknown = _recover_item(candidate, index, occupied, seen_ids, singleton_types, warnings)
        if unknown:
            unplaced.append(unknown)
        elif item:
            items.append(item)
    if not items:
        return None, warnings + ["stored layout has no valid widgets"], unplaced
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": PROFILE_ID,
        "presetId": PRESET_ID,
        "presetVersion": PRESET_VERSION,
        "revision": revision,
        "viewportClass": VIEWPORT_CLASS,
        "updatedAt": updated_at,
        "items": items,
    }
    return result, warnings, unplaced


class OverviewLayoutStore:
    def __init__(self, path: str, *, writes_enabled: bool = False) -> None:
        self.path = Path(path or ".cache/overview-layout.json")
        self.writes_enabled = writes_enabled

    def _read_raw(self) -> Optional[Mapping[str, Any]]:
        if not self.path.exists():
            return None
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                return None
            raw_bytes = self.path.read_bytes()
            if raw_bytes.startswith(b"\xef\xbb\xbf"):
                return None
            raw = json.loads(raw_bytes.decode("utf-8"))
            return raw if isinstance(raw, dict) else None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def read(self) -> OverviewLayoutResponse:
        raw = self._read_raw()
        if raw is None:
            return _response(shipped_layout(), writes_enabled=self.writes_enabled, warnings=([] if not self.path.exists() else ["stored layout is corrupt; shipped preset used"]))
        recovered, warnings, unplaced = recover_stored_layout(raw)
        if recovered is None:
            recovered = shipped_layout()
        return _response(recovered, writes_enabled=self.writes_enabled, warnings=warnings, unplaced=unplaced)

    def _current_revision(self) -> int:
        return int(self.read().revision)

    def write(self, patch: OverviewLayoutPatch, expected_revision: int) -> OverviewLayoutResponse:
        current = self.read()
        if current.revision != expected_revision:
            raise OverviewRevisionConflict("revision_conflict")
        items = validate_explicit_patch(patch)
        canonical = {
            "schemaVersion": SCHEMA_VERSION,
            "profileId": PROFILE_ID,
            "presetId": PRESET_ID,
            "presetVersion": PRESET_VERSION,
            "revision": expected_revision + 1,
            "viewportClass": VIEWPORT_CLASS,
            "updatedAt": _utc_now(),
            "items": items,
        }
        self._atomic_write(canonical)
        return _response(canonical, writes_enabled=self.writes_enabled)

    def _atomic_write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise OverviewLayoutValidationError("canonical layout exceeds storage size limit")
        parent = self.path.parent
        temporary_path: Optional[Path] = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=parent,
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

    @staticmethod
    def etag(revision: int) -> str:
        return f'"{revision}"'

    @staticmethod
    def parse_if_match(value: Optional[str]) -> Optional[int]:
        if value is None:
            return None
        candidate = value.strip()
        if len(candidate) >= 2 and candidate[0] == '"' and candidate[-1] == '"':
            candidate = candidate[1:-1]
        try:
            parsed = int(candidate)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None


def layout_response_for_test(store: OverviewLayoutStore) -> Dict[str, Any]:
    """Small JSON-friendly helper for tests and local diagnostics."""
    return store.read().model_dump()
