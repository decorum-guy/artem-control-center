"""Read the non-secret capability manifest emitted with the served bundle."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .capabilities import DELAYED_MUTABLE_IDS


MANIFEST_NAME = "dashboard-capabilities.json"
_VITE_BY_ID = {
    "planning_overview": "VITE_PLANNING_OVERVIEW_ENABLED",
    "planning_tasks_route": "VITE_PLANNING_TASKS_ROUTE_ENABLED",
    "planning_calendar_route": "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
    "planning_reminders_route": "VITE_PLANNING_REMINDERS_ROUTE_ENABLED",
}

# The manifest is deliberately non-secret and lets the inventory describe the
# bundle actually being served instead of inferring build gates from process
# environment.  The mutable subset above remains the only override allowlist.
_BUILD_FLAGS = frozenset({
    "VITE_V2_VISUAL_SHELL",
    "VITE_OVERVIEW_V2_ENABLED",
    "VITE_OVERVIEW_EDITOR_ENABLED",
    "VITE_PLANNING_OVERVIEW_ENABLED",
    "VITE_PLANNING_TASKS_ROUTE_ENABLED",
    "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
    "VITE_PLANNING_REMINDERS_ROUTE_ENABLED",
    "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED",
    "VITE_PLANNING_TASK_MUTATIONS_ENABLED",
    "VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED",
    "VITE_TOUCH_INPUT_LOCK_ENABLED",
    "VITE_TOUCH_INPUT_LOCK_START_LOCKED",
})


def dashboard_capability_manifest() -> dict[str, Any] | None:
    dist = os.getenv("PANEL_DASHBOARD_DIST", "").strip()
    if not dist:
        return None
    path = Path(dist) / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("schemaVersion") != "dashboard-capabilities.v1":
            return None
        active = raw.get("active")
        baseline = raw.get("baseline")
        flags = raw.get("flags")
        if not isinstance(active, dict) or not isinstance(baseline, dict):
            return None
        if set(active) != DELAYED_MUTABLE_IDS or set(baseline) != DELAYED_MUTABLE_IDS:
            return None
        if any(type(active[key]) is not bool or type(baseline[key]) is not bool for key in DELAYED_MUTABLE_IDS):
            return None
        if flags is not None:
            if not isinstance(flags, dict) or set(flags) != _BUILD_FLAGS or any(type(flags[key]) is not bool for key in _BUILD_FLAGS):
                return None
        # Compatibility with a bundle produced immediately before B2.2.  It is
        # still safe (the mutable active set is validated); only non-mutable
        # build context is unavailable until the next normal production build.
        return {"active": active, "baseline": baseline, "flags": flags or {}, "profile": raw.get("profile", "accepted-v2")}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def active_build_states() -> tuple[dict[str, bool], dict[str, bool], bool]:
    manifest = dashboard_capability_manifest()
    if manifest is not None:
        return dict(manifest["active"]), dict(manifest["baseline"]), True
    # Fixture/read-only processes have no served production bundle.  Failing
    # closed avoids falsely showing an unknown route as enabled.
    return ({key: False for key in DELAYED_MUTABLE_IDS}, {key: False for key in DELAYED_MUTABLE_IDS}, False)


def active_build_flags() -> tuple[dict[str, bool], bool]:
    manifest = dashboard_capability_manifest()
    if manifest is not None and manifest["flags"]:
        return dict(manifest["flags"]), True
    return ({key: False for key in _BUILD_FLAGS}, False)


def vite_mapping() -> dict[str, str]:
    return dict(_VITE_BY_ID)
