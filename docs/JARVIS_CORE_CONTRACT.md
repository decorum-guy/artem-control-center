# Jarvis core contract

This slice defines the deterministic local boundary that a future local STT
runtime may call:

```text
recognized transcript text → fixed typed intent envelope
```

The router runs before any future LLM fallback. It has no network, model,
audio, microphone, provider, Home Assistant, shell, or action-execution
dependency. It only classifies a bounded transcript into the fixed registry in
`apps/panel-agent/src/panel_agent/jarvis_core.py`.

## Envelope

The valid envelope has `schemaVersion: "jarvis.intent.v1"`, a fixed `intentId`,
`kind`, `confidenceClass`, bounded `normalizedText`, and the closed slot object
`{ location, timeScope }`. `requiresConfirmation` is metadata only. It does
not authorize an action. A future executor must still apply the current access
profile, Interaction Lock, capability/write gates, confirmations, and
action-specific policy.

The router accepts at most 512 Unicode code points, trims and NFC-normalizes
text, case-folds Russian safely, collapses whitespace, and replaces punctuation
with spaces for matching. It never transliterates Cyrillic to Latin. Weather
locations are limited to 64 code points and are treated as plain bounded text;
there is no geocoding or URL/path interpretation.

Reads and navigation use explicit natural-language rule groups. Device actions
require a target plus a known imperative construction. Questions, explicit
negation, mixed actions, and uncertain phrases fail closed to
`general.question`; words such as `кофемашина` or `асус` alone do not control a
device. Unknown text becomes `general.question` and is not answered here.

Oversized or non-text input returns a typed invalid result rather than being
processed.

## Session and greeting policy

`JarvisSession` tracks only:

- `lastSuccessfulInteractionAt`;
- `lastGreetingAt`;
- `lastGreetingDaypart`;
- `lastInteractionLocalDate`.

The default idle threshold is the server-owned constant of three hours. A new
session begins on the first successful interaction, after at least three hours
of successful-interaction idle time, or after a local calendar-day rollover.
Only the first successful interaction in each new session is greeting-eligible.
Failed attempts and cancellation are no-ops. The daypart boundaries are
05:00–11:59 morning, 12:00–17:59 day, 18:00–23:59 evening, and 00:00–04:59
night in the injected/server-local timezone (default `Europe/Moscow`).

The optional persistence store is one small atomic JSON record at the existing
Panel runtime-root family: `%LOCALAPPDATA%/ArtemControlCenter/jarvis-session.json`
or `.runtime/ArtemControlCenter/jarvis-session.json` for local development.
`PANEL_JARVIS_SESSION_STATE_PATH` is a server/test override. The file has no
transcript, utterance history, audio, URL, path, command, or provider data.

No production HTTP "execute text" route is introduced. Overlay, microphone,
wake word, STT, TTS, voice assets, providers, LLM fallback, knowledge
integration, and real action execution are later features.
