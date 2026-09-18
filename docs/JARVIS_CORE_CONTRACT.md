# Jarvis A1 text-first core

Jarvis A1 has one private, deterministic turn boundary:

```text
typed text (and future recognized speech text) -> closed intent -> bounded result -> canonical responseText
```

`POST /api/v1/jarvis/turn` accepts only `{ "text": string }`, with a 512-codepoint maximum and strict extra-field rejection. It returns `jarvis.turn.v1`, a closed intent ID, one bounded `responseText`, and, only where applicable, a navigation member from the source-owned allow-list. Responses are `Cache-Control: no-store`.

The classifier contract is `jarvis.intent.v1`. It NFC-normalizes, case-folds, normalizes Russian `ё`/`е` for matching, and collapses punctuation/whitespace. The registry is source-controlled: clients cannot submit intent IDs, routes, action IDs, HA entities/services, shell text, providers, paths, or URLs.

Supported executable A1 intents are:

- `system.time.current`
- `weather.read`
- `planning.calendar.read`, `planning.tasks.read`, `planning.reminders.read`
- `navigation.overview`, `navigation.calendar`, `navigation.tasks`, `navigation.reminders`, `navigation.settings`, `navigation.system`, `navigation.coffee_diary`
- `jarvis.repeat`, `jarvis.cancel`, `jarvis.stop`
- `general.question` fallback

Planning uses the existing normalized `PlanningProjection`; weather uses the existing `WeatherService` default configured location. A stale/unavailable source produces a short truthful response. Time uses the existing server-owned `PANEL_PLANNING_TIMEZONE` setting (default `Europe/Moscow`) and an injectable server clock.

`home.coffee.turn_on` is classified only as a future mutation concept and has no executor in A1. There is no generic action, Home Assistant, shell, update, Planning-write, provider, or LLM path.

The Jarvis overlay is global and keeps a bounded in-memory transcript (24 messages) for the active browser page. It never uses localStorage, runtime JSON, diagnostics, audit events, or ordinary production logs. Server repeat keeps only the immediate canonical response in process memory and repeats it exactly without rerunning a read source. The sole session metadata foundation is in-memory `lastSuccessfulInteractionAt`; transcript content is not persisted.

The overlay is intentionally below existing Sheets/notices/critical confirmation surfaces: Jarvis uses layer 180, regular sheet surfaces 200, access elevation 235, and destructive confirmations 240. An active Interaction Lock closes/disables Jarvis input, so it cannot serve as an alternate control path.

Audio, microphone permission, wake word, STT, TTS/RVC, voice assets/SFX, local/cloud LLMs, provider APIs, and all mutations are explicit later slices. Future speech text must enter this same bounded turn contract rather than a separate command execution route.
