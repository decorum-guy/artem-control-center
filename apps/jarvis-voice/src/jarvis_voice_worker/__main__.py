"""Entrypoint for the optional local Windows Jarvis voice worker."""

from __future__ import annotations

import asyncio
import os

from panel_agent.jarvis_voice import VoiceHealth, VoicePipeline, VoiceRuntimeConfig, VoiceSnapshot, VoiceState

from .adapters import (
    AdapterUnavailable, FasterWhisperRecognizer, FishStreamingSpeechOutput, FishTtsSettings,
    HttpJarvisTurnClient, HttpVoiceStatePublisher, LoopbackBridgeConfig, MonotonicClock,
    OpenWakeWordDetector, SoundDeviceAudioInput, WebRtcVadDetector,
)


class UnlockedUntilBridgeRejects:
    """Panel Agent is the authoritative lock enforcer for loopback turns."""

    def is_locked(self) -> bool:
        return False


def microphone_device_from_environment() -> str | None:
    """Return None for the canonical absent/empty default-microphone setting."""
    return os.getenv("PANEL_JARVIS_MIC_DEVICE") or None


async def main() -> None:
    enabled = os.getenv("PANEL_JARVIS_VOICE_ENABLED", "false").lower() == "true"
    tts_enabled = os.getenv("PANEL_JARVIS_TTS_ENABLED", "false").lower() == "true"
    token = os.getenv("PANEL_JARVIS_VOICE_BRIDGE_TOKEN", "")
    base_url = os.getenv("PANEL_JARVIS_VOICE_PANEL_URL", "http://127.0.0.1:8787")
    model_root = os.getenv("PANEL_JARVIS_VOICE_MODEL_ROOT", "")
    wake_model = os.getenv("PANEL_JARVIS_WAKE_MODEL", "")
    stt_model = os.getenv("PANEL_JARVIS_STT_MODEL", "")
    bridge = LoopbackBridgeConfig(base_url=base_url.rstrip("/"), token=token)
    publisher = HttpVoiceStatePublisher(bridge)
    fish_api_key = ""
    tts_settings: FishTtsSettings | None = None
    if tts_enabled:
        # The secret is inherited from the Windows User environment only. It
        # is deliberately absent from runtime.env and the PANEL_* allow-list.
        fish_api_key = os.getenv("FISH_API_KEY", "")
        try:
            tts_settings = FishTtsSettings(
                model=os.getenv("PANEL_JARVIS_TTS_MODEL", ""),
                reference_id=os.getenv("PANEL_JARVIS_TTS_REFERENCE_ID", ""),
                latency=os.getenv("PANEL_JARVIS_TTS_LATENCY", ""),
            )
        except ValueError:
            tts_settings = None
    configured = bool(
        enabled and token and model_root and wake_model and stt_model and
        (not tts_enabled or (fish_api_key and tts_settings is not None))
    )
    if not enabled or not configured:
        await publisher.publish(VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=enabled, configured=configured,
            health=VoiceHealth.DISABLED if not enabled else VoiceHealth.UNCONFIGURED,
            state=VoiceState.DISABLED, sequence=0,
        ))
        return
    try:
        speech_output = None
        if tts_enabled:
            # Configuration was validated before opening the microphone. This
            # constructor imports no Fish package unless TTS is explicitly on.
            assert tts_settings is not None
            speech_output = FishStreamingSpeechOutput(
                api_key=fish_api_key, model=tts_settings.model,
                reference_id=tts_settings.reference_id, latency=tts_settings.latency,
            )
        pipeline = VoicePipeline(
            config=VoiceRuntimeConfig(enabled=True, configured=True),
            wake=OpenWakeWordDetector(model_path=wake_model, threshold=float(os.getenv("PANEL_JARVIS_WAKE_THRESHOLD", "0.5"))),
            vad=WebRtcVadDetector(),
            recognizer=FasterWhisperRecognizer(model_path=stt_model, model_profile=os.getenv("PANEL_JARVIS_STT_PROFILE", "base")),
            turns=HttpJarvisTurnClient(bridge), publisher=publisher,
            lock=UnlockedUntilBridgeRejects(), clock=MonotonicClock(),
            speech_output=speech_output,
        )
        try:
            await pipeline.run(SoundDeviceAudioInput(device=microphone_device_from_environment()))
        finally:
            if speech_output is not None:
                await speech_output.aclose()
    except AdapterUnavailable as exc:
        await publisher.publish(VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=True, configured=True,
            health=VoiceHealth.UNAVAILABLE, state=VoiceState.ERROR, sequence=1,
            safe_error_code=exc.safe_code,
        ))


if __name__ == "__main__":
    asyncio.run(main())
