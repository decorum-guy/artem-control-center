"""The dependency-free canonical Jarvis navigation boundary."""

from __future__ import annotations

from typing import Literal


NavigationPath = Literal["/overview", "/calendar", "/tasks", "/reminders", "/settings", "/system", "/coffee-diary"]
JARVIS_NAVIGATION_PATHS = frozenset({
    "/overview", "/calendar", "/tasks", "/reminders", "/settings", "/system", "/coffee-diary",
})


def is_jarvis_navigation(value: object) -> bool:
    """Accept only routes owned by the existing Jarvis A1 contract."""

    return isinstance(value, str) and value in JARVIS_NAVIGATION_PATHS
