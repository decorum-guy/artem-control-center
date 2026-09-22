"""Lazy optional production adapters; no model downloads and no file audio."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Protocol

import httpx

from panel_agent.jarvis_voice import (
    AudioInput, JarvisTurnClient, VoiceSnapshot, VoiceStatePublisher, VoiceTurnResult,
)
from panel_agent.jarvis_navigation import is_jarvis_navigation


class AdapterUnavailable(RuntimeError):
    def __init__(self, safe_code: str) -> None:
        super().__init__(safe_code)
        self.safe_code = safe_code


class SpeechOutputFailure(RuntimeError):
    """A provider/output failure whose public surface is deliberately generic."""


FISH_PCM_SAMPLE_RATE_HZ = 44_100
FISH_PCM_BYTES_PER_SECOND = FISH_PCM_SAMPLE_RATE_HZ * 2  # signed int16, mono
FISH_INITIAL_PREBUFFER_BYTES = FISH_PCM_BYTES_PER_SECOND * 80 // 1_000
FISH_MAX_PENDING_PCM_BYTES = FISH_PCM_BYTES_PER_SECOND
FISH_WRITE_BYTES = FISH_PCM_BYTES_PER_SECOND * 40 // 1_000
FISH_MODELS = frozenset({"s2.1-pro-free", "s2.1-pro"})
FISH_LATENCIES = frozenset({"balanced", "normal"})


@dataclass(frozen=True)
class FishTtsSettings:
    """Non-secret, closed Fish settings supplied by the Windows runtime allow-list."""

    model: str
    reference_id: str
    latency: str

    def __post_init__(self) -> None:
        if self.model not in FISH_MODELS:
            raise ValueError("Unsupported Fish TTS model")
        if self.latency not in FISH_LATENCIES:
            raise ValueError("Unsupported Fish TTS latency")
        if not self.reference_id.strip():
            raise ValueError("Fish TTS reference ID is required")


class PcmAudioSink(Protocol):
    """A single in-memory PCM playback stream for one utterance."""

    async def open(self) -> None: ...
    async def write(self, pcm: bytes) -> None: ...
    async def close(self) -> None: ...


class FishStreamingClient(Protocol):
    @property
    def tts(self) -> "FishStreamingTtsClient": ...

    async def close(self) -> None: ...


class FishStreamingTtsClient(Protocol):
    def stream_websocket(self, text_stream: AsyncIterator[str], *, reference_id: str,
                         format: str, latency: str, config: object,
                         model: str) -> AsyncIterator[bytes]: ...


class SoundDevicePcmSink:
    """Direct PortAudio playback on the current Windows default output device."""

    def __init__(self) -> None:
        self._stream: object | None = None

    async def open(self) -> None:
        try:
            import sounddevice as sd
            stream = sd.RawOutputStream(
                samplerate=FISH_PCM_SAMPLE_RATE_HZ, channels=1, dtype="int16",
            )
            stream.start()
            self._stream = stream
        except Exception as exc:
            raise AdapterUnavailable("audio_stream_failed") from exc

    async def write(self, pcm: bytes) -> None:
        if self._stream is None:
            raise SpeechOutputFailure("tts_failed")
        try:
            # RawOutputStream.write blocks under PortAudio backpressure.  That
            # is intentional: there is no unbounded producer queue.
            await asyncio.to_thread(self._stream.write, pcm)  # type: ignore[union-attr]
        except Exception as exc:
            raise AdapterUnavailable("audio_stream_failed") from exc

    async def close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            await asyncio.to_thread(stream.stop)  # type: ignore[union-attr]
            await asyncio.to_thread(stream.close)  # type: ignore[union-attr]
        except Exception:
            # The TTS path is already terminal at this point.  Never replace a
            # completed canonical Jarvis turn with a PortAudio cleanup detail.
            return


def _default_fish_client(api_key: str) -> FishStreamingClient:
    try:
        from fishaudio import AsyncFishAudio
        # The SDK owns its official endpoint. There is intentionally no
        # endpoint override in local runtime configuration.
        return AsyncFishAudio(api_key=api_key, timeout=60.0)
    except ImportError as exc:
        raise AdapterUnavailable("tts_failed") from exc
    except Exception as exc:
        raise AdapterUnavailable("tts_failed") from exc


def _default_fish_request_config(settings: FishTtsSettings) -> object:
    try:
        from fishaudio import TTSConfig
    except ImportError as exc:
        raise AdapterUnavailable("tts_failed") from exc
    return TTSConfig(format="pcm", sample_rate=FISH_PCM_SAMPLE_RATE_HZ, latency=settings.latency)


class FishStreamingSpeechOutput:
    """One official SDK client plus bounded, memory-only PCM speaker output."""

    def __init__(self, *, api_key: str, model: str, reference_id: str, latency: str,
                 client_factory: Callable[[str], FishStreamingClient] = _default_fish_client,
                 sink_factory: Callable[[], PcmAudioSink] = SoundDevicePcmSink,
                 request_config_factory: Callable[[FishTtsSettings], object] = _default_fish_request_config) -> None:
        if not api_key:
            raise ValueError("Fish TTS API key is required")
        self._settings = FishTtsSettings(model=model, reference_id=reference_id, latency=latency)
        self._client = client_factory(api_key)
        self._sink_factory = sink_factory
        self._request_config = request_config_factory(self._settings)

    async def speak(self, text: str) -> None:
        sink = self._sink_factory()
        buffered = bytearray()
        opened = False
        try:
            async for pcm in self._client.tts.stream_websocket(
                self._text_stream(text), reference_id=self._settings.reference_id,
                format="pcm", latency=self._settings.latency,
                config=self._request_config, model=self._settings.model,
            ):
                if not pcm:
                    continue
                if not opened:
                    buffered.extend(pcm)
                    if len(buffered) > FISH_MAX_PENDING_PCM_BYTES:
                        raise SpeechOutputFailure("tts_failed")
                    if len(buffered) < FISH_INITIAL_PREBUFFER_BYTES:
                        continue
                    await sink.open()
                    opened = True
                    await self._write_bounded(sink, bytes(buffered))
                    buffered.clear()
                    continue
                await self._write_bounded(sink, pcm)
            if buffered:
                # Short final speech must still be audible, but it has never
                # exceeded the bounded initial prebuffer.
                await sink.open()
                opened = True
                await self._write_bounded(sink, bytes(buffered))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Never leak provider/auth/network exception strings into the
            # worker, Panel Agent, or browser contract.
            raise SpeechOutputFailure("tts_failed") from None
        finally:
            await sink.close()

    @staticmethod
    async def _text_stream(text: str) -> AsyncIterator[str]:
        # Fish receives only the completed canonical responseText, once.
        yield text

    @staticmethod
    async def _write_bounded(sink: PcmAudioSink, pcm: bytes) -> None:
        # A direct, backpressured stream has no pending queue. Splitting large
        # provider frames bounds every PortAudio write to 40 ms of PCM.
        for offset in range(0, len(pcm), FISH_WRITE_BYTES):
            await sink.write(pcm[offset:offset + FISH_WRITE_BYTES])

    async def aclose(self) -> None:
        try:
            await self._client.close()
        except Exception:
            return


@dataclass(frozen=True)
class LoopbackBridgeConfig:
    base_url: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"X-Jarvis-Voice-Token": self.token}


class HttpVoiceStatePublisher(VoiceStatePublisher):
    def __init__(self, bridge: LoopbackBridgeConfig) -> None:
        self._bridge = bridge

    async def publish(self, snapshot: VoiceSnapshot) -> None:
        payload = {
            "schemaVersion": snapshot.schema_version, "enabled": snapshot.enabled,
            "configured": snapshot.configured, "health": snapshot.health.value,
            "state": snapshot.state.value, "sequence": snapshot.sequence,
            "recognizedText": snapshot.recognized_text, "responseText": snapshot.response_text,
            "safeErrorCode": snapshot.safe_error_code, "wakeLatencyMs": snapshot.wake_latency_ms,
            "sttLatencyMs": snapshot.stt_latency_ms, "navigation": snapshot.navigation,
            "inputLevel": snapshot.input_level,
        }
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{self._bridge.base_url}/api/v1/jarvis/voice/state",
                                         headers=self._bridge.headers, json=payload)
            response.raise_for_status()


class HttpJarvisTurnClient(JarvisTurnClient):
    def __init__(self, bridge: LoopbackBridgeConfig) -> None:
        self._bridge = bridge

    async def turn(self, text: str) -> VoiceTurnResult:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(f"{self._bridge.base_url}/api/v1/jarvis/voice/turn",
                                         headers=self._bridge.headers, json={"text": text})
            response.raise_for_status()
        value = response.json()
        navigation = value.get("navigation")
        if navigation is not None and not is_jarvis_navigation(navigation):
            raise ValueError("jarvis_voice_turn_invalid_navigation")
        return VoiceTurnResult(response_text=str(value["responseText"]), navigation=navigation)


class MonotonicClock:
    def monotonic_ms(self) -> int:
        return int(time.monotonic() * 1_000)


class SoundDeviceAudioInput(AudioInput):
    """A bounded callback queue; the adapter performs device conversion to 16 kHz mono."""

    def __init__(self, *, device: str | int | None = None, queue_frames: int = 8) -> None:
        self._device = device
        self._queue_frames = queue_frames

    async def frames(self) -> AsyncIterator[bytes]:
        try:
            import sounddevice as sd
        except ImportError as exc:
            raise AdapterUnavailable("microphone_unavailable") from exc
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=self._queue_frames)
        loop = asyncio.get_running_loop()

        def callback(indata: bytes, _frames: int, _time: object, status: object) -> None:
            if status:
                return
            value = bytes(indata)
            def offer() -> None:
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                queue.put_nowait(value)
            loop.call_soon_threadsafe(offer)

        try:
            with sd.RawInputStream(device=self._device, samplerate=16_000, channels=1,
                                   dtype="int16", blocksize=1_280, callback=callback):
                while True:
                    yield await queue.get()
        except Exception as exc:
            raise AdapterUnavailable("audio_stream_failed") from exc


class OpenWakeWordDetector:
    def __init__(self, *, model_path: str, threshold: float) -> None:
        if not 0.1 <= threshold <= 0.95:
            raise ValueError("Wake threshold must remain bounded")
        try:
            import numpy as np
            from openwakeword.model import Model
        except ImportError as exc:
            raise AdapterUnavailable("wake_dependency_missing") from exc
        self._np = np
        try:
            self._model = Model(wakeword_models=[model_path])
        except (FileNotFoundError, OSError) as exc:
            raise AdapterUnavailable("wake_model_missing") from exc
        self._threshold = threshold

    async def detect(self, pcm_16khz_mono: bytes) -> bool:
        prediction = self._model.predict(self._np.frombuffer(pcm_16khz_mono, dtype=self._np.int16))
        return any(float(score) >= self._threshold for score in prediction.values())


class WebRtcVadDetector:
    def __init__(self, *, aggressiveness: int = 2) -> None:
        if aggressiveness not in range(4):
            raise ValueError("VAD aggressiveness must be 0..3")
        try:
            import webrtcvad
        except ImportError as exc:
            raise AdapterUnavailable("stt_dependency_missing") from exc
        self._vad = webrtcvad.Vad(aggressiveness)

    async def is_speech(self, pcm_16khz_mono: bytes) -> bool:
        # WebRTC VAD accepts 10/20/30 ms; 80 ms audio frames are split in memory.
        chunk_size = 960  # 30 ms at 16 kHz, int16 mono
        return any(self._vad.is_speech(pcm_16khz_mono[offset:offset + chunk_size], 16_000)
                   for offset in range(0, len(pcm_16khz_mono) - chunk_size + 1, chunk_size))


class FasterWhisperRecognizer:
    """Loads a locally provisioned model once; it never downloads during a turn."""

    def __init__(self, *, model_path: str, model_profile: str = "base") -> None:
        if model_profile not in {"base", "small"}:
            raise ValueError("Only provisional base/small profiles are supported")
        try:
            import numpy as np
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise AdapterUnavailable("stt_dependency_missing") from exc
        self._np = np
        try:
            self._model = WhisperModel(model_path, device="cpu", compute_type="int8", local_files_only=True)
        except (FileNotFoundError, OSError, ValueError) as exc:
            raise AdapterUnavailable("stt_model_missing") from exc

    async def recognize(self, pcm_16khz_mono: bytes) -> str:
        def transcribe() -> str:
            audio = self._np.frombuffer(pcm_16khz_mono, dtype=self._np.int16).astype(self._np.float32) / 32768.0
            segments, _info = self._model.transcribe(audio, language="ru", task="transcribe")
            return " ".join(segment.text.strip() for segment in segments).strip()
        return await asyncio.to_thread(transcribe)
