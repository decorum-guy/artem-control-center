# Notification architecture

Status: discovery and target contract. No production change is implemented by
this document.

## 1. Scope and evidence

This discovery covers coffee notifications only where current runtime evidence
exists, plus the ownership boundary for future Control Center notifications.
Facts and target decisions are intentionally separated.

Verified sources:

- read-only AliceTG Bot source inspection:
  `app/services/app_state.py`, `app/services/coffee_alerts.py`,
  `app/services/telegram_messages.py`, `app/services/pushward.py`,
  `app/handlers/coffee.py`, `app/config.py` and
  `app/web/internal_routes.py`;
- one sanitized read-only `ha-vps` query of the bot's allow-listed coffee
  state fields;
- a sanitized structural scan of production Home Assistant YAML and entity
  registry data;
- the earlier coffee activation snapshot in
  [`discovery/COFFEE_RUNTIME_BASELINE.md`](discovery/COFFEE_RUNTIME_BASELINE.md).

The inspection did not emit tokens, Telegram identifiers, notification target
names, message bodies, webhook URLs or raw environment data. No HA service,
bot endpoint, migration, reload, restart or state-changing command was called.

## 2. Verified current ownership

### 2.1 Notification settings

AliceTG Bot persists its mutable application state in the JSON file selected by
`APP_STATE_PATH` (default runtime location: `/app/data/state.json`). Writes are
serialized by an async lock and saved with a temporary-file replacement.

There is no single global `Telegram enabled` or `iPhone enabled` coffee
setting. Channel selection is per event:

| Meaning | Persisted bot key | Default when absent |
| --- | --- | --- |
| Warm-up notification enabled | `coffee_warmed_up_alert_enabled` | legacy `coffee_alerts_enabled`, otherwise `true` |
| Long-running notification enabled | `coffee_long_running_alert_enabled` | legacy `coffee_alerts_enabled`, otherwise `true` |
| Warm-up via Telegram | `coffee_warmed_up_notify_telegram` | `true` |
| Warm-up via iPhone | `coffee_warmed_up_notify_iphone` | `true` |
| Long-running via Telegram | `coffee_long_running_notify_telegram` | `true` |
| Long-running via iPhone | `coffee_long_running_notify_iphone` | `true` |

The Telegram settings UI calls the corresponding `AppStateStore` setters.
Changing the warm-up or long-running duration is different: those values are
canonical Home Assistant timing helpers in the prepared architecture, not
notification-channel settings.

A sanitized production snapshot found both event classes enabled. Telegram was
disabled for both event classes, and iPhone was enabled for both. These are
mutable user settings, not product defaults or frontend constants.

### 2.2 Delivery receipts

Receipts are also persisted in the bot state file and are reset when a new
confirmed coffee cycle starts or the coffee machine turns off.

| Event | Telegram receipt | iPhone receipt | Legacy common receipt |
| --- | --- | --- | --- |
| Warm-up completed | `coffee_warmed_up_alert_telegram_sent` | `coffee_warmed_up_alert_iphone_sent` | `coffee_warmed_up_alert_sent` |
| Running too long | `coffee_long_running_alert_telegram_sent` | `coffee_long_running_alert_iphone_sent` | `coffee_long_running_alert_sent` |

The current scheduler does not persist a separate modern
`overall_delivered` field. It computes overall delivery as follows:

1. include Telegram when that event's Telegram channel is enabled;
2. include iPhone only when that event's iPhone channel is enabled and at
   least one mobile delivery target is configured;
3. treat the legacy common receipt as a compatibility success for either
   channel;
4. consider the event delivered only when every effective enabled channel has
   a receipt;
5. if no effective channel exists, treat the event as having no pending
   delivery rather than retrying forever.

The legacy common receipt is therefore a compatibility shortcut, not the
canonical aggregate of the per-channel receipts. PushWard activity updates are
not included in this aggregate and currently have no equivalent persisted
per-event delivery receipt.

### 2.3 Home Assistant channel selection

Production Home Assistant contains coffee-related automations that:

- forward confirmed coffee state changes to the bot;
- handle the iPhone notification action that turns the coffee machine off;
- clear coffee mobile notifications after the device turns off.

The structural production scan found:

- no `coffee_warmed_up_notify*` or `coffee_long_running_notify*` policy keys;
- no coffee notification channel selector in `input_boolean`,
  `input_select` or `input_text`;
