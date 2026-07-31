from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .access_policy import AccessPolicyStore


_MUTATION_CAPABILITIES: dict[tuple[str, str], str] = {
    ("PATCH", "/api/v1/settings/coffee/timing"): "home.coffee.settings.timing",
    ("PATCH", "/api/v1/settings/notifications/coffee"): "home.coffee.settings.notifications",
    ("POST", "/api/v1/actions/home/coffee"): "home.coffee.control",
}


class AccessPolicyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, store: AccessPolicyStore) -> None:
        super().__init__(app)
        self.store = store

    async def dispatch(self, request: Request, call_next):
        capability = _MUTATION_CAPABILITIES.get((request.method, request.url.path))
        if capability is not None:
            self.store.require(capability)
            self.store.audit_capability(capability, result="accepted")
        return await call_next(request)
