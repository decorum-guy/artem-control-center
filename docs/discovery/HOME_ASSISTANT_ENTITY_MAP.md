# Home Assistant Entity Map

Discovery date: 2026-07-29  
Sources: `/Users/aartemida/Documents/Homeassistant` and read-only SSH alias
`ha-vps`  
Initial mode: read-only discovery

## 2026-07-29 implementation follow-up

The user subsequently authorized local changes. The local HA configuration now
includes `packages/coffee_control_center.yaml` and a connected
`homeassistant.packages` include. The review bundle is under
`integration-patches/home-assistant/`.

Canonical entities added locally, not deployed:

- `input_number.coffee_warmup_minutes` (initial 13);
- `input_number.coffee_long_running_minutes` (initial 60);
- `input_datetime.coffee_last_turned_on`;
- `binary_sensor.coffee_machine_running`;
- `binary_sensor.coffee_machine_running_too_long`;
- `sensor.coffee_ready_at`;
- `sensor.coffee_timing_policy_revision`;
- `script.coffee_turn_on`, `script.coffee_turn_off`;
- `script.kettle_boil`, `script.kettle_stop`.

The exact `off → on` automation records the HA entity timestamp and cannot fire
for startup, reconnect or duplicate `on` updates. Timing policy is now
canonical in HA. AliceTG Bot is a Telegram editor for the helpers and a
separately monitored service, not timing authority. No HA reload/restart or
device action was performed.

## Scope and safety

This report originally separated Home Assistant device state from bot-owned
timing. The implementation follow-up supersedes that split: Home Assistant is
now the authority for physical state, timing helpers, commands and verification.
The bot only edits the HA timing helpers.

During initial discovery no external file was changed. During the authorized
follow-up, only the local non-secret HA configuration files listed above were
changed. No Home Assistant service, deploy, restart, migration, or production
API write was executed. `secrets.yaml`, real `.env` files, tokens,
passwords, private webhook values, runtime state JSON, databases, and `.storage`
were not read. Secret references such as `!secret internal_webhook_secret` were seen
only as symbolic references.

The live host check was limited to service/container state, Git metadata,
non-secret YAML, hashes, and targeted source references. At 2026-07-29 the
`homeassistant` and `telegram-bot` containers were both running.

## Files inspected

Home Assistant configuration:

- `AGENTS.md`
- `HomeAssistant_Server_Config/config/configuration.yaml`
- `HomeAssistant_Server_Config/config/automations.yaml`
- `HomeAssistant_Server_Config/config/scripts.yaml`
- `HomeAssistant_Server_Config/config/scenes.yaml`
- `HomeAssistant_Server_Config/ha-push.sh`
- `HomeAssistant_Server_Config/ha-push.env.example`
- `HomeAssistant_Server_Config/DEPLOYMENT.md`
- `HomeAssistant_Server_Config/docker-compose.yml`

Related bot source, used only to identify HA calls and to separate bot-owned timing:

- `TG_Alisa_Assistant_Bot/app/config.py`
- `TG_Alisa_Assistant_Bot/app/main.py`
- `TG_Alisa_Assistant_Bot/app/services/app_state.py`
- `TG_Alisa_Assistant_Bot/app/services/coffee_machine.py`
- `TG_Alisa_Assistant_Bot/app/services/coffee_alerts.py`
- `TG_Alisa_Assistant_Bot/app/services/home_assistant.py`
- `TG_Alisa_Assistant_Bot/app/services/pushward.py`
- `TG_Alisa_Assistant_Bot/app/web/internal_routes.py`
- `TG_Alisa_Assistant_Bot/app/workflows/tea.py`
- `TG_Alisa_Assistant_Bot/app/handlers/tea.py`
- relevant sections of `TG_Alisa_Assistant_Bot/README.md`

## Include topology

`configuration.yaml` contains:

```yaml
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
```

It also includes frontend themes through `!include_dir_merge_named themes`.
No packages or additional template directories affecting coffee or kettle were
found in the provided copy. `scripts.yaml` is empty. No HA template sensor,
`input_datetime`, `input_number`, or timer for coffee warm-up was found.

Read-only SSH confirmed that production `configuration.yaml` and `scripts.yaml`
have the same SHA-256 hashes as the provided copy. Production
`automations.yaml` is newer than the local copy, so its coffee-related blocks
were inspected separately; they preserve the same state-forwarding and
notification-off behavior described below. The live YAML still has no included
packages, templates, `input_datetime`, `input_number`, or timers for coffee.

Confidence: **high for file-backed production configuration**. A UI-created
entity stored only in `.storage` remains unverified because `.storage` was
intentionally not read.

## Exact entities and services

