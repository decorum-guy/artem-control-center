from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse


NO_STORE_HEADERS = {"Cache-Control": "no-store"}
IMMUTABLE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}


def configured_dashboard_root() -> Path | None:
    raw = os.getenv("PANEL_DASHBOARD_DIST", "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser().resolve()
    if not root.is_dir() or not (root / "index.html").is_file():
        raise RuntimeError(f"Invalid PANEL_DASHBOARD_DIST: {root}")
    return root


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def install_dashboard_routes(app: FastAPI, root: Path | None = None) -> bool:
    dashboard_root = root.resolve() if root is not None else configured_dashboard_root()
    if dashboard_root is None:
        return False
    index_path = dashboard_root / "index.html"
    if not dashboard_root.is_dir() or not index_path.is_file():
        raise RuntimeError(f"Dashboard build is incomplete: {dashboard_root}")

    @app.get("/{asset_path:path}", include_in_schema=False)
    async def dashboard_asset(asset_path: str):
        candidate = (dashboard_root / asset_path).resolve()
        if not _inside(dashboard_root, candidate):
            raise HTTPException(status_code=404)

        if candidate.is_file():
            headers = (
                IMMUTABLE_HEADERS
                if asset_path.startswith("assets/")
                else NO_STORE_HEADERS
            )
            return FileResponse(candidate, headers=headers)

        first_segment = asset_path.split("/", 1)[0]
        if first_segment in {"api", "health"} or Path(asset_path).suffix:
            raise HTTPException(status_code=404)

        return FileResponse(index_path, headers=NO_STORE_HEADERS)

    return True
