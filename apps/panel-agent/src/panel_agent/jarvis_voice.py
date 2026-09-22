"""Bounded, local-only Jarvis voice ingress primitives.

This module deliberately has no microphone or ML imports.  The optional
Windows worker supplies those adapters from its separate virtual environment;
the Panel Agent and its normal test/runtime environment stay lightweight.
Audio and recognized text live only in process memory.
"""

from __future__ import annotations

import asyncio
import sys
from array import array
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from .jarvis_navigation import NavigationPath, is_jarvis_navigation


SAMPLE_RATE_HZ = 16_000
PCM_BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2  # signed 16-bit, mono
VOICE_ACTIVITY_PUBLISH_MS = 160
PCM_ACTIVITY_REFERENCE_RMS = 512.0


class VoiceState(str, Enum):
    DISABLED = "disabled"
    STARTING = "starting"
    IDLE = "idle"
    WAKE_DETECTED = "wake_detected"
    LISTENING = "listening"
    TRANSCRIBING = "transcribing"
    SUBMITTING = "submitting"
    SPEAKING = "speaking"
    READY = "ready"
    ERROR = "error"
    COOLDOWN = "cooldown"


class VoiceHealth(str, Enum):
    DISABLED = "disabled"
    UNCONFIGURED = "unconfigured"
    STARTING = "starting"
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


SAFE_ERROR_CODES = frozenset({
    "microphone_unavailable", "wake_dependency_missing", "wake_model_missing",
    "stt_dependency_missing", "stt_model_missing", "audio_stream_failed",
    "stt_failed", "stt_timeout", "turn_failed", "empty_transcript",
    "interaction_locked", "wrong_session", "cancelled", "tts_failed",
})


@dataclass(frozen=True)
class VoiceRuntimeConfig:
    """Software defaults only; Samsung has not physically accepted their tuning."""

    enabled: bool = False
    configured: bool = False
    pre_roll_ms: int = 500
    speech_onset_timeout_ms: int = 3_000
    max_utterance_ms: int = 12_000
    trailing_silence_ms: int = 800
    cooldown_ms: int = 1_200
    stt_timeout_ms: int = 30_000
    speech_timeout_ms: int = 45_000

    def __post_init__(self) -> None:
        for value in (self.pre_roll_ms, self.speech_onset_timeout_ms,
                      self.max_utterance_ms, self.trailing_silence_ms, self.cooldown_ms, self.stt_timeout_ms):
            if value <= 0:
                raise ValueError("Voice timing values must be positive")
        if self.pre_roll_ms > 2_000 or self.max_utterance_ms > 30_000:
            raise ValueError("Voice timing values exceed bounded safety limits")
        if not 1_000 <= self.speech_timeout_ms <= 90_000:
            raise ValueError("Speech timeout must remain bounded")


@dataclass(frozen=True)
class VoiceSnapshot:
    schema_version: str
    enabled: bool
    configured: bool
    health: VoiceHealth
    state: VoiceState
    sequence: int
    recognized_text: str | None = None
    response_text: str | None = None
    safe_error_code: str | None = None
    wake_latency_ms: int | None = None
    stt_latency_ms: int | None = None
    navigation: NavigationPath | None = None
    input_level: float | None = None


def pcm_input_level(pcm_16khz_mono: bytes) -> float:
    """Return a bounded UI activity level without persisting or exposing PCM."""
    usable = len(pcm_16khz_mono) - (len(pcm_16khz_mono) % 2)
    if usable <= 0:
        return 0.0
    samples = array("h")
    samples.frombytes(pcm_16khz_mono[:usable])
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return 0.0
    rms = (sum(int(sample) * int(sample) for sample in samples) / len(samples)) ** 0.5
    return min(1.0, max(0.0, rms / PCM_ACTIVITY_REFERENCE_RMS))


class AudioInput(Protocol):
    """Yield canonical 16 kHz mono signed-16-bit PCM frames, in memory only."""

    def frames(self) -> AsyncIterator[bytes]: ...


class WakeDetector(Protocol):
    async def detect(self, pcm_16khz_mono: bytes) -> bool: ...


