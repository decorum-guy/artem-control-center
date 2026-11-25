"""Match typed music catalog entries to an immutable Station track."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
VERSION = re.compile(
    r"\b(?:live|remix|mix|cover|acoustic|instrumental|karaoke|sped up|slowed|nightcore|"
    r"remaster(?:ed)?|demo|radio edit|extended|version|концерт|лайв|ремикс|кавер|акустика|"
    r"инструментал|караоке|версия|ремастер)\b"
)
ARTIST_DELIMITER = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|при участии)\s+|\s*[,;]\s*", re.IGNORECASE)


@dataclass(frozen=True)
class Track:
    source_id: str | None
    title: str
    artist: str | None
    duration: int | None
    album: str | None
    generation: int
    started_at: datetime
    observed_at: datetime


@dataclass(frozen=True)
class Candidate:
    video_id: str
    title: str
    artists: tuple[str, ...]
    album: str | None
    duration: int | None

    @property
    def artist(self) -> str:
        return ", ".join(self.artists)


def normalize(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")))


def version_labels(text: str) -> tuple[str, ...]:
    return tuple(sorted(set(VERSION.findall(normalize(text)))))


def artists(text: str) -> set[str]:
    return {normalized for name in ARTIST_DELIMITER.split(text) if (normalized := normalize(name))}


def base_title(title: str) -> str:
    # Search may omit punctuation or add a parenthesized version label.
    # A difference in labels can surface a choice, never an automatic save.
    text = re.sub(r"\([^)]*\)|\[[^]]*\]", "", title) if version_labels(title) else title
    return normalize(text)


def match(track: Track, candidates: list[Candidate]) -> tuple[Candidate | None, list[Candidate]]:
    wanted_title = normalize(track.title)
    wanted_artists = artists(track.artist or "")
    if not wanted_title or not wanted_artists:
        return None, []
    plausible: list[Candidate] = []
    exact: list[Candidate] = []
    for item in {row.video_id: row for row in candidates}.values():
        same_title = normalize(item.title) == wanted_title
        if not same_title and base_title(item.title) != base_title(track.title):
            continue
        actual_artists = {normalize(name) for name in item.artists}
        if not wanted_artists.intersection(actual_artists):
            continue
        duration_matches = track.duration is not None and item.duration is not None and abs(track.duration - item.duration) <= 3
        album_matches = bool(track.album and item.album and normalize(track.album) == normalize(item.album))
        duration_conflicts = track.duration is not None and item.duration is not None and not duration_matches
        album_conflicts = bool(track.album and item.album and not album_matches)
        same_version = version_labels(track.title) == version_labels(item.title)
        plausible.append(item)
        if (same_title and same_version and wanted_artists == actual_artists
                and (duration_matches or album_matches) and not duration_conflicts and not album_conflicts):
            exact.append(item)
    # A second exact title/artist/version with incomplete evidence can still
    # be a different recording hidden behind the same catalog label.
    if len(exact) == 1 and len(plausible) == 1:
        return exact[0], []
    return None, plausible[:5]