- no coffee automation whose notification delivery is conditioned by such a
  selector helper.

Other coffee-related `input_boolean` entities exist for conversational workflow
state, but they do not choose notification channels. Consequently, production
HA is not the current owner of Telegram/iPhone coffee-channel policy. No new HA
channel helpers are proposed without a separate product decision.

## 3. Verified delivery paths

### Telegram

```text
CoffeeAlertScheduler
  -> TelegramMessages.safe_send
  -> Telegram Bot transport
  -> recipient
  -> per-event Telegram receipt after confirmed API success
```

The scheduler owns bounded retries. A failed send does not set the receipt.

### HA Companion / iPhone

```text
CoffeeAlertScheduler
  -> HomeAssistantClient notification call
  -> configured HA Companion mobile target(s)
  -> iPhone
  -> per-event iPhone receipt after at least one successful HA call
```

The bot does not persist or expose the target names through the proposed
Control Center contract.

### PushWard Live Activity

```text
CoffeeAlertScheduler and coffee state lifecycle
  -> PushWardCoffeeActivity
  -> Home Assistant PushWard integration
  -> iOS Live Activity
```

The activity starts/restores with an active coffee cycle, receives warm-up and
long-running state changes, and ends after coffee turns off. Production has the
Live Activity feature enabled. A separate PushWard widget mirror is also
enabled and uses its own integration path; it is not a Telegram/iPhone
notification receipt.

PushWard is a presentation surface for the coffee lifecycle. Its success must
not be interpreted as Telegram or iPhone notification delivery.

## 4. Warm-up baseline

The activation baseline was a 15-minute warm-up. The 60-minute value was the
`running too long` warning threshold, not warm-up and not physical overheating.

For that warm-up cycle:

| Observation | Value | Evidence |
| --- | --- | --- |
| Telegram channel enabled | `false` | sanitized persisted channel policy |
| Telegram delivered | `false` | post-deadline per-channel receipt |
| iPhone channel enabled | `true` | sanitized persisted channel policy |
| iPhone delivered | `true` | post-deadline per-channel receipt |

Sanitized counts from the contemporaneous scheduler log support the same
result: zero Telegram attempts, one mobile attempt, one mobile success, one
`all effective channels delivered` outcome, and no retry or retry-exhaustion
event. No log lines, target names, identifiers or message bodies were copied.

The later read-only query occurred after the coffee machine had turned off, so
the bot had correctly reset cycle receipts to `false` and cleared
`coffee_on_since`. The table combines the persisted channel policy with the
already captured post-deadline receipt snapshot for the same documented
warm-up baseline; it does not reinterpret the reset post-cycle values as a
delivery failure.

At the later snapshot, long-running notifications remained enabled, Telegram
was disabled for that event, and iPhone was enabled. No 60-minute warning was
waited for or triggered by this discovery.

## 5. Target ownership model

| Domain or event | Sole authority / sender | Control Center role |
| --- | --- | --- |
| Coffee physical state, availability, confirmed activation and timing | Home Assistant | Read and normalize through Panel Agent |
| Coffee turn-on/turn-off and command confirmation | Home Assistant | Request an allow-listed HA action and verify HA state |
| Coffee warm-up and long-running notification policy | AliceTG Bot | Read/change through protected typed bot API |
| Coffee notification delivery, receipts and retry scheduling | AliceTG Bot | Display sanitized policy/delivery health; never duplicate delivery |
| Service health incidents | Panel Agent | Detect, deduplicate, deliver and record |
| Backup freshness/failure | Panel Agent | Detect, deduplicate, deliver and record |
| Registered operation result | Panel Agent | Verify, deliver and record |
| Browser presentation | No delivery authority | Show state and invoke protected Panel Agent APIs |

The browser UI must never be the only notification executor. A closed or
sleeping dashboard must not suppress coffee, service, backup or operation
notifications.

Each event type has exactly one delivery owner. In particular, Panel Agent
must not independently send `coffee.warmup_completed` or
`coffee.running_too_long` while AliceTG Bot owns them. If ownership is moved in
the future, the change requires an explicit event-version migration and a
single cut-over point; dual sending is not allowed.

## 6. Bot settings API contract

These endpoints are implemented in the AliceTG Bot feature branch and consumed
by Panel Agent in the Control Center feature branch. They remain undeployed and
all production mutation gates remain disabled.

