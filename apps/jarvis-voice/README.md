# Jarvis voice ingress and optional speech output

This is an optional local Windows worker, deliberately separate from the Panel
Agent virtual environment.  It captures a microphone only when the owner has
provisioned a dedicated runtime and explicitly enabled it.  The default is
disabled: merging this source does not request microphone access, download a
model, or make a Fish request.

The worker has one narrow path: 16 kHz mono PCM in bounded memory → wake → VAD
→ bounded utterance → local Russian STT → authenticated loopback `/voice/turn`
→ the existing `JarvisTurnService` → optional Fish streaming TTS → current
Windows default speakers. `JarvisTurnService` is the sole response and intent
authority. It has no shell, generic Home Assistant, device, Planning, update,
cloud-STT, or second-classifier path.

## Optional Fish output

Output remains disabled by default. Set `PANEL_JARVIS_TTS_ENABLED=true` only in
the local Samsung runtime configuration after explicit provisioning and
hardware acceptance. The dedicated voice venv, not Panel Agent, installs the
official pinned dependency:

```powershell
%LOCALAPPDATA%\ArtemControlCenter\jarvis-voice\venv\Scripts\python.exe -m pip install -r apps\jarvis-voice\requirements-runtime.txt
```

The narrow `runtime.env` allow-list accepts only these non-secret TTS settings:

```text
PANEL_JARVIS_TTS_ENABLED=true
PANEL_JARVIS_TTS_MODEL=s2.1-pro-free
PANEL_JARVIS_TTS_REFERENCE_ID=<owner-selected-reference-id>
PANEL_JARVIS_TTS_LATENCY=balanced
```

Accepted model values are `s2.1-pro-free` and `s2.1-pro`; accepted latency
values are `balanced` and `normal`. Do not put `FISH_API_KEY` in `runtime.env`
or any repository file. It is an external Windows User-environment secret,
inherited by the scheduled worker only when TTS is enabled. Status output never
renders it.

Fish receives exactly the completed canonical `responseText` and nothing else.
The following stay local-only: microphone PCM, wake detection, VAD, owner
transcript, and STT model. No microphone audio, transcript, generated speech,
or audio file is persisted. PCM is streamed in memory to `sounddevice` /
PortAudio at 44.1 kHz, mono, signed int16, with an approximately 80 ms initial
prebuffer and no disk cache, generated WAV, retry loop, or subprocess player.

If Fish auth/network/provider/playback fails or times out, the completed Jarvis
text response and navigation still reach READY with the safe `tts_failed`
state. The worker does not retry automatically. This source does not activate
Samsung production output: physical latency, device, and end-to-end acceptance
remain required after merge.

`models.manifest.json` describes model identities rather than distributing
third-party wake/STT weights. `openWakeWord/hey_jarvis` and
`faster-whisper/base` are provisional only.  The accepted owner RVC assets are
hash-pinned project files for a later output slice and are not used by A2.

Before enabling on Samsung, provision the dedicated virtual environment and
models under `%LOCALAPPDATA%\ArtemControlCenter\jarvis-voice`, set the local
runtime configuration and bridge token, then perform the physical checklist:
microphone/sample-rate verification, console SessionId verification, Russian
wake accuracy/false-accept measurement, Russian STT accuracy/latency/RAM/CPU,
Fish first-audio/speaker latency, and one end-to-end overlay turn. No claim
from this source substitutes for those measurements.
