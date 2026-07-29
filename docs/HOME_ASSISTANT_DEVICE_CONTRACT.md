# Home Assistant Device Contract

## 1. Fixed ownership decision

Home Assistant owns and controls the smart-home devices currently in scope:

- **coffee machine** — P0 priority and mandatory MVP widget;
- **kettle** — supported device, lower priority than the coffee machine in the first MVP.

For the coffee machine, Home Assistant is the **only authoritative runtime source** for:

- current on/off state;
- availability;
- entity state, attributes, `last_changed`, and `last_updated`;
- confirmed time of the last physical activation;
- execution of turn-on/turn-off;
- command verification after turn-on/turn-off.

Home Assistant helpers are the canonical source of the **user-configurable
timing policy**: warm-up duration and long-running threshold. `AliceTG_Bot`
is a Telegram editor for those helpers, never physical state/timing authority,
and never executes Control Center coffee commands.

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

Normalized contracts deliberately separate physical state from timing policy:

```ts
type CoffeeMachineState = {
  authority: 'home-assistant'
  entityId: 'switch.kofemashina'
  state: 'off' | 'on' | 'turning_on' | 'turning_off' | 'unavailable' | 'stale'
  available: boolean
  turnedOnAt: string | null
  entityLastChangedAt: string | null
  observedAt: string
  stale: boolean
}

type CoffeeTimingPolicy = {
  source: 'home-assistant'
  warmupDurationSeconds: number | null
  longRunningThresholdSeconds: number | null
  fetchedAt: string | null
  stale: boolean
  sourceAvailable: boolean
  sourceRevision: string | null
  initialized: boolean
}
```

The composite presentation model derives `warming`, `ready`,
`running_too_long`, progress, and remaining time. Bot health never replaces or
overrides HA state/timing.

## 4. Warm-up progress rules

Required inputs:

1. a confirmed HA `turnedOnAt` from a real `off → on` transition or a durable
   HA helper/history recovery;
2. the canonical `CoffeeTimingPolicy` from HA helpers, or an allow-listed
   last-known cache with explicit freshness;
3. a common calculation timestamp.

Bootstrap defaults are 13 minutes and 60 minutes, but they are written exactly
once by an explicit verified migration. The helpers have no permanent
`initial`; restored user values survive HA restart. Current runtime warm-up was
observed at 15 minutes. None of these values is a frontend constant.

When progress can be derived safely:

```text
elapsed = now - HA.turnedOnAt
progress = clamp(elapsed / haPolicy.warmupDurationSeconds, 0..1)
remaining = max(haPolicy.warmupDurationSeconds - elapsed, 0)
worksTooLong = elapsed >= haPolicy.longRunningThresholdSeconds
```

Calculation is disabled when HA activation time or timing policy is missing,
invalid, or too stale. In that case the widget shows the HA state as `running`
without a percentage. “Works too long” is a policy warning, not physical
overheating; `overheated` requires a real HA/device temperature or overheat
signal.

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
- HA connectivity and timing-helper availability;
- bot-specific workflows;
- restart and backup capability.

Rules:

- bot outage must not mark HA or the coffee device offline;
- coffee widget reads HA even if the bot is unavailable;
- coffee controls target HA, not a bot-specific HTTP endpoint;
- Telegram changes write the canonical HA helpers and require HA read-back;
- bot-local defaults are migration input only and never runtime authority;
- bot outage does not affect current timing while HA remains healthy;
- cached HA timing may be shown with source and timestamp when HA is offline,
  but cannot make the physical state current.

Notification ownership is separate from device/timing authority:
`AliceTG_Bot` owns coffee notification policy, per-channel delivery receipts
and retries, while Panel Agent owns service-health, backup and operation
notifications. See
[`NOTIFICATION_ARCHITECTURE.md`](NOTIFICATION_ARCHITECTURE.md). The browser is
not a notification executor and Panel Agent must not duplicate bot-owned coffee
events.

## 7. Coffee-machine widget

The widget is mandatory P0 MVP.

It displays:

- authoritative label `Home Assistant`;
- current state and freshness;
- last activation time;
- HA-confirmed activation time;
- current/cached HA timing-policy freshness;
- real remaining time/progress only when both inputs are trustworthy;
- ready state;
- running duration;
- long-running warning;
- action lifecycle and HA verification;
- clear timing-degraded state when policy or activation time is missing/stale.

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