### Security and transport

- Internal access only; never expose the endpoint directly to the browser.
- Panel Agent is the client presented to the dashboard.
- Reuse the bot's protected internal authentication boundary, with the secret
  supplied at runtime and never stored in frontend code, logs or Git.
- Use constant-time credential comparison.
- Require TLS or a trusted private transport when traffic leaves localhost.
- Never return tokens, Telegram identifiers, mobile target names, webhook
  URLs, raw environment values, message bodies or stack traces.
- Apply request-size limits, schema validation, rate limiting and an audit
  record containing only actor, changed field names, revision and timestamp.

### Types

```ts
type CoffeeNotificationEventSettings = {
  enabled: boolean
  channels: {
    telegram: boolean
    iphone: boolean
  }
}

type CoffeeNotificationSettings = {
  schemaVersion: 1
  source: 'alice-tg-bot'
  revision: string
  updatedAt: string | null
  warmup: CoffeeNotificationEventSettings
  longRunning: CoffeeNotificationEventSettings
}

type CoffeeNotificationSettingsPatch = {
  expectedRevision: string
  warmup?: {
    enabled?: boolean
    channels?: {
      telegram?: boolean
      iphone?: boolean
    }
  }
  longRunning?: {
    enabled?: boolean
    channels?: {
      telegram?: boolean
      iphone?: boolean
    }
  }
}
```

Timing values are deliberately absent. Warm-up duration and long-running
threshold remain Home Assistant data.

### `GET /internal/notification-settings/coffee`

Returns the complete current settings snapshot:

```json
{
  "schemaVersion": 1,
  "source": "alice-tg-bot",
  "revision": "opaque-revision",
  "updatedAt": "2026-07-29T13:20:00Z",
  "warmup": {
    "enabled": true,
    "channels": {
      "telegram": false,
      "iphone": true
    }
  },
  "longRunning": {
    "enabled": true,
    "channels": {
      "telegram": false,
      "iphone": true
    }
  }
}
```

Requirements:

- `200` only for a validated state snapshot;
- `401` for missing/invalid internal authentication;
- `503` when the persistent store cannot be read safely;
- `ETag` may mirror the opaque revision;
- no mutation and no side effect.

Delivery receipts are runtime diagnostics rather than settings and are not
silently overloaded into this response. A future diagnostics contract should
expose sanitized receipt booleans and cycle identity separately if the UI
needs them.

### `PATCH /internal/notification-settings/coffee`

Accepts a partial settings update with optimistic concurrency:

```json
{
  "expectedRevision": "opaque-revision",
  "warmup": {
    "channels": {
      "telegram": true
    }
  }
}
```

Requirements:

- reject unknown fields and non-boolean setting values;
- reject timing fields, channel names outside the allow-list and receipt
  mutation;
- compare `expectedRevision` with the current revision and return `409` on
  conflict;
- apply the patch atomically under the existing state-store lock;
- persist, read back and validate before returning success;
- return the same complete shape as `GET`, with a new revision;
- an idempotent retry of an already applied value must not reschedule or
  duplicate alert tasks unnecessarily;
- settings changes affect future pending delivery according to an explicitly
  tested scheduler policy; they never forge receipts;
- return `400` for invalid schema, `401` for invalid authentication, `409` for
  revision conflict and `503` for persistence failure.

## 7. Required implementation tests

Before implementing the endpoints:

- GET maps every current bot setting and applies legacy defaults consistently;
- PATCH updates only allow-listed fields and is atomic;
- stale revision returns `409`;
- unknown fields, receipt fields and timing fields are rejected;
- secrets and target names never appear in responses or logs;
- Telegram and iPhone receipts remain independent;
- overall delivery requires all effective enabled channels;
- a disabled or unconfigured channel does not create an infinite retry;
- PushWard success does not set Telegram/iPhone receipts;
- browser loss does not stop notification delivery;
- Panel Agent never sends bot-owned coffee events;
- one event-cycle ID cannot be delivered twice by competing owners.

## 8. Explicit non-actions

- No production configuration or state was changed.
- No notification was sent.
- No HA helper or automation was added.
- No bot endpoint or common notification executor was implemented.
- No general Panel Agent notification delivery was implemented.
- No HA reload/restart, bot restart, migration or deployment was performed.
