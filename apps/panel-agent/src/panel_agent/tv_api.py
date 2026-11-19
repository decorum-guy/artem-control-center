"""The narrow TV contract shared by the loopback panel and phone ingress."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal, Optional
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from fastapi import APIRouter, Request as Incoming
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

TVAction = Literal[
    "up", "down", "left", "right", "ok", "back", "home",
    "volume-down", "volume-up", "mute", "screen-on", "screen-off",
    "open-app", "open-link", "saved",
]


class TVCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: TVAction
    app: Optional[str] = Field(None, max_length=80)
    url: Optional[str] = Field(None, max_length=2048)
    id: Optional[str] = Field(None, max_length=80)


class TVExecutorClient:
    def __init__(self, token_file: Path | None, port: int = 38455) -> None:
        self.token_file = token_file
        self.base = f"http://127.0.0.1:{port}/v1/tv/"
        self.opener = build_opener(ProxyHandler({}))

    def invoke(self, command: TVCommand | None = None) -> tuple[int, dict]:
        unavailable = {"outcome": "offline"} if command else {"availability": "offline"}
        if self.token_file is None:
            return 503, unavailable
        try:
            token = self.token_file.read_text(encoding="utf-8-sig").strip()
            if not token:
                return 503, unavailable
        except OSError:
            return 503, unavailable
        path = "command" if command else "status"
        data = command.model_dump_json(exclude_none=True).encode() if command else None
        try:
            request = Request(self.base + path, data, {
                "Authorization": "Bearer " + token, "Content-Type": "application/json",
            })
            try:
                response = self.opener.open(request, timeout=38 if command else 3)
            except HTTPError as error:
                if error.code not in {400, 409, 502, 503}:
                    error.close()
                    return 503, unavailable
                response = error
            with response:
                body = json.loads(response.read(32768))
                if not isinstance(body, dict):
                    raise ValueError("Invalid TV response")
                return response.code, body
        except (OSError, ValueError):
            return 503, {"outcome": "unconfirmed"} if command else unavailable


def same_local_browser(request: Incoming) -> bool:
    if request.headers.get("x-panel-tv") != "1":
        return False
    origin = request.headers.get("origin")
    if not origin:
        return request.headers.get("sec-fetch-site") != "cross-site"
    try:
        address = urlsplit(origin)
        return (address.scheme in {"http", "https"}
                and address.hostname in {"127.0.0.1", "localhost", "::1"}
                and address.netloc == request.headers.get("host"))
    except ValueError:
        return False


def build_tv_router(write_allowed) -> APIRouter:
    router = APIRouter(prefix="/api/tv")
    raw = os.getenv("PANEL_TV_EXECUTOR_TOKEN_FILE")
    executor = TVExecutorClient(Path(raw) if raw else None)

    @router.get("/status")
    def status():
        code, payload = executor.invoke()
        return JSONResponse(payload, code, headers={"Cache-Control": "no-store"})

    @router.post("/command")
    def command(body: TVCommand, request: Incoming):
        if not write_allowed() or not same_local_browser(request):
            return JSONResponse({"outcome": "unauthorized"}, 403)
        code, payload = executor.invoke(body)
        return JSONResponse(payload, code, headers={"Cache-Control": "no-store"})

    return router
