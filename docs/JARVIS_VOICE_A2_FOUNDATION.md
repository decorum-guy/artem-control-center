# Jarvis A2 voice ingress foundation

This change supplies the software foundation only. Samsung was unavailable
during implementation, so it makes no microphone, console-session, wake-word,
Russian recognition, CPU/RAM, latency, or room-noise claim.

## Safety and authority

Voice is disabled and unconfigured by default. The ordinary Panel Agent does
not import audio or ML packages and does not request microphone access. The
optional worker has exactly one semantic destination: its authenticated
loopback bridge calls the existing `JarvisTurnService`. It cannot supply an
intent/action/route, execute a shell command, call generic Home Assistant,
perform device/Planning/update mutations, or call an LLM/provider.

The worker uses 16 kHz mono PCM in a fixed-size in-memory ring, with bounded
pre-roll (500 ms), speech onset (3 s), utterance (12 s), trailing silence
(800 ms), and display cooldown (1.2 s). These are software defaults, not
accepted Samsung tuning. Audio is never recorded. Recognized and response text
are current-turn ephemeral state only; they are no-store API fields, never
diagnostics, logs, runtime JSON, or browser storage.

Interaction Lock is mirrored to the Panel Agent and enforced before the narrow
voice turn route. The worker remains optional; an unavailable mic/model cannot
make panel readiness, kiosk health, or update acceptance fail.

## Provisioning later

The dedicated worker is in `apps/jarvis-voice`; its pinned runtime requirements
are separate from the Panel Agent venv. It lazy-loads provisional openWakeWord
`hey_jarvis`, WebRTC VAD, and CPU-int8 faster-whisper (`base` or `small`) only
after explicit provisioning. It never downloads a model during a turn. Models,
worker venv, and configuration belong below
`%LOCALAPPDATA%\ArtemControlCenter\jarvis-voice`, outside build artifacts and
ordinary update cleanup.

`models.manifest.json` records the exact owner RVC assets and their hashes. RVC
is future output timbre conversion only: this slice has no TTS, RVC inference,
or playback.

Before enabling, use the supplied interactive/limited Scheduled Task scripts
to provision one console-session worker, then physically verify microphone
formats, SessionId, wake phrase accuracy (including Russian `Джарвис`),
false-accept/reject behavior, local STT accuracy/latency/CPU/RAM, dashboard
responsiveness, and one complete overlay turn. Until that is done, wake/STT
models remain provisional and `physicalAcceptance=false`.
