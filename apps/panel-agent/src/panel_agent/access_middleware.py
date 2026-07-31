from __future__ import annotations

from fastapi import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

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
