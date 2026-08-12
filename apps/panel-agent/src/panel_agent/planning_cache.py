"""Bounded, browser-safe last-good Planning projection cache."""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Literal

from pydantic import field_validator

from .planning import PlanningProjection, StrictPlanningModel, validate_utc_timestamp


LOGGER = logging.getLogger(__name__)


class PlanningCacheDocument(StrictPlanningModel):
    cacheSchemaVersion: Literal[1]
    savedAt: str
    projection: PlanningProjection

    @field_validator("savedAt")
    @classmethod
    def validate_saved_at(cls, value: str) -> str:
        return validate_utc_timestamp(value, "planning.cache.savedAt")


class PlanningProjectionCache:
    """Persist only the normalized projection, using an atomic replacement."""

    def __init__(self, path: str | Path, *, max_bytes: int = 256 * 1024) -> None:
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
            raise ValueError("Planning cache size must be positive")
        self.path = Path(path)
        self.max_bytes = max_bytes

    def load(self) -> PlanningProjection | None:
        try:
            if not self.path.is_file() or self.path.stat().st_size > self.max_bytes:
                self._log_rejected("size_or_missing")
                return None
            raw = self.path.read_bytes()
            document = PlanningCacheDocument.model_validate_json(raw)
            return document.projection.model_copy(deep=True)
        except Exception:
            # Cache recovery is intentionally fail-closed.  The adapter will
            # publish an empty offline state and try the upstream again.
            self._log_rejected("invalid_document")
            return None

    def store(self, projection: PlanningProjection, *, saved_at: str) -> None:
        document = PlanningCacheDocument(
            cacheSchemaVersion=1,
            savedAt=saved_at,
            projection=projection,
        )
        encoded = document.model_dump_json(
            by_alias=True,
            exclude_none=False,
        ).encode("utf-8")
        if len(encoded) > self.max_bytes:
            raise ValueError("Planning projection cache exceeds configured size")

        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(
            f".{self.path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("xb") as handle:
                handle.write(encoded)
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass

    def _log_rejected(self, category: str) -> None:
        LOGGER.warning("planning_cache_rejected category=%s", category)