class VoiceActivityDetector(Protocol):
    async def is_speech(self, pcm_16khz_mono: bytes) -> bool: ...


class SpeechRecognizer(Protocol):
    async def recognize(self, pcm_16khz_mono: bytes) -> str: ...


class SpeechOutput(Protocol):
    """Optional output receives only an already-canonical Jarvis response."""

    async def speak(self, text: str) -> None: ...


class JarvisTurnClient(Protocol):
    async def turn(self, text: str) -> "VoiceTurnResult": ...


class VoiceStatePublisher(Protocol):
    async def publish(self, snapshot: VoiceSnapshot) -> None: ...


class InteractionLockSource(Protocol):
    def is_locked(self) -> bool: ...


class Clock(Protocol):
    def monotonic_ms(self) -> int: ...


@dataclass(frozen=True)
class VoiceTurnResult:
    response_text: str
    navigation: NavigationPath | None = None


class BoundedPcmBuffer:
    """A byte-bounded in-memory ring; it has no filesystem operations."""

    def __init__(self, capacity_ms: int) -> None:
        if capacity_ms <= 0:
            raise ValueError("capacity_ms must be positive")
        self._capacity = PCM_BYTES_PER_SECOND * capacity_ms // 1_000
        self._frames: deque[bytes] = deque()
        self._size = 0

    def append(self, pcm: bytes) -> None:
        if not pcm:
            return
        if len(pcm) >= self._capacity:
            self._frames.clear()
            self._frames.append(bytes(pcm[-self._capacity:]))
            self._size = self._capacity
            return
        self._frames.append(bytes(pcm))
        self._size += len(pcm)
        while self._size > self._capacity:
            excess = self._size - self._capacity
            first = self._frames.popleft()
            if len(first) <= excess:
                self._size -= len(first)
            else:
                self._frames.appendleft(first[excess:])
                self._size -= excess

    def snapshot(self) -> bytes:
        return b"".join(self._frames)

    @property
    def size_bytes(self) -> int:
        return self._size


_LEGAL_TRANSITIONS: dict[VoiceState, frozenset[VoiceState]] = {
    VoiceState.DISABLED: frozenset({VoiceState.STARTING}),
    VoiceState.STARTING: frozenset({VoiceState.IDLE, VoiceState.ERROR, VoiceState.DISABLED}),
    VoiceState.IDLE: frozenset({VoiceState.WAKE_DETECTED, VoiceState.ERROR, VoiceState.DISABLED}),
    VoiceState.WAKE_DETECTED: frozenset({VoiceState.LISTENING, VoiceState.COOLDOWN, VoiceState.ERROR}),
    VoiceState.LISTENING: frozenset({VoiceState.TRANSCRIBING, VoiceState.COOLDOWN, VoiceState.ERROR}),
    VoiceState.TRANSCRIBING: frozenset({VoiceState.SUBMITTING, VoiceState.COOLDOWN, VoiceState.ERROR}),
    VoiceState.SUBMITTING: frozenset({VoiceState.SPEAKING, VoiceState.READY, VoiceState.COOLDOWN, VoiceState.ERROR}),
    VoiceState.SPEAKING: frozenset({VoiceState.READY, VoiceState.COOLDOWN, VoiceState.ERROR}),
    VoiceState.READY: frozenset({VoiceState.COOLDOWN, VoiceState.IDLE}),
    VoiceState.ERROR: frozenset({VoiceState.COOLDOWN, VoiceState.IDLE, VoiceState.DISABLED}),
    VoiceState.COOLDOWN: frozenset({VoiceState.IDLE, VoiceState.DISABLED}),
}


def is_legal_voice_transition(current: VoiceState, next_state: VoiceState) -> bool:
    return next_state in _LEGAL_TRANSITIONS[current]


