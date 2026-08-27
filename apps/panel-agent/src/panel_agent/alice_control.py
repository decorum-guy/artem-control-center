from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from .settings import IntegrationSettings


class AliceControlError(RuntimeError):
    def __init__(self, code: str, status_code: int = 503) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class AliceControlClient:
    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._cache: Dict[str, dict[str, Any]] = {}

    @property
    def configured(self) -> bool:
        return bool(
            self._settings.alice_base_url
            and self._settings.alice_control_center_token
        )

    async def get_timing(self) -> tuple[dict[str, Any], str]:
        return await self._get_cached("/internal/control-center/coffee/timing")

    async def patch_timing(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PATCH",
            "/internal/control-center/coffee/timing",
            payload,
        )

    async def get_notifications(self) -> tuple[dict[str, Any], str]:
        return await self._get_cached("/internal/notification-settings/coffee")

    async def patch_notifications(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PATCH",
            "/internal/notification-settings/coffee",
            payload,
        )

    async def get_reminder_delivery(self) -> tuple[dict[str, Any], str]:
        return await self._get_cached("/internal/reminders/delivery-settings")

    async def patch_reminder_delivery(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PATCH",
            "/internal/reminders/delivery-settings",
            payload,
        )

    async def coffee_action(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/internal/control-center/coffee/action",
            payload,
        )

    async def _get_cached(self, path: str) -> tuple[dict[str, Any], str]:
        try:
            payload = await self._request("GET", path)
        except AliceControlError:
            cached = self._cache.get(path)
            if cached is None:
                raise
            return dict(cached), "stale"
        self._cache[path] = dict(payload)
        return payload, "live"

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.configured:
            raise AliceControlError("alice_control_not_configured")
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.alice_base_url,
                headers={
                    "Authorization": (
                        f"Bearer {self._settings.alice_control_center_token}"
                    )
                },
                timeout=self._settings.http_request_timeout_seconds,
                transport=self._transport,
            ) as client:
                response = await client.request(method, path, json=payload)
        except (httpx.HTTPError, TimeoutError) as exc:
            raise AliceControlError("alice_unavailable") from exc
        if response.status_code >= 400:
            code = "upstream_error"
            try:
                body = response.json()
                if isinstance(body, dict) and isinstance(body.get("error"), str):
                    code = body["error"]
            except ValueError:
                pass
            mapped = {
                400: 400,
                409: 409,
                429: 503,
                503: 503,
            }.get(response.status_code, 503)
            raise AliceControlError(code, mapped)
        try:
            body = response.json()
        except ValueError as exc:
            raise AliceControlError("invalid_upstream_response") from exc
        if not isinstance(body, dict):
            raise AliceControlError("invalid_upstream_response")
        return body
