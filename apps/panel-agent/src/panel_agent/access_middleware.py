from __future__ import annotations

from fastapi import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .access_policy import AccessPolicyStore


_MUTATION_CAPABILITIES: dict[tuple[str, str], str] = {
    ("PATCH", "/api/v1/settings/coffee/timing"): "home.coffee.settings.timing",
    ("PATCH", "/api/v1/settings/notifications/coffee"): "home.coffee.settings.notifications",
    ("PATCH", "/api/v1/settings/calendar/display-colors"): "settings.calendar.colors",
    ("PATCH", "/api/v1/settings/ai/selection"): "settings.ai.providers",
    ("PATCH", "/api/v1/settings/capabilities"): "settings.capabilities.manage",
    ("POST", "/api/v1/system/runtime/apply-capabilities"): "settings.capabilities.manage",
    ("POST", "/api/v1/actions/home/coffee"): "home.coffee.control",
}

_PLANNING_REMINDERS_PREFIX = "/api/v1/planning/reminders/"
_PLANNING_TASKS_PREFIX = "/api/v1/planning/tasks/"
_PLANNING_EVENTS_PREFIX = "/api/v1/planning/events/"


def _planning_capability(method: str, path: str) -> str | None:
    """Return only source-owned Planning capability IDs for known routes."""
    if method == "POST" and path == "/api/v1/planning/reminders":
        return "planning.reminders.create"
    if path.startswith(_PLANNING_REMINDERS_PREFIX):
        segments = path.removeprefix(_PLANNING_REMINDERS_PREFIX).split("/")
        if method == "PATCH" and len(segments) == 1 and segments[0]:
            return "planning.reminders.edit"
        if method == "POST" and len(segments) == 2 and segments[0] and segments[1] == "complete":
            return "planning.reminders.complete"
        if method == "POST" and len(segments) == 2 and segments[0] and segments[1] == "cancel":
            return "planning.reminders.cancel"
        return None
    if method == "POST" and path == "/api/v1/planning/tasks":
        return "planning.tasks.create"
    if method == "POST" and path == "/api/v1/planning/events":
        return "planning.calendar.create"
    if path.startswith(_PLANNING_EVENTS_PREFIX):
        segments = path.removeprefix(_PLANNING_EVENTS_PREFIX).split("/")
        if method == "PATCH" and len(segments) == 1 and segments[0]:
            return "planning.calendar.edit"
        if method == "DELETE" and len(segments) == 1 and segments[0]:
            return "planning.calendar.delete"
        return None
    if not path.startswith(_PLANNING_TASKS_PREFIX):
        return None
    segments = path.removeprefix(_PLANNING_TASKS_PREFIX).split("/")
    if method == "PATCH" and len(segments) == 1 and segments[0]:
        return "planning.tasks.edit"
    if method == "POST" and len(segments) == 2 and segments[0] and segments[1] == "complete":
        return "planning.tasks.complete"
    if method == "DELETE" and len(segments) == 1 and segments[0]:
        return "planning.tasks.archive"
    return None


def capability_for_request(method: str, path: str) -> str | None:
    """Resolve the fixed access capability for a registered mutation route."""
    if method == "PATCH" and path.startswith("/api/v1/settings/ai/providers/") and path.endswith("/credential"):
        return "settings.ai.providers"
    return _MUTATION_CAPABILITIES.get((method, path)) or _planning_capability(method, path)


class AccessPolicyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, store: AccessPolicyStore) -> None:
        super().__init__(app)
        self.store = store

    async def dispatch(self, request: Request, call_next):
        capability = capability_for_request(request.method, request.url.path)
        if capability is None:
            return await call_next(request)

        try:
            self.store.require(capability)
        except HTTPException as exc:
            self.store.audit_capability(capability, result=str(exc.detail))
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers={"Cache-Control": "no-store"},
            )

        response = await call_next(request)
        self.store.audit_capability(
            capability,
            result="success" if response.status_code < 400 else f"http_{response.status_code}",
        )
        return response