class VoiceStateMachine:
    """Monotonic state transitions; invalid/stale transitions never mutate state."""

    def __init__(self, *, enabled: bool, configured: bool) -> None:
        self.enabled = enabled
        self.configured = configured
        self.state = VoiceState.DISABLED
        self.health = VoiceHealth.DISABLED if not enabled else VoiceHealth.UNCONFIGURED
        self.sequence = 0

    def transition(self, state: VoiceState, *, health: VoiceHealth | None = None,
                   recognized_text: str | None = None, response_text: str | None = None,
                   safe_error_code: str | None = None, wake_latency_ms: int | None = None,
                   stt_latency_ms: int | None = None, navigation: NavigationPath | None = None,
                   input_level: float | None = None) -> VoiceSnapshot | None:
        if not is_legal_voice_transition(self.state, state):
            return None
        if safe_error_code is not None and safe_error_code not in SAFE_ERROR_CODES:
            raise ValueError("Unsafe voice error code")
        if input_level is not None and not 0.0 <= input_level <= 1.0:
            raise ValueError("Voice input level must be bounded")
        self.state = state
        if health is not None:
            self.health = health
        self.sequence += 1
        return VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=self.enabled, configured=self.configured,
            health=self.health, state=state, sequence=self.sequence,
            recognized_text=recognized_text, response_text=response_text,
            safe_error_code=safe_error_code, wake_latency_ms=wake_latency_ms,
            stt_latency_ms=stt_latency_ms, navigation=navigation, input_level=input_level,
        )

    def listening_activity(self, input_level: float) -> VoiceSnapshot | None:
        if self.state is not VoiceState.LISTENING:
            return None
        if not 0.0 <= input_level <= 1.0:
            raise ValueError("Voice input level must be bounded")
        self.sequence += 1
        return VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=self.enabled, configured=self.configured,
            health=self.health, state=self.state, sequence=self.sequence, input_level=input_level,
        )