| Purpose | Exact entity/service | Verified source | Confidence |
| --- | --- | --- | --- |
| Coffee power | `switch.kofemashina` | HA automations and bot default config | High |
| Coffee voltage | `sensor.kofemashina_tekushchee_napriazhenie` | bot source default | Medium |
| Coffee power draw | `sensor.kofemashina_potrebliaemaia_moshchnost` | bot source default | Medium |
| Coffee current | `sensor.kofemashina_potreblenie_toka` | bot source default | Medium |
| Kettle | `water_heater.chainik` | bot source default and workflow | High for configured runtime; not present in copied HA YAML |
| Kettle keep-warm | `switch.chainik_podderzhanie_tepla` | bot source default and workflow | High for configured runtime |
| Kettle light | `switch.chainik_podsvetka` | bot source default and handler | High for configured runtime |
| Kettle mute | `switch.chainik_bez_zvuka` | bot source default and handler | High for configured runtime |
| Coffee on/off | `switch.turn_on` / `switch.turn_off` targeting `switch.kofemashina` | bot HA client and HA notification automation | High |
| Kettle boil | `water_heater.set_temperature` with `temperature: 100` targeting `water_heater.chainik` | bot workflow | High |
| Kettle stop | `water_heater.set_operation_mode` with `operation_mode: off` | bot workflow | High |
| Keep-warm on/off | set kettle temperature, then `switch.turn_on`/`switch.turn_off` for keep-warm switch | bot workflow | High |

There are no dedicated coffee/kettle HA scripts in the provided `scripts.yaml`.
The existing implementation uses domain services directly. Control Center may
register only these exact calls after a read-only live capability check and
separate approval for production writes.

## Existing HA automations relevant to coffee

### `coffee_machine_state_to_telegram_bot`

- Watches `switch.kofemashina`.
- Triggers only for transitions to `on` or `off`.
- Sends `entity_id`, `state`, and `trigger.to_state.last_changed.isoformat()` to
  the bot's internal state endpoint.

This makes the HA entity transition authoritative. The bot receives a copy; it
does not become the device authority.

### `iphone_coffee_notification_turn_off`

- Handles HA Mobile notification action `COFFEE_TURN_OFF`.
- Calls `switch.turn_off` on `switch.kofemashina`.
- Clears/status-updates mobile notifications.

### `Кофемашина - очистить iPhone уведомления при выключении`

- Watches `switch.kofemashina` changing to `off`.
- Clears coffee-related notification tags.

No automatic physical safety shutoff was found in the provided HA YAML.

## Last activation and `last_changed`

The only HA-native activation timestamp found is
`switch.kofemashina.last_changed`. The state-change automation forwards that
timestamp to the bot. The bot persists its copy as `coffee_on_since`, but that
JSON state belongs to `AliceTG_Bot`, not HA.

`last_changed` is usable for an observed `off → on` transition during an
uninterrupted HA runtime. It is not accepted as a durable last-activation
contract because an HA restart/state restoration can change timestamp semantics.
The current bot also uses `last_changed` for its runtime clock.

Recommended adapter behavior:

1. subscribe to `switch.kofemashina` through HA WebSocket;
2. retain the HA event timestamp in the Panel Agent last-known cache;
3. on reconnect, query HA history for the latest real `off → on` transition if
   the entity is already on;
4. mark `turnedOnAt` degraded/unknown if that transition cannot be proved;
5. do not read the bot's state file as an authority fallback.

Confidence: **high** that no dedicated helper exists in file-backed live YAML;
**medium** that live HA has no UI-created helper, pending a scoped read-only
entity-registry API check.

## Warm-up, ready, and long-running logic

### Verified HA state

No HA entity/helper/template/automation representing:

- warm-up start;
- warm-up duration;
- ready-at;
- progress;
- remaining time;
- ready;
- running-too-long;

was found in the provided configuration.

### Bot-only logic

`AliceTG_Bot` persists:

- `coffee_on_since`;
- configurable warmed-up delay;
- configurable long-running delay;
- delivered-alert flags.

Its source defaults are currently 13 minutes for warmed-up and 60 minutes for
long-running. Users can change both through Telegram. They are examples and
fixtures, never frontend constants. This was the discovery-time model. The
implementation follow-up migrates the values into canonical HA helpers;
bot-local values are legacy migration input.

The bot ignores duplicate `turn_on` when HA already reports the switch as on.
Its scheduler also ignores duplicate `state=on` events and preserves the
existing `coffee_on_since`.

### Current honest Control Center mapping

- `off` → normalized `off`;
- HA `unavailable`/`unknown`, missing entity, or failed authenticated read →
  `unavailable`;
- healthy HA with an old cached sample → `stale`;
- HA `on` with a newly observed command still verifying → `turning_on`;
- HA `on` plus confirmed HA activation time plus sufficiently fresh HA timing
  helpers → derive `warming`, `ready`, `running_too_long`, progress, and
  remaining time;
- HA `on` with missing/stale timing policy or unproved activation time →
  `running` with `progress: null`, `remainingSeconds: null`, and a clear reason;
- requested off while waiting for HA confirmation → `turning_off`;
- bot availability never changes HA device availability;
- HA unavailable always maps to `unavailable`, even if timing policy is fresh.

