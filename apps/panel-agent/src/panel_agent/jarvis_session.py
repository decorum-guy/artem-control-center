"""Deterministic local Jarvis session and greeting policy.

Only successful interactions advance this state.  The optional store contains
four timestamps/labels and never contains transcript, audio, or utterance
history.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from threading import RLock
from typing import Callable, Literal, Mapping
from zoneinfo import ZoneInfo


SESSION_SCHEMA_VERSION = "jarvis.session.v1"
SESSION_IDLE_THRESHOLD = timedelta(hours=3)
SESSION_IDLE_THRESHOLD_SECONDS = int(SESSION_IDLE_THRESHOLD.total_seconds())
DEFAULT_SESSION_TIMEZONE = "Europe/Moscow"
MAX_SESSION_STATE_BYTES = 4096
SESSION_STATE_FILENAME = "jarvis-session.json"

GreetingDaypart = Literal["morning", "day", "evening", "night"]


@dataclass(frozen=True)
class JarvisSessionState:
    last_successful_interaction_at: datetime | None = None
    last_greeting_at: datetime | None = None
    last_greeting_daypart: GreetingDaypart | None = None
    last_interaction_local_date: date | None = None


@dataclass(frozen=True)
class GreetingDecision:
    should_greet: bool
    greeting_daypart: GreetingDaypart
    new_session: bool


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Jarvis session clock values must be timezone-aware")
    return value.astimezone(timezone.utc)


def classify_daypart(local_time: datetime) -> GreetingDaypart:
    """Classify local wall-clock time using source-controlled boundaries."""

    hour = local_time.hour
    if hour < 5:
        return "night"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "day"
    return "evening"


class JarvisSessionStateStore:
    """Small atomic JSON store using the existing Panel runtime-root family."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = RLock()

    @classmethod
    def from_environment(cls) -> "JarvisSessionStateStore":
        configured = os.getenv("PANEL_JARVIS_SESSION_STATE_PATH", "").strip()
        if configured:
            return cls(configured)
        root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
        return cls(root / SESSION_STATE_FILENAME)

    @staticmethod
    def _empty_payload() -> dict[str, object]:
        return {
            "schemaVersion": SESSION_SCHEMA_VERSION,
            "lastSuccessfulInteractionAt": None,
            "lastGreetingAt": None,
            "lastGreetingDaypart": None,
            "lastInteractionLocalDate": None,
        }

    @staticmethod
    def _parse_datetime(value: object) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("invalid session timestamp")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return _utc(parsed)

    @staticmethod
    def _parse_date(value: object) -> date | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("invalid session date")
        return date.fromisoformat(value)

    @classmethod
    def _state_from_payload(cls, payload: object) -> JarvisSessionState:
        if not isinstance(payload, Mapping):
            raise ValueError("invalid session state")
        expected_keys = set(cls._empty_payload())
        if set(payload) != expected_keys or payload.get("schemaVersion") != SESSION_SCHEMA_VERSION:
            raise ValueError("invalid session state shape")
        daypart = payload.get("lastGreetingDaypart")
        if daypart not in {None, "morning", "day", "evening", "night"}:
            raise ValueError("invalid session daypart")
        return JarvisSessionState(
            last_successful_interaction_at=cls._parse_datetime(payload.get("lastSuccessfulInteractionAt")),
            last_greeting_at=cls._parse_datetime(payload.get("lastGreetingAt")),
            last_greeting_daypart=daypart,  # type: ignore[arg-type]
            last_interaction_local_date=cls._parse_date(payload.get("lastInteractionLocalDate")),
        )

    @staticmethod
    def _payload_from_state(state: JarvisSessionState) -> dict[str, object]:
        return {
            "schemaVersion": SESSION_SCHEMA_VERSION,
            "lastSuccessfulInteractionAt": state.last_successful_interaction_at.isoformat() if state.last_successful_interaction_at else None,
            "lastGreetingAt": state.last_greeting_at.isoformat() if state.last_greeting_at else None,
            "lastGreetingDaypart": state.last_greeting_daypart,
            "lastInteractionLocalDate": state.last_interaction_local_date.isoformat() if state.last_interaction_local_date else None,
        }

    def load(self) -> JarvisSessionState:
        with self._lock:
            try:
                if self.path.stat().st_size > MAX_SESSION_STATE_BYTES:
                    raise ValueError("session state too large")
                payload = json.loads(self.path.read_text(encoding="utf-8"))
                return self._state_from_payload(payload)
            except (FileNotFoundError, OSError, UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
                return JarvisSessionState()

    def save(self, state: JarvisSessionState) -> None:
        payload = self._payload_from_state(state)
        encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > MAX_SESSION_STATE_BYTES:
            raise ValueError("session state too large")
        temporary: Path | None = None
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=f".{self.path.name}.",
                    suffix=".tmp",
                    dir=self.path.parent,
                    delete=False,
                ) as handle:
                    temporary = Path(handle.name)
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(temporary, 0o600)
                os.replace(temporary, self.path)
                temporary = None
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass


class JarvisSession:
    """Stateful policy facade with explicit success/failure transitions."""

    def __init__(
        self,
        *,
        store: JarvisSessionStateStore | None = None,
        clock: Callable[[], datetime] | None = None,
        local_timezone: str | tzinfo = DEFAULT_SESSION_TIMEZONE,
    ) -> None:
        self.store = store
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._timezone = ZoneInfo(local_timezone) if isinstance(local_timezone, str) else local_timezone
        self._state = store.load() if store is not None else JarvisSessionState()
        self._lock = RLock()

    @property
    def state(self) -> JarvisSessionState:
        return self._state

    def successful_interaction(self, at: datetime | None = None) -> GreetingDecision:
        """Record one successful response and decide whether to greet.

        Callers must invoke this only after a response was successfully
        completed.  Classification, failed STT/wake attempts, and cancellation
        use the no-op methods below and do not consume eligibility.
        """

        with self._lock:
            now_utc = _utc(at or self._clock())
            local_now = now_utc.astimezone(self._timezone)
            local_date = local_now.date()
            previous_success = self._state.last_successful_interaction_at
            idle = (
                previous_success is not None
                and (now_utc - _utc(previous_success)) >= SESSION_IDLE_THRESHOLD
            )
            new_session = (
                previous_success is None
                or self._state.last_interaction_local_date != local_date
                or idle
            )
            should_greet = new_session
            daypart = classify_daypart(local_now)
            next_state = JarvisSessionState(
                last_successful_interaction_at=now_utc,
                last_greeting_at=now_utc if should_greet else self._state.last_greeting_at,
                last_greeting_daypart=daypart if should_greet else self._state.last_greeting_daypart,
                last_interaction_local_date=local_date,
            )
            if self.store is not None:
                self.store.save(next_state)
            self._state = next_state
            return GreetingDecision(
                should_greet=should_greet,
                greeting_daypart=daypart,
                new_session=new_session,
            )

    def failed_interaction(self) -> None:
        """Leave session state unchanged after a failed attempt."""

    def cancelled_interaction(self) -> None:
        """Leave session state unchanged after cancellation."""


__all__ = [
    "DEFAULT_SESSION_TIMEZONE",
    "GreetingDaypart",
    "GreetingDecision",
    "JarvisSession",
    "JarvisSessionState",
    "JarvisSessionStateStore",
    "MAX_SESSION_STATE_BYTES",
    "SESSION_IDLE_THRESHOLD",
    "SESSION_IDLE_THRESHOLD_SECONDS",
    "SESSION_SCHEMA_VERSION",
    "classify_daypart",
]
