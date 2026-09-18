"""Lazy optional production adapters; no model downloads and no file audio."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from panel_agent.jarvis_voice import (
    AudioInput, JarvisTurnClient, VoiceSnapshot, VoiceStatePublisher, VoiceTurnResult,
)


class AdapterUnavailable(RuntimeError):
    def __init__(self, safe_code: str) -> None:
        super().__init__(safe_code)
        self.safe_code = safe_code


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
            "sttLatencyMs": snapshot.stt_latency_ms,
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
        return VoiceTurnResult(response_text=str(value["responseText"]), navigation=value.get("navigation"))


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
