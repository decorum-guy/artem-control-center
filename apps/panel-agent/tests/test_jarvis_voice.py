from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from panel_agent.jarvis_voice import (
    BoundedPcmBuffer, VoiceHealth, VoicePipeline, VoiceRuntimeConfig, VoiceSnapshot,
    VoiceState, VoiceStateMachine, VoiceTurnResult,
)

VOICE_WORKER_SOURCE = Path(__file__).resolve().parents[2] / "jarvis-voice" / "src"
if str(VOICE_WORKER_SOURCE) not in sys.path:
    sys.path.insert(0, str(VOICE_WORKER_SOURCE))
from jarvis_voice_worker.__main__ import microphone_device_from_environment


FRAME = b"\x00\x00" * 1_280  # 80 ms of canonical PCM


@pytest.fixture(autouse=True)
def restore_sync_test_loop():
    """Keep legacy synchronous tests' implicit event-loop contract intact."""
    yield
    try:
        existing = asyncio.get_event_loop()
        if not existing.is_running():
            existing.close()
    except RuntimeError:
        pass
    asyncio.set_event_loop(asyncio.new_event_loop())


class Audio:
    def __init__(self, frames: list[bytes]) -> None:
        self._frames = frames

    async def frames(self) -> AsyncIterator[bytes]:
        for frame in self._frames:
            yield frame


class Wake:
    def __init__(self, at: int | None) -> None:
        self.at = at
        self.calls = 0

    async def detect(self, _pcm: bytes) -> bool:
        self.calls += 1
        return self.calls == self.at


class Vad:
    def __init__(self, speech_calls: set[int]) -> None:
        self._speech_calls = speech_calls
        self.calls = 0

    async def is_speech(self, _pcm: bytes) -> bool:
        self.calls += 1
        return self.calls in self._speech_calls


class Stt:
    def __init__(self, value: str = "Который час?", failure: Exception | None = None) -> None:
        self.value, self.failure, self.calls = value, failure, 0

    async def recognize(self, _pcm: bytes) -> str:
        self.calls += 1
        if self.failure:
            raise self.failure
        return self.value


class Turns:
    def __init__(self, navigation: str | None = None) -> None:
        self.values: list[str] = []
        self.navigation = navigation

    async def turn(self, text: str) -> VoiceTurnResult:
        self.values.append(text)
        return VoiceTurnResult("Сейчас 12:34.", self.navigation)  # type: ignore[arg-type]


class Publisher:
    def __init__(self) -> None:
        self.snapshots: list[VoiceSnapshot] = []

    async def publish(self, snapshot: VoiceSnapshot) -> None:
        self.snapshots.append(snapshot)


class Speech:
    def __init__(self, failure: Exception | None = None) -> None:
        self.failure = failure
        self.values: list[str] = []

    async def speak(self, text: str) -> None:
        self.values.append(text)
        if self.failure:
            raise self.failure


class Lock:
    def __init__(self, locked: bool = False) -> None:
        self.locked = locked

    def is_locked(self) -> bool:
        return self.locked


class Clock:
    def __init__(self) -> None:
        self.value = 0

    def monotonic_ms(self) -> int:
        self.value += 10
        return self.value


def pipeline(*, wake_at: int | None = 1, vad_speech: set[int] | None = None,
             stt: Stt | None = None, lock: Lock | None = None, navigation: str | None = None,
             speech: Speech | None = None):
    publisher, turns = Publisher(), Turns(navigation)
    subject = VoicePipeline(
        config=VoiceRuntimeConfig(enabled=True, configured=True, trailing_silence_ms=160, cooldown_ms=1),
        wake=Wake(wake_at), vad=Vad(vad_speech or {1}), recognizer=stt or Stt(), turns=turns,
        publisher=publisher, lock=lock or Lock(), clock=Clock(), speech_output=speech,
    )
    return subject, publisher, turns


def test_ring_buffer_has_exact_bound_and_no_file_interface():
    subject = BoundedPcmBuffer(500)
    subject.append(b"a" * 20_000)
    assert subject.size_bytes == 16_000
    assert subject.snapshot() == b"a" * 16_000
    assert not hasattr(subject, "path")


def test_state_machine_rejects_stale_invalid_transition_and_monotonically_sequences():
    machine = VoiceStateMachine(enabled=True, configured=True)
    assert machine.transition(VoiceState.IDLE) is None
    first = machine.transition(VoiceState.STARTING)
    second = machine.transition(VoiceState.IDLE, health=VoiceHealth.HEALTHY)
    assert first and second and (first.sequence, second.sequence) == (1, 2)
    assert machine.transition(VoiceState.SUBMITTING) is None


def test_wake_vad_endpoint_stt_and_one_canonical_turn():
    subject, publisher, turns = pipeline()
    asyncio.run(subject.run(Audio([FRAME, FRAME, FRAME, FRAME])))
    assert turns.values == ["Который час?"]
    assert [item.state for item in publisher.snapshots] == [
        VoiceState.STARTING, VoiceState.IDLE, VoiceState.WAKE_DETECTED, VoiceState.LISTENING,
        VoiceState.TRANSCRIBING, VoiceState.SUBMITTING, VoiceState.READY, VoiceState.COOLDOWN, VoiceState.IDLE,
    ]
    ready = next(item for item in publisher.snapshots if item.state is VoiceState.READY)
    assert ready.recognized_text == "Который час?" and ready.response_text == "Сейчас 12:34."


