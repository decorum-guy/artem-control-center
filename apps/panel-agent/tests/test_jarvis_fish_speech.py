from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

VOICE_WORKER_SOURCE = Path(__file__).resolve().parents[2] / "jarvis-voice" / "src"
if str(VOICE_WORKER_SOURCE) not in sys.path:
    sys.path.insert(0, str(VOICE_WORKER_SOURCE))

from jarvis_voice_worker.adapters import (
    FISH_INITIAL_PREBUFFER_BYTES, FishStreamingSpeechOutput, FishTtsSettings,
    SpeechOutputFailure,
)


class FakeSink:
    def __init__(self, tts: "FakeTts") -> None:
        self.tts = tts
        self.opened = False
        self.closed = False
        self.writes: list[bytes] = []
        self.write_before_generator_finished: list[bool] = []

    async def open(self) -> None:
        self.opened = True

    async def write(self, pcm: bytes) -> None:
        self.writes.append(pcm)
        self.write_before_generator_finished.append(not self.tts.finished)

    async def close(self) -> None:
        self.closed = True


class FakeTts:
    def __init__(self, chunks: list[bytes], failure: Exception | None = None) -> None:
        self.chunks = chunks
        self.failure = failure
        self.calls: list[dict[str, object]] = []
        self.finished = False

    def stream_websocket(self, text_stream: AsyncIterator[str], **kwargs: object) -> AsyncIterator[bytes]:
        async def stream() -> AsyncIterator[bytes]:
            text = [item async for item in text_stream]
            self.calls.append({"text": text, **kwargs})
            if self.failure:
                raise self.failure
            for chunk in self.chunks:
                yield chunk
            self.finished = True
        return stream()


class FakeClient:
    def __init__(self, tts: FakeTts) -> None:
        self.tts = tts
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def output(*, chunks: list[bytes], failure: Exception | None = None):
    tts = FakeTts(chunks, failure)
    client = FakeClient(tts)
    sinks: list[FakeSink] = []

    def sink_factory() -> FakeSink:
        sink = FakeSink(tts)
        sinks.append(sink)
        return sink

    subject = FishStreamingSpeechOutput(
        api_key="test-only-external-secret", model="s2.1-pro-free",
        reference_id="owner-configured-reference", latency="balanced",
        client_factory=lambda _key: client, sink_factory=sink_factory,
        request_config_factory=lambda settings: settings,
    )
    return subject, tts, client, sinks


def test_fish_stream_passes_exact_closed_settings_and_streams_before_completion():
    subject, tts, _, sinks = output(chunks=[b"a" * 4_000, b"b" * 4_000, b"c" * 1_000])
    asyncio.run(subject.speak("Точный canonical responseText?!"))
    assert len(tts.calls) == 1
    call = tts.calls[0]
    assert call["text"] == ["Точный canonical responseText?!"]
    assert call["model"] == "s2.1-pro-free"
    assert call["reference_id"] == "owner-configured-reference"
    assert call["latency"] == "balanced" and call["format"] == "pcm"
    settings = call["config"]
    assert isinstance(settings, FishTtsSettings)
    assert settings.model == "s2.1-pro-free" and settings.latency == "balanced"
    sink = sinks[0]
    assert sink.opened and sink.closed and b"".join(sink.writes) == b"a" * 4_000 + b"b" * 4_000 + b"c" * 1_000
    assert any(sink.write_before_generator_finished)
    assert FISH_INITIAL_PREBUFFER_BYTES == 7_056
    assert not hasattr(subject, "path")


def test_fish_client_is_reused_for_utterances_without_retry():
    subject, tts, client, sinks = output(chunks=[b"a" * FISH_INITIAL_PREBUFFER_BYTES])
    asyncio.run(subject.speak("Первый ответ."))
    tts.finished = False
    asyncio.run(subject.speak("Второй ответ."))
    assert [call["text"] for call in tts.calls] == [["Первый ответ."], ["Второй ответ."]]
    assert len(sinks) == 2 and not client.closed
    asyncio.run(subject.aclose())
    assert client.closed


def test_fish_provider_error_is_generic_and_closes_audio_without_retry():
    subject, tts, _, sinks = output(chunks=[], failure=RuntimeError("secret provider failure detail"))
    with pytest.raises(SpeechOutputFailure, match="tts_failed") as error:
        asyncio.run(subject.speak("Готовый текст."))
    assert "secret provider failure detail" not in str(error.value)
    assert len(tts.calls) == 1
    assert sinks[0].closed and not sinks[0].opened
