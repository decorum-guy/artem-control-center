"""Entrypoint for the optional local Windows Jarvis voice worker."""

from __future__ import annotations

import asyncio
import os

from panel_agent.jarvis_voice import VoiceHealth, VoicePipeline, VoiceRuntimeConfig, VoiceSnapshot, VoiceState

from .adapters import (
    AdapterUnavailable, FasterWhisperRecognizer, HttpJarvisTurnClient, HttpVoiceStatePublisher,
    LoopbackBridgeConfig, MonotonicClock, OpenWakeWordDetector, SoundDeviceAudioInput, WebRtcVadDetector,
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
    token = os.getenv("PANEL_JARVIS_VOICE_BRIDGE_TOKEN", "")
    base_url = os.getenv("PANEL_JARVIS_VOICE_PANEL_URL", "http://127.0.0.1:8787")
    model_root = os.getenv("PANEL_JARVIS_VOICE_MODEL_ROOT", "")
    wake_model = os.getenv("PANEL_JARVIS_WAKE_MODEL", "")
    stt_model = os.getenv("PANEL_JARVIS_STT_MODEL", "")
    bridge = LoopbackBridgeConfig(base_url=base_url.rstrip("/"), token=token)
    publisher = HttpVoiceStatePublisher(bridge)
    configured = bool(enabled and token and model_root and wake_model and stt_model)
    if not enabled or not configured:
        await publisher.publish(VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=enabled, configured=configured,
            health=VoiceHealth.DISABLED if not enabled else VoiceHealth.UNCONFIGURED,
            state=VoiceState.DISABLED, sequence=0,
        ))
        return
    try:
        pipeline = VoicePipeline(
            config=VoiceRuntimeConfig(enabled=True, configured=True),
            wake=OpenWakeWordDetector(model_path=wake_model, threshold=float(os.getenv("PANEL_JARVIS_WAKE_THRESHOLD", "0.5"))),
            vad=WebRtcVadDetector(),
            recognizer=FasterWhisperRecognizer(model_path=stt_model, model_profile=os.getenv("PANEL_JARVIS_STT_PROFILE", "base")),
            turns=HttpJarvisTurnClient(bridge), publisher=publisher,
            lock=UnlockedUntilBridgeRejects(), clock=MonotonicClock(),
        )
        await pipeline.run(SoundDeviceAudioInput(device=microphone_device_from_environment()))
    except AdapterUnavailable as exc:
        await publisher.publish(VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=True, configured=True,
            health=VoiceHealth.UNAVAILABLE, state=VoiceState.ERROR, sequence=1,
            safe_error_code=exc.safe_code,
        ))


if __name__ == "__main__":
    asyncio.run(main())
