from __future__ import annotations

import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from panel_agent.jarvis_session import (
    DEFAULT_SESSION_TIMEZONE,
    MAX_SESSION_STATE_BYTES,
    SESSION_IDLE_THRESHOLD_SECONDS,
    SESSION_SCHEMA_VERSION,
    JarvisSession,
    JarvisSessionStateStore,
    classify_daypart,
)


MOSCOW = ZoneInfo(DEFAULT_SESSION_TIMEZONE)


def local_time(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=MOSCOW)


def test_first_successful_interaction_is_greeting_eligible():
    session = JarvisSession()

    decision = session.successful_interaction(local_time("2026-08-30T10:00:00"))

    assert decision.should_greet is True
    assert decision.new_session is True
    assert decision.greeting_daypart == "morning"
    assert session.state.last_interaction_local_date.isoformat() == "2026-08-30"


def test_second_immediate_successful_interaction_is_not_greeting_eligible():
    session = JarvisSession()
    session.successful_interaction(local_time("2026-08-30T10:00:00"))

    decision = session.successful_interaction(local_time("2026-08-30T10:01:00"))

    assert decision.should_greet is False
    assert decision.new_session is False
    assert decision.greeting_daypart == "morning"


def test_failed_interaction_does_not_consume_first_greeting():
    session = JarvisSession()
    session.failed_interaction()

    decision = session.successful_interaction(local_time("2026-08-30T10:00:00"))

    assert decision.should_greet is True
    assert session.state.last_successful_interaction_at == local_time("2026-08-30T10:00:00").astimezone(timezone.utc)


def test_cancelled_interaction_does_not_consume_first_greeting():
    session = JarvisSession()
    session.cancelled_interaction()

    decision = session.successful_interaction(local_time("2026-08-30T10:00:00"))

    assert decision.should_greet is True


def test_exactly_three_hours_idle_starts_a_new_session():
    session = JarvisSession()
    session.successful_interaction(local_time("2026-08-30T10:00:00"))

    decision = session.successful_interaction(
        local_time("2026-08-30T13:00:00")
    )

    assert SESSION_IDLE_THRESHOLD_SECONDS == 3 * 60 * 60
    assert decision.should_greet is True
    assert decision.new_session is True


def test_less_than_three_hours_idle_stays_in_the_existing_session():
    session = JarvisSession()
    session.successful_interaction(local_time("2026-08-30T10:00:00"))

    decision = session.successful_interaction(local_time("2026-08-30T12:59:59"))

    assert decision.should_greet is False
    assert decision.new_session is False


def test_local_date_rollover_starts_a_new_session():
    session = JarvisSession()
    session.successful_interaction(local_time("2026-08-30T23:59:00"))

    decision = session.successful_interaction(local_time("2026-08-31T00:01:00"))

    assert decision.should_greet is True
    assert decision.new_session is True


@pytest.mark.parametrize(
    ("local_value", "expected"),
    [
        ("2026-08-30T04:59:00", "night"),
        ("2026-08-30T05:00:00", "morning"),
        ("2026-08-30T11:59:59", "morning"),
        ("2026-08-30T12:00:00", "day"),
        ("2026-08-30T17:59:59", "day"),
        ("2026-08-30T18:00:00", "evening"),
        ("2026-08-30T23:59:59", "evening"),
        ("2026-08-31T00:00:00", "night"),
    ],
)
def test_daypart_boundaries_are_explicit(local_value, expected):
    assert classify_daypart(local_time(local_value)) == expected


def test_timezone_conversion_uses_local_wall_clock_deterministically():
    utc_before_day_boundary = datetime(2026, 8, 30, 8, 59, tzinfo=timezone.utc)
    utc_at_day_boundary = datetime(2026, 8, 30, 9, 0, tzinfo=timezone.utc)

    assert classify_daypart(utc_before_day_boundary.astimezone(MOSCOW)) == "morning"
    assert classify_daypart(utc_at_day_boundary.astimezone(MOSCOW)) == "day"


def test_persistent_state_survives_restart_without_transcript_or_audio(tmp_path):
    path = tmp_path / "jarvis-session.json"
    store = JarvisSessionStateStore(path)
    first = JarvisSession(store=store)
    first.successful_interaction(local_time("2026-08-30T10:00:00"))

    persisted = json.loads(path.read_text(encoding="utf-8"))
    restarted = JarvisSession(store=JarvisSessionStateStore(path))
    decision = restarted.successful_interaction(local_time("2026-08-30T10:01:00"))

    assert decision.should_greet is False
    assert set(persisted) == {
        "schemaVersion",
        "lastSuccessfulInteractionAt",
        "lastGreetingAt",
        "lastGreetingDaypart",
        "lastInteractionLocalDate",
    }
    assert persisted["schemaVersion"] == SESSION_SCHEMA_VERSION
    assert all("transcript" not in key.lower() and "audio" not in key.lower() for key in persisted)
    assert all("кофе" not in str(value).lower() for value in persisted.values())


def test_failed_and_cancelled_interactions_do_not_write_persistent_state(tmp_path):
    path = tmp_path / "jarvis-session.json"
    store = JarvisSessionStateStore(path)
    session = JarvisSession(store=store)

    session.failed_interaction()
    assert not path.exists()
    session.cancelled_interaction()
    assert not path.exists()

    session.successful_interaction(local_time("2026-08-30T10:00:00"))
    before = path.read_bytes()
    session.failed_interaction()
    session.cancelled_interaction()

    assert path.read_bytes() == before


def test_store_rejects_extra_or_oversized_state_fail_closed(tmp_path):
    path = tmp_path / "jarvis-session.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": SESSION_SCHEMA_VERSION,
                "lastSuccessfulInteractionAt": None,
                "lastGreetingAt": None,
                "lastGreetingDaypart": None,
                "lastInteractionLocalDate": None,
                "transcript": "must not be stored",
            }
        ),
        encoding="utf-8",
    )
    assert JarvisSessionStateStore(path).load().last_successful_interaction_at is None

    path.write_bytes(b"x" * (MAX_SESSION_STATE_BYTES + 1))
    assert JarvisSessionStateStore(path).load().last_successful_interaction_at is None


def test_store_uses_existing_runtime_root_family(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.delenv("PANEL_JARVIS_SESSION_STATE_PATH", raising=False)

    store = JarvisSessionStateStore.from_environment()

    assert store.path == tmp_path / "ArtemControlCenter" / "jarvis-session.json"
