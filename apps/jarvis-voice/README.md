# Jarvis voice ingress (A2 foundation)

This is an optional local Windows worker, deliberately separate from the Panel
Agent virtual environment.  It captures a microphone only when the owner has
provisioned a dedicated runtime and explicitly enabled it.  The default is
disabled: merging this source does not request microphone access or download a
model.

The worker has one narrow path: 16 kHz mono PCM in bounded memory → wake → VAD
→ bounded utterance → local Russian STT → authenticated loopback `/voice/turn`
→ the existing `JarvisTurnService`.  It has no shell, generic Home Assistant,
device, Planning, update, cloud-STT, or second-classifier path.  Audio and
transcripts are not written to files, diagnostics, or browser storage.

`models.manifest.json` describes model identities rather than distributing
third-party wake/STT weights. `openWakeWord/hey_jarvis` and
`faster-whisper/base` are provisional only.  The accepted owner RVC assets are
hash-pinned project files for a later output slice and are not used by A2.

Before enabling on Samsung, provision the dedicated virtual environment and
models under `%LOCALAPPDATA%\ArtemControlCenter\jarvis-voice`, set the local
runtime configuration and bridge token, then perform the physical checklist:
microphone/sample-rate verification, console SessionId verification, Russian
wake accuracy/false-accept measurement, Russian STT accuracy/latency/RAM/CPU,
and one end-to-end overlay turn.  No claim from this source substitutes for
those measurements.