Show a stage without percentage when either source is unreliable. The UI must
not infer 13/60 minutes from source defaults.

## Progress and remaining-time calculation

Production calculation is authorized only after both inputs are trustworthy:

```text
elapsed = now - HA.turnedOnAt
progress = clamp(elapsed / botPolicy.warmupDurationSeconds, 0..1)
remainingSeconds = max(botPolicy.warmupDurationSeconds - elapsed, 0)
worksTooLong = elapsed >= botPolicy.longRunningThresholdSeconds
```

The adapter must reject nonsensical clock skew, require freshness timestamps, and
leave progress null when either input is missing or untrusted. The long-running
threshold means “работает слишком долго”; it is not physical overheating
without a real HA/device sensor.

## Kettle normalized mapping

Available fields used by the existing implementation:

- entity state of `water_heater.chainik`;
- `attributes.operation_mode`;
- `attributes.current_temperature`;
- configured/target `attributes.temperature` where exposed;
- states of keep-warm/light/mute switches;
- HA `last_changed`/`last_updated`.

Proposed normalized mapping:

- missing/`unavailable`/`unknown` → `unavailable`;
- entity `off` and operation mode `off` → `off`;
- entity `on` or operation mode other than `off` → `on`;
- freshness threshold exceeded → same last-known state with `stale: true`.

Boil verification must confirm the HA water-heater state/operation mode and, when
available, the target temperature. Stop verification must confirm operation mode
`off` and keep-warm switch `off`.

## Data transport

Panel Agent should use:

- HA WebSocket subscription for live state transitions and timestamps;
- HA REST `/api/states/{entity_id}` for initial/recovery snapshots;
- HA history only to recover a provable activation transition after reconnect;
- allow-listed HA timing helpers plus timestamped Panel Agent cache;
- registered HA service calls for future approved actions;
- no dependency on `AliceTG_Bot` for rendering coffee/kettle state.

Coffee state and timing remain visible when the bot is down as long as
authenticated HA state/helpers are healthy. A fresh cached HA policy may
continue timing presentation; stale/missing HA timing removes progress and
explains the degradation. Bot health is a separate Generic Service Widget.

## Safety behavior

- Coffee actions reuse `switch.turn_on`/`switch.turn_off` through HA.
- Kettle actions reuse `water_heater` and exact supporting switch services.
- A duplicate coffee turn-on must be treated as idempotent and must not reset a
  timer.
- HTTP 200 from HA is not success; the target entity transition must be
  observed.
- No production write action is enabled by this discovery.
- No long-running auto-shutoff was found. The UI must not claim one exists.

## Gaps and required external changes

NOT APPLIED — READ-ONLY DISCOVERY.

1. Add HA-owned, durable coffee activation timestamp (helper/template trigger
   sensor) that survives bot outage and has documented restart semantics.
2. Add an authenticated read-only bot endpoint such as
   `GET /api/v1/coffee/timing-policy`, returning only
   `warmup_duration_seconds`, `long_running_threshold_seconds`, `updated_at`,
   and `revision`.
3. Cache timing policy with fetch time, revision, and stale state. Never expose
   Telegram/HA tokens, chat IDs, webhook URLs, or unrelated bot configuration.
4. Prefer dedicated HA scripts for coffee/kettle actions if safety preconditions,
   idempotency, and verification should be centralized.
5. Confirm the live HA entity registry and service schemas with a scoped
   read-only development credential.

## Live host confirmation

Read-only SSH on 2026-07-29 confirmed:

- host kernel `Linux 6.8.0-134-generic`;
- `homeassistant` container up for approximately two weeks;
- `telegram-bot` container up for approximately seven days;
- bot checkout clean on `main` at
  `494e53489f835aabd6444e88092367cd0107d920`;
- bot source still defines `switch.kofemashina`,
  `water_heater.chainik`, the three kettle switches, and bot-owned defaults of
  13 minutes / 60 minutes;
- production `scripts.yaml` is zero bytes;
- no file-backed HA warm-up, ready, progress, remaining-time, or long-running
  entity was found.

These observations do not authorize production service calls. They establish
the bot as timing-policy authority, not physical-state authority.
6. Confirm whether history retention is sufficient to recover activation after
   reconnect.

## Conclusion confidence

| Conclusion | Confidence |
| --- | --- |
| Coffee entity is `switch.kofemashina` | High |
| Direct coffee services are `switch.turn_on/off` | High |
| Kettle entity is `water_heater.chainik` | High for bot-configured runtime; medium until live HA read |
| Provided HA YAML contains no warm-up helper/duration/ready sensor | High |
| User-configurable warm-up/long-running policy currently lives in bot state | High |
| `last_changed` is the only discovered HA activation timestamp | High |
| `last_changed` is durable across HA restarts | Not verified; do not assume |
| HA has an automatic coffee safety shutoff | Not found / unknown |
| Coffee widget can read HA while Alice bot is down | High, by direct HA adapter design |

External folder confirmation: `/Users/aartemida/Documents/Homeassistant` was not
modified.
