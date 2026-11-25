"""Normalized, provider-neutral playlist metadata and private continuation state."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def text(value: Any) -> str:
    return " ".join(value.split())[:240] if isinstance(value, str) else ""


@dataclass(frozen=True)
class Playlist:
    key: str
    title: str
    kind: str
    artwork: str | None = None
    count: int | None = None


@dataclass(frozen=True)
class Recording:
    track_id: str | None
    title: str
    artists: tuple[str, ...]
    album: str | None = None
    duration: int | None = None
    artwork: str | None = None
    playable: bool = True
    position_id: str | None = None
    album_id: str | None = None
    explicit: bool | None = None


@dataclass(frozen=True)
class Continuation:
    value: str | int
    kind: str


@dataclass(frozen=True)
class ProviderPage:
    rows: tuple[Playlist | Recording, ...]
    continuation: Continuation | None = None