def test_optional_speech_receives_exact_canonical_response_and_adds_speaking_state():
    speech = Speech()
    subject, publisher, turns = pipeline(speech=speech)
    asyncio.run(subject.run(Audio([FRAME, FRAME, FRAME, FRAME])))
    assert turns.values == ["Который час?"]
    assert speech.values == ["Сейчас 12:34."]
    assert [item.state for item in publisher.snapshots] == [
        VoiceState.STARTING, VoiceState.IDLE, VoiceState.WAKE_DETECTED, VoiceState.LISTENING,
        VoiceState.TRANSCRIBING, VoiceState.SUBMITTING, VoiceState.SPEAKING,
        VoiceState.READY, VoiceState.COOLDOWN, VoiceState.IDLE,
    ]


def test_speech_failure_preserves_canonical_response_and_navigation_at_ready():
    speech = Speech(RuntimeError("provider exception must not leave the worker"))
    subject, publisher, _ = pipeline(navigation="/settings", speech=speech)
    asyncio.run(subject.run(Audio([FRAME, FRAME, FRAME, FRAME])))
    ready = next(item for item in publisher.snapshots if item.state is VoiceState.READY)
    assert speech.values == ["Сейчас 12:34."]
    assert ready.response_text == "Сейчас 12:34." and ready.navigation == "/settings"
    assert ready.health is VoiceHealth.DEGRADED and ready.safe_error_code == "tts_failed"
    assert VoiceState.ERROR not in [item.state for item in publisher.snapshots]
    assert all("provider exception" not in str(item) for item in publisher.snapshots)


def test_canonical_navigation_survives_voice_pipeline_and_arbitrary_paths_do_not():
    accepted, accepted_updates, _ = pipeline(navigation="/settings")
    asyncio.run(accepted.run(Audio([FRAME] * 4)))
    ready = next(item for item in accepted_updates.snapshots if item.state is VoiceState.READY)
    assert ready.navigation == "/settings"

    rejected, rejected_updates, _ = pipeline(navigation="javascript:alert(1)")
    asyncio.run(rejected.run(Audio([FRAME] * 4)))
    ready = next(item for item in rejected_updates.snapshots if item.state is VoiceState.READY)
    assert ready.navigation is None


def test_no_wake_does_not_start_stt_or_turn():
    subject, publisher, turns = pipeline(wake_at=None)
    asyncio.run(subject.run(Audio([FRAME] * 4)))
    assert turns.values == []
    assert [item.state for item in publisher.snapshots] == [VoiceState.STARTING, VoiceState.IDLE]


def test_lock_blocks_semantic_turn_and_does_not_publish_owner_text():
    subject, publisher, turns = pipeline(lock=Lock(True))
    asyncio.run(subject.run(Audio([FRAME] * 4)))
    assert turns.values == []
    assert all(item.recognized_text is None for item in publisher.snapshots)


def test_empty_and_failed_stt_are_bounded_errors_without_turn():
    empty, empty_updates, empty_turns = pipeline(stt=Stt("   "))
    asyncio.run(empty.run(Audio([FRAME] * 4)))
    assert empty_turns.values == []
    assert any(item.safe_error_code == "empty_transcript" for item in empty_updates.snapshots)

    failed, failed_updates, failed_turns = pipeline(stt=Stt(failure=RuntimeError("owner text must not leak")))
    asyncio.run(failed.run(Audio([FRAME] * 4)))
    assert failed_turns.values == []
    assert any(item.safe_error_code == "stt_failed" for item in failed_updates.snapshots)
    assert all("owner text" not in str(item) for item in failed_updates.snapshots)


def test_disabled_never_opens_audio_or_attempts_models():
    subject, publisher, turns = pipeline()
    subject._config = VoiceRuntimeConfig(enabled=False)  # exercise safe default before adapters
    asyncio.run(subject.run(Audio([FRAME])))
    assert turns.values == []
    assert publisher.snapshots == [VoiceSnapshot("jarvis.voice.v1", False, False, VoiceHealth.DISABLED, VoiceState.DISABLED, 0)]


def test_absent_microphone_environment_uses_default_device(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PANEL_JARVIS_MIC_DEVICE", raising=False)
    assert microphone_device_from_environment() is None


def test_cancel_transitions_to_cooldown_without_persistence():
    subject, publisher, _ = pipeline()
    asyncio.run(subject._transition(VoiceState.STARTING, health=VoiceHealth.STARTING))
    asyncio.run(subject._transition(VoiceState.IDLE, health=VoiceHealth.HEALTHY))
    asyncio.run(subject._transition(VoiceState.WAKE_DETECTED))
    asyncio.run(subject._transition(VoiceState.LISTENING))
    asyncio.run(subject.cancel())
    assert publisher.snapshots[-3].safe_error_code == "cancelled"
    assert publisher.snapshots[-1].state is VoiceState.IDLE
