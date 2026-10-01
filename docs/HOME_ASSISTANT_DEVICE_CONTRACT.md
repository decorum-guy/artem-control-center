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

The kettle is included in the HA device registry from the beginning but is lower priority than the coffee-machine widget. Its physical absence does not degrade aggregate Home Assistant health; the kettle service reports offline/unavailable independently until a compatible entity exists again.

Initial support:

- HA availability and on/off state;
- last update/freshness;
- existing safe HA turn-on/turn-off script or service;
- command verification;
- Generic Home Device Widget initially, with a specialized widget later if useful.

No coffee-specific warm-up assumptions are reused for the kettle without inspecting its actual HA logic.

## 8.1 Typed climate and ROG G703 PSU controls

The production Panel Agent has a separate, fixed action router for the
following Home Assistant entities:

- `climate.konditsioner` — only HVAC modes `cool`, `heat`, `fan_only`, `dry`,
  `auto`, `off`; fan modes `one`–`five`; target temperature 16–32 °C with a
  1 °C step. A missing current temperature remains `null`.
- `switch.bp_1` and `switch.bp_2` — only state and HA timestamps are exposed;
  no watts, volts, amps or kWh telemetry is fabricated.

The six PSU action ids map to `full`, `normal`, BP1 on/off and BP2 on/off.
`normal` is always BP1 on and BP2 off. The backend verifies every service
request with fresh HA state; an HTTP 200 response alone is not success. It
never turns off a last confirmed-on PSU and returns `last_psu_off_blocked` when
the other PSU is off, unknown, unavailable, or otherwise not freshly confirmed
on. Climate and PSU actions have independent locks and independent gates.

The route accepts only the eleven typed action ids and bounded payload fields;
it is not a generic entity/domain/service proxy. The two new production gates
(`PANEL_HOME_CLIMATE_ACTIONS_ENABLED` and
`PANEL_ROG_G703_PSU_ACTIONS_ENABLED`) default to false and are additionally
guarded by `PANEL_WRITES_ENABLED`. Energy, Camelion, Alice, Jarvis, ROG-host,
updater, and hardware-discovery scope is unchanged.

## 8.2 Fixed Home Assistant maintenance

`PANEL_HOME_SERVER_MAINTENANCE_ENABLED=false` is the safe default. The deployed
Home Assistant is a Docker/Compose container alongside Caddy and AliceTG; its
lifecycle belongs to the host. With it and `PANEL_WRITES_ENABLED` enabled, the
Panel Agent uses the dedicated pinned `artem-home-control` SSH identity for:

- `system.home_assistant.restart` → fixed `restart-ha`;
- `system.home_assistant.update_core` → fixed `update-ha` pull/recreate;
- `system.home_server.caddy.restart` and `system.home_server.bot.restart`.

The browser never selects a command, path, Compose service, image, tag, host,
identity or JSON payload. The forced-command helper has a root-owned local
configuration with the physical Compose values; it never prints Compose env,
secrets or inspect output. `update.install` and its claimed backup are not used:
the helper reports `up_to_date` or verified recovery truthfully. A native HA
backup is not created in this slice.

There are three distinct SSH authorities: connectivity is tunnel-only and
unchanged; `artem-home-control` is the Panel Agent's forced-command product
identity; `artem-home-admin` is a separate owner/operator shell key and is
never in Panel Agent config or browser data. Docker/root-equivalent operator
access is privileged. An HA administrator token remains separately necessary
for the non-allowlisted `yandex_intent` subscription; this does not weaken it.

Physical setup installs repository helper `scripts/linux/home-maintenance` as
`/usr/local/lib/artem-control-center/home-maintenance` plus a root-owned
`/etc/artem-control-center/home-server.conf`. The control public key is bound
to that helper as an OpenSSH forced command. Its `authorized_keys` entry must
use the equivalent of `restrict,command="/usr/local/lib/artem-control-center/home-maintenance"`
plus explicit `no-pty,no-agent-forwarding,no-X11-forwarding,no-port-forwarding`;
it grants no arbitrary shell. The helper validates `SSH_ORIGINAL_COMMAND` as
exactly one fixed operation token. The root-owned
configuration supplies `COMPOSE_PROJECT_DIR`, `COMPOSE_FILE`, three service
names and optional server-local readiness URLs. It is deliberately not checked
into this repository. `scripts/windows/setup-home-server-ssh.ps1` creates
separate control/admin identities and requires an owner-verified known-host
pin; it never installs keys or contacts a physical server. The Panel Agent uses
explicit host, user, port, identity and known-host paths with an empty SSH
configuration (`-F NUL` on Windows), so neither alias configuration nor a
user's `%USERPROFILE%\\.ssh\\config` can supply a proxy, identity or user. The
admin alias is only for an owner-authorized operator session. If the restricted
account receives Docker-group access, that access is effectively privileged;
the forced-command key remains the product security boundary.

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

