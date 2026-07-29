# Home Assistant Device Contract

## 1. Fixed ownership decision

Home Assistant owns and controls the smart-home devices currently in scope:

- **coffee machine** — P0 priority and mandatory MVP widget;
- **kettle** — supported device, lower priority than the coffee machine in the first MVP.

For the coffee machine, Home Assistant is the **only authoritative runtime source** for:

- current on/off state;
- availability;
- time of the last activation;
- warm-up start time;
- warm-up duration or target-ready time;
- ready/running/too-long state where these are represented in HA;
- command verification after turn-on/turn-off.

`AliceTG_Bot` is a separate monitored service inside the wider HA stack. It may call Home Assistant or expose Telegram workflows, but it is **not** the source of truth for the coffee widget and must not be required to render current coffee state while HA itself is healthy.

## 2. Local discovery source

During development on the owner's Mac, Codex may read the Home Assistant project/configuration folder:

```text
/Users/aartemida/Documents/Homeassistant
```

This folder is **read-only** for Artem Control Center work.

Codex must inspect it to determine the actual implementation rather than guessing:

- coffee-machine entity id;
- kettle entity id;
- HA scripts/services used to turn them on and off;
- helpers, template sensors or input datetimes storing the last turn-on time;
- automations that calculate or persist warm-up state;
- warm-up duration and ready-state logic;
- long-running safety logic;
- relevant packages, templates, scripts and automations;
- whether useful fields come from entity state, attributes, events, history or helper entities.

Likely files include `configuration.yaml`, `automations.yaml`, `scripts.yaml`, `templates`, `packages` and related included YAML files. Exact structure must be discovered from the actual folder.

Do not expose, copy into documentation or commit values from:

- `secrets.yaml`;
- `.env` files;
- tokens;
- passwords;
- private webhook URLs;
- unrelated personal data.

## 3. Coffee data adapter

Panel Agent provides a dedicated `HomeAssistantCoffeeAdapter` or equivalent adapter built on the general Home Assistant integration.

It subscribes to relevant entities through the HA WebSocket API and uses REST/history only where needed.

Normalized contract:

```ts
type CoffeeMachineState = {
  deviceId: 'coffee-machine'
  authority: 'home-assistant'
  state:
    | 'off'
    | 'turning_on'
    | 'warming'
    | 'ready'
    | 'running'
    | 'running_too_long'
    | 'turning_off'
    | 'unavailable'
    | 'stale'
  available: boolean
  entityState: string | null
  turnedOnAt: string | null
  warmupStartedAt: string | null
  warmupDurationSeconds: number | null
  readyAt: string | null
  remainingSeconds: number | null
  progress: number | null
  runningDurationSeconds: number | null
  observedAt: string
  stale: boolean
  sourceEntities: string[]
}
```

Exact mapping from HA entities/attributes/helpers is created only after local configuration inspection.

## 4. Warm-up progress rules

Preferred source order:

1. explicit HA warm-up progress/remaining-time entity, if it exists;
2. explicit HA warm-up start time plus configured HA duration;
3. HA last-turn-on helper plus configured HA duration;
4. entity `last_changed` only if inspection proves that it reliably represents physical activation;
5. otherwise show a stage without a fabricated percentage.

The UI must never invent progress from a hard-coded duration when HA uses different logic.

When progress can be derived safely:

```text
elapsed = now - warmupStartedAt
progress = clamp(elapsed / warmupDuration, 0..1)
remaining = max(warmupDuration - elapsed, 0)
```

HA timestamps remain authoritative. Client clock skew must be considered and large inconsistencies surfaced as degraded data.

## 5. Commands

Coffee and kettle actions are executed through Home Assistant:

```text
Control Center UI
        ↓ registered action id
Panel Agent policy/action executor
        ↓ authenticated HA service/script call
Home Assistant
        ↓ device integration
Coffee machine or kettle
        ↓
HA entity update
        ↓ verification
Control Center success/failure
```

Allowed implementations after discovery:

- call an existing HA script;
- call an existing HA service against the exact entity;
- invoke an existing HA automation entry point designed for manual control.

Preferred order is to reuse existing HA scripts/safety logic rather than bypassing them with direct device calls.

Command success requires the corresponding HA state transition. HTTP success alone is insufficient.

## 6. Relationship with AliceTG Bot

`AliceTG_Bot` remains separately monitored for:

- process health;
- Telegram availability;
- its own schedules/timers/state;
- bot-specific workflows;
- restart and backup capability.

Rules:

- bot outage must not mark HA or the coffee device offline;
- coffee widget reads HA even if the bot is unavailable;
- coffee controls target HA, not a bot-specific HTTP endpoint;
- if the bot currently contains safety/timing behavior absent from HA, Codex must document the gap before implementation;
- safety logic needed by the device should preferably live in HA or be explicitly represented as a dependency, not silently hidden inside the UI.

## 7. Coffee-machine widget

The widget is mandatory P0 MVP.

It displays:

- authoritative label `Home Assistant`;
- current state and freshness;
- last activation time;
- warm-up start;
- real remaining time/progress where derivable from HA;
- ready state;
- running duration;
- long-running warning;
- action lifecycle and HA verification;
- clear degraded state when required HA helpers are missing or stale.

The widget must continue to render HA state when `AliceTG_Bot` is down.

## 8. Kettle

The kettle is included in the HA device registry from the beginning but is lower priority than the coffee-machine widget.

Initial support:

- HA availability and on/off state;
- last update/freshness;
- existing safe HA turn-on/turn-off script or service;
- command verification;
- Generic Home Device Widget initially, with a specialized widget later if useful.

No coffee-specific warm-up assumptions are reused for the kettle without inspecting its actual HA logic.

## 9. Required discovery output

Before implementing the real HA adapter, Codex creates inside the writable Control Center repository:

```text
docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md
```

It must contain, without secrets:

- files inspected;
- exact coffee and kettle entity ids;
- exact relevant scripts/services;
- state/attribute/helper mapping;
- warm-up calculation source;
- last-turn-on source;
- long-running logic;
- current gaps;
- proposed normalized contract mapping;
- required read/write changes in HA, described only — not applied;
- confidence level for each conclusion.

## 10. External-folder safety

The Home Assistant folder is an external read-only source.

Codex must not:

- edit or format files there;
- run migration or write commands there;
- install dependencies there;
- create commits there;
- alter HA configuration;
- restart HA;
- call production write actions during discovery.

Any proposed HA changes are documented as patches/specifications inside `artem-control-panel` for later review and manual implementation in the correct project.
