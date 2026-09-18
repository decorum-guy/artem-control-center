"""Ephemeral local bridge between the optional Jarvis voice worker and Panel Agent.

The browser may read state but cannot submit a voice turn: worker state updates
and the narrow ``/voice/turn`` route require a process-local secret configured
outside Git.  No audio or transcript is written by this module.
"""

from __future__ import annotations

import hmac
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .jarvis_api import JarvisTurnResponse, JarvisTurnService
from .jarvis_core import MAX_JARVIS_TEXT_CODEPOINTS
from .jarvis_voice import VoiceHealth, VoiceSnapshot, VoiceState, is_legal_voice_transition


class VoiceStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    schema_version: Literal["jarvis.voice.v1"] = Field(alias="schemaVersion")
    enabled: bool
    configured: bool
    health: Literal["disabled", "unconfigured", "starting", "healthy", "degraded", "unavailable"]
    state: Literal["disabled", "starting", "idle", "wake_detected", "listening", "transcribing", "submitting", "ready", "error", "cooldown"]
    sequence: int = Field(ge=0)
    recognized_text: str | None = Field(default=None, max_length=512, alias="recognizedText")
    response_text: str | None = Field(default=None, max_length=500, alias="responseText")
    safe_error_code: Literal[
        "microphone_unavailable", "wake_dependency_missing", "wake_model_missing",
        "stt_dependency_missing", "stt_model_missing", "audio_stream_failed",
        "stt_failed", "stt_timeout", "turn_failed", "empty_transcript",
        "interaction_locked", "wrong_session", "cancelled",
    ] | None = Field(default=None, alias="safeErrorCode")
    wake_latency_ms: int | None = Field(default=None, ge=0, alias="wakeLatencyMs")
    stt_latency_ms: int | None = Field(default=None, ge=0, alias="sttLatencyMs")


class VoiceStateUpdate(VoiceStateResponse):
    pass


class VoiceBridgeTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=MAX_JARVIS_TEXT_CODEPOINTS)


class VoiceInteractionLockUpdate(BaseModel):
    """The explicit panel UI-to-server lock signal; no command content is accepted."""

    model_config = ConfigDict(extra="forbid", strict=True)
    locked: bool


class VoiceBridgeState:
    """In-memory state only.  A restart intentionally clears active text."""

    def __init__(self, *, enabled: bool = False, configured: bool = False, token: str | None = None) -> None:
        self._token = token or ""
        self._locked = True
        self._worker_sequence = 0
        initial_health = VoiceHealth.DISABLED if not enabled else VoiceHealth.UNCONFIGURED
        self._snapshot = VoiceSnapshot(
            schema_version="jarvis.voice.v1", enabled=enabled, configured=configured,
            health=initial_health, state=VoiceState.DISABLED, sequence=0,
        )

    @property
    def snapshot(self) -> VoiceSnapshot:
        return self._snapshot

    @property
    def locked(self) -> bool:
        return self._locked

    def set_locked(self, locked: bool) -> None:
        self._locked = locked

    def authorized(self, candidate: str | None) -> bool:
        return bool(self._token) and candidate is not None and hmac.compare_digest(self._token, candidate)

    def accept(self, update: VoiceStateUpdate) -> bool:
        """Ignore stale/illegal worker updates and normalize a restart monotonically."""
        next_state = VoiceState(update.state)
        # A replacement worker restarts at ``starting/1``. The browser sequence
        # remains server-monotonic, while all ordinary stale worker updates lose.
        restarting = next_state is VoiceState.STARTING and update.sequence == 1
        if not restarting and update.sequence <= self._worker_sequence:
            return False
        if not restarting and not is_legal_voice_transition(self._snapshot.state, next_state):
            return False
        self._worker_sequence = update.sequence
        self._snapshot = VoiceSnapshot(
            schema_version=update.schema_version, enabled=update.enabled, configured=update.configured,
            health=VoiceHealth(update.health), state=next_state, sequence=self._snapshot.sequence + 1,
            recognized_text=update.recognized_text, response_text=update.response_text,
            safe_error_code=update.safe_error_code, wake_latency_ms=update.wake_latency_ms,
            stt_latency_ms=update.stt_latency_ms,
        )
        return True


def _response(snapshot: VoiceSnapshot) -> VoiceStateResponse:
    raw = asdict(snapshot)
    return VoiceStateResponse.model_validate(raw)


def build_jarvis_voice_router(*, service: JarvisTurnService, bridge: VoiceBridgeState) -> APIRouter:
    router = APIRouter(prefix="/api/v1/jarvis/voice", tags=["jarvis-voice"])

    @router.get("/state", response_model=VoiceStateResponse)
    async def voice_state(response: Response) -> VoiceStateResponse:
        response.headers["Cache-Control"] = "no-store"
        return _response(bridge.snapshot)

    @router.post("/state", status_code=status.HTTP_204_NO_CONTENT)
    async def publish_voice_state(update: VoiceStateUpdate,
                                  x_jarvis_voice_token: str | None = Header(default=None)) -> Response:
        if not bridge.authorized(x_jarvis_voice_token):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="voice_bridge_forbidden")
        bridge.accept(update)
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "no-store"})

    @router.post("/interaction-lock", status_code=status.HTTP_204_NO_CONTENT)
    async def sync_interaction_lock(update: VoiceInteractionLockUpdate) -> Response:
        # The existing InteractionLock lives in the local dashboard.  Mirroring
        # its boolean to this in-memory bridge makes the server the enforcement
        # point for voice turns; the route accepts no executable input.
        bridge.set_locked(update.locked)
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "no-store"})

    @router.post("/turn", response_model=JarvisTurnResponse)
    async def voice_turn(request: VoiceBridgeTurnRequest, response: Response,
                         x_jarvis_voice_token: str | None = Header(default=None)) -> JarvisTurnResponse:
        if not bridge.authorized(x_jarvis_voice_token):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="voice_bridge_forbidden")
        if bridge.locked:
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="interaction_locked")
        response.headers["Cache-Control"] = "no-store"
        return await service.turn(request.text)

    return router