## 2026-09-29 kitchen kettle contract (issue #293)

The owner supplied the physical state of the replacement kettle. For Control
Center, `water_heater.kukhnia_chainik` supersedes the historical
`water_heater.chainik`. The panel watches only the new entity; the old
keep-warm, light and mute switches are not part of this contract.

`home.kettle.v1` exposes only the fixed entity ID, `stage`, `available`,
`currentTemperature`, `targetTemperature`, `operationMode`, ordered
`availableTeaModes`, `observedAt`, `stale` and the Home Assistant authority.
`currentTemperature` is read only from `attributes.current_temperature`;
`targetTemperature` is read only from `attributes.temperature`. Nonfinite,
out-of-range and nonnumeric values become `null`. Mode is confined to `on`,
`off` and the eight tea modes. Tea choices are the ordered intersection of
`operation_list` and the eight known tea modes. Unrecognized physical state or
mode cannot be used as a command.

`home.kettle.boil` is a fixed 100 °C intent. Under the kettle-only lock, Panel
Agent first reads the entity. An already confirmed 100 °C / `on` state needs
no service call. Otherwise it calls `water_heater.set_temperature` with
`temperature: 100`, waits for target read-back, then calls
`water_heater.set_operation_mode` with `operation_mode: on`, and waits for a
fresh final read confirming both values and an active entity state. The target
step is first so the final `on` command starts the intended 100 °C heating.
Failure after the first mutation is reported without retry or rollback.

`home.kettle.set_tea_mode` accepts only the eight known tea IDs, requires the
mode to be advertised by the current entity, calls the fixed
`water_heater.set_operation_mode` service, and verifies fresh read-back. The
kettle integration owns tea temperatures. For the verified Polaris PWK 1712CGLD
through YandexStation 3.22.0, tea activation normalizes to `state: on` and
`operation_mode: on`. The server-owned preset targets are white 65, green 80,
red 90, herbal 90, flower 80, puerh 95, oolong 90, and black 100 °C. Confirmation
requires both active fields and the requested preset's target through fresh
REST. After mutation, timezone-aware `last_updated` must be newer than the
authoritative pre-command HA REST observation. Freshness uses only advancement
of the HA entity's own timestamp, without comparing to Panel Agent wall-clock
UTC or requiring synchronized host clocks. An unchanged `last_changed` alone
cannot verify a target change. An already-active matching
target returns confirmed without mutation. Presets sharing a target represent
the same observable heating contract; no unique tea label is invented in the
snapshot. Source and physical evidence are recorded in
`docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md` under issue #315.
`home.kettle.stop` accepts only `actionId` and the UUID `requestId`, including
rejecting null value fields. Under the same kettle lock, it reads the fixed
`KETTLE_ENTITY` fresh through HA REST. An initial `state: off` and
`operation_mode: off` returns confirmed without a mutation. Otherwise a valid
timezone-aware pre-command HA `last_updated` is required before calling
`water_heater.set_operation_mode` once with `operation_mode: off`. The verifier
polls fresh REST every 250 ms for up to 5 seconds and requires both `off` fields
and a valid timezone-aware `last_updated` strictly newer than the pre-command
HA timestamp. Missing, malformed, naive, identical or older timestamps cannot
confirm. Target temperature is not part of stopped-state verification. No
Panel Agent/Samsung wall-clock comparison or automatic mutation retry is used.
The response includes the final observed kettle values, `state` and
`lastUpdated`; the UI continues to render refreshed HA state.

The stop path is supported by pinned
[`AlexxIT/YandexStation@453a96b`](https://github.com/AlexxIT/YandexStation/blob/453a96b232aeb185e482461f842e047bbfca1cb2/custom_components/yandex_station/water_heater.py):
`async_set_operation_mode("off")` dispatches `device_action("on", False)`.
The active Home/Overview primary button becomes **Остановить**, using the
existing two-button layout and at least 48 px touch targets. Stop is a low-risk
action without an additional destructive-action confirmation.

All three actions require Standard access,
`PANEL_WRITES_ENABLED=true`, a current HA mutation transport/entity, and the
independent `PANEL_KETTLE_ACTIONS_ENABLED` gate, which defaults to false.
The browser never supplies an entity, service, or temperature. Existing boil
and tea-mode execution/verification contracts are unchanged by stop (issue #317).
