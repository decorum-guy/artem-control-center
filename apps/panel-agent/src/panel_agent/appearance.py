"""Durable, panel-local V3 color preferences for ephemeral kiosk profiles."""

import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, ValidationError


class Appearance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accent: Literal["ice", "iris", "lagoon", "rose"] | None = None
    colorMode: Literal["day", "night"] | None = None


class AppearanceStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = Lock()

    def read(self) -> Appearance:
        try:
            with self.path.open("rb") as stream:
                data = stream.read(1025)
                if len(data) > 1024:
                    raise HTTPException(503, "appearance_unavailable")
                return Appearance.model_validate_json(data)
        except FileNotFoundError:
            return Appearance()
        except (ValidationError, OSError):
            raise HTTPException(503, "appearance_unavailable") from None

    def patch(self, patch: Appearance) -> Appearance:
        changes = patch.model_dump(exclude_unset=True)
        if not changes or None in changes.values():
            raise HTTPException(422, "invalid_appearance")
        with self.lock:
            value = self.read().model_copy(update=changes)
            temporary = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with NamedTemporaryFile(dir=self.path.parent, delete=False, mode="w", encoding="utf-8") as file:
                    temporary = Path(file.name)
                    file.write(value.model_dump_json(exclude_none=True))
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, self.path)
            except OSError:
                raise HTTPException(503, "appearance_unavailable") from None
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
            return value


def build_appearance_router(writes_allowed):
    root = Path(os.environ.get("LOCALAPPDATA") or Path.cwd() / ".runtime") / "ArtemControlCenter"
    store = AppearanceStore(root / "appearance.json")
    router = APIRouter(prefix="/api/v1/settings")

    @router.get("/appearance")
    def get_appearance(response: Response) -> Appearance:
        response.headers["Cache-Control"] = "no-store"
        return store.read()

    @router.patch("/appearance")
    def patch_appearance(patch: Appearance, response: Response) -> Appearance:
        if not writes_allowed():
            raise HTTPException(403, "appearance_write_disabled")
        response.headers["Cache-Control"] = "no-store"
        return store.patch(patch)

    return router