class VoicePipeline:
    """Adapter-driven local audio pipeline with bounded capture and one turn path."""

    def __init__(self, *, config: VoiceRuntimeConfig, wake: WakeDetector,
                 vad: VoiceActivityDetector, recognizer: SpeechRecognizer,
                 turns: JarvisTurnClient, publisher: VoiceStatePublisher,
                 lock: InteractionLockSource, clock: Clock,
                 speech_output: SpeechOutput | None = None) -> None:
        self._config = config
        self._wake = wake
        self._vad = vad
        self._recognizer = recognizer
        self._turns = turns
        self._publisher = publisher
        self._lock = lock
        self._clock = clock
        self._speech_output = speech_output
        self._machine = VoiceStateMachine(enabled=config.enabled, configured=config.configured)
        self._pre_roll = BoundedPcmBuffer(config.pre_roll_ms)

    async def _transition(self, state: VoiceState, **kwargs: object) -> bool:
        snapshot = self._machine.transition(state, **kwargs)  # type: ignore[arg-type]
        if snapshot is None:
            return False
        await self._publisher.publish(snapshot)
        return True

    async def _publish_listening_activity(self, frame: bytes) -> None:
        snapshot = self._machine.listening_activity(pcm_input_level(frame))
        if snapshot is not None:
            await self._publisher.publish(snapshot)

    async def disabled(self) -> None:
        """Publish the safe default without opening a microphone."""
        # Initial state is already disabled, so build the default snapshot directly.
        await self._publisher.publish(VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=False, configured=False,
            health=VoiceHealth.DISABLED, state=VoiceState.DISABLED, sequence=0,
        ))

    async def run(self, audio: AudioInput) -> None:
        if not self._config.enabled:
            await self.disabled()
            return
        await self._transition(VoiceState.STARTING, health=VoiceHealth.STARTING)
        await self._transition(VoiceState.IDLE, health=VoiceHealth.HEALTHY)
        capture = bytearray()
        wake_at: int | None = None
        speech_started = False
        silence_ms = 0
        activity_elapsed_ms = 0
        async for frame in audio.frames():
            if not frame:
                continue
            self._pre_roll.append(frame)
            frame_ms = max(1, len(frame) * 1_000 // PCM_BYTES_PER_SECOND)
            if self._machine.state is VoiceState.IDLE:
                if self._lock.is_locked() or not await self._wake.detect(frame):
                    continue
                wake_at = self._clock.monotonic_ms()
                capture = bytearray(self._pre_roll.snapshot())
                speech_started = False
                silence_ms = 0
                activity_elapsed_ms = 0
                await self._transition(VoiceState.WAKE_DETECTED)
                await self._transition(VoiceState.LISTENING, input_level=0.0)
                continue
            if self._machine.state is not VoiceState.LISTENING:
                continue
            capture.extend(frame)
            elapsed_ms = len(capture) * 1_000 // PCM_BYTES_PER_SECOND
            activity_elapsed_ms += frame_ms
            if activity_elapsed_ms >= VOICE_ACTIVITY_PUBLISH_MS:
                await self._publish_listening_activity(frame)
                activity_elapsed_ms = 0
            speech = await self._vad.is_speech(frame)
            if speech:
                speech_started = True
                silence_ms = 0
            elif speech_started:
                silence_ms += frame_ms
            if ((not speech_started and elapsed_ms >= self._config.pre_roll_ms + self._config.speech_onset_timeout_ms)
                    or elapsed_ms >= self._config.max_utterance_ms
                    or (speech_started and silence_ms >= self._config.trailing_silence_ms)):
                await self._complete_capture(bytes(capture), wake_at)
                capture.clear()  # discard the completed utterance from worker memory
                wake_at = None
                speech_started = False
                silence_ms = 0
                activity_elapsed_ms = 0

    async def _complete_capture(self, pcm: bytes, wake_at: int | None) -> None:
        await self._transition(VoiceState.TRANSCRIBING)
        started = self._clock.monotonic_ms()
        try:
            text = await asyncio.wait_for(self._recognizer.recognize(pcm), self._config.stt_timeout_ms / 1_000)
        except asyncio.TimeoutError:
            await self._failure("stt_timeout")
            return
        except Exception:
            await self._failure("stt_failed")
            return
        stt_latency = max(0, self._clock.monotonic_ms() - started)
        text = text.strip()
        if not text:
            await self._failure("empty_transcript")
            return
        if self._lock.is_locked():
            await self._failure("interaction_locked")
            return
        await self._transition(VoiceState.SUBMITTING, recognized_text=text,
                               wake_latency_ms=None if wake_at is None else max(0, started - wake_at),
                               stt_latency_ms=stt_latency)
        try:
            result = await self._turns.turn(text)
        except Exception:
            await self._failure("turn_failed")
            return
        # Adapters are an external boundary even on loopback: only preserve a
        # route that belongs to Jarvis A1's canonical allow-list.
        navigation = result.navigation if is_jarvis_navigation(result.navigation) else None
        ready_fields = {
            "recognized_text": text,
            "response_text": result.response_text,
            "wake_latency_ms": None if wake_at is None else max(0, started - wake_at),
            "stt_latency_ms": stt_latency,
            "navigation": navigation,
        }
        if self._speech_output is not None:
            await self._transition(VoiceState.SPEAKING, **ready_fields)
            try:
                # The response comes directly from JarvisTurnService.  Do not
                # normalize, rewrite, or otherwise turn a TTS adapter into a
                # semantic authority.
                await asyncio.wait_for(
                    self._speech_output.speak(result.response_text),
                    self._config.speech_timeout_ms / 1_000,
                )
            except Exception:
                # A completed semantic turn remains canonical even if the
                # optional output provider fails.  There is intentionally no
                # automatic retry: it could duplicate speech and provider cost.
                await self._transition(
                    VoiceState.READY, health=VoiceHealth.DEGRADED,
                    safe_error_code="tts_failed", **ready_fields,
                )
                await self._cooldown()
                return
        await self._transition(VoiceState.READY, **ready_fields)
        await self._cooldown()

    async def _cooldown(self) -> None:
        """Keep terminal state briefly visible, then clear text before the next wake."""
        await asyncio.sleep(self._config.cooldown_ms / 1_000)
        await self._transition(VoiceState.COOLDOWN)
        await self._transition(VoiceState.IDLE, health=VoiceHealth.HEALTHY)

    async def cancel(self) -> None:
        if self._machine.state in {VoiceState.LISTENING, VoiceState.TRANSCRIBING, VoiceState.SUBMITTING, VoiceState.SPEAKING}:
            await self._failure("cancelled")

    async def _failure(self, code: str) -> None:
        await self._transition(VoiceState.ERROR, health=VoiceHealth.DEGRADED, safe_error_code=code)
        await self._cooldown()
