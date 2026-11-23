"""Local metadata retention observations without track identifiers."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from .contracts import StationRetention, StationRetentionSample

LOGGER = logging.getLogger(__name__)


class StationRetentionRecorder:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._previous: tuple[str, str | None] = ("idle", None)
        self._active: tuple[str, float, str] | None = None
        try:
            self._samples = StationRetention.model_validate_json(path.read_bytes()).samples
        except (OSError, ValueError):
            self._samples = []

    def snapshot(self) -> StationRetention:
        return StationRetention(
            activeSince=self._active[2] if self._active else None,
            samples=self._samples,
        )

    def observe(self, status: str, track: str | None) -> bool:
        previous = self._previous
        current = (status, track)
        if previous == current:
            return False
        before = self._active, self._samples
        self._previous = current
        if self._active:
            active_track = self._active[0]
            if status in ("stale", "auth_required"):
                self._finish("signal_lost")
            elif status == "idle" and track is None:
                self._finish("cleared")
            elif track != active_track:
                self._finish("new_media")
            elif status == "playing":
                self._finish("resumed")
        if track and previous == ("playing", track) and status == "paused":
            self._active = (track, time.monotonic(), datetime.now(timezone.utc).isoformat())
        return before != (self._active, self._samples)

    def _finish(self, outcome: str) -> None:
        assert self._active is not None
        _, start, started_at = self._active
        self._active = None
        record = StationRetentionSample.model_validate({
            "startedAt": started_at,
            "endedAt": datetime.now(timezone.utc).isoformat(),
            "seconds": round(max(0, time.monotonic() - start), 1),
            "outcome": outcome,
        })
        self._samples = [record, *self._samples[:99]]
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            staged = self.path.with_suffix(".tmp")
            staged.write_text(StationRetention(samples=self._samples).model_dump_json(), encoding="utf-8")
            staged.replace(self.path)
        except OSError:
            LOGGER.warning("Station retention history could not be persisted")


def configured_retention() -> StationRetentionRecorder | None:
    if os.getenv("PANEL_STATION_RETENTION_ENABLED", "").strip().lower() != "true":
        return None
    local = os.getenv("LOCALAPPDATA", "").strip()
    root = Path(local) / "ArtemControlCenter" if local else Path.home() / ".artem-control-center"
    return StationRetentionRecorder(root / "station-retention.json")
