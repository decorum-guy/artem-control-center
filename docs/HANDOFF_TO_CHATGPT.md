# Handoff to ChatGPT: Coffee vertical slice

Date: 2026-07-29  
Status: implemented in Draft PRs; not deployed  
Primary review: [Artem Control Center PR #14](https://github.com/decorum-guy/artem-control-center/pull/14)  
Bot review: [AliceTG Bot PR #1](https://github.com/decorum-guy/AliceTG_Bot/pull/1)

This document contains the complete GitHub-first continuation context. No
production secret, Telegram identifier, notification target or private webhook
is included.

## 1. Architecture and authority

```text
Dashboard browser
  <- SSE revision hints + HTTP snapshot reconciliation
  -> typed localhost Panel Agent API
  -> fixed AliceTG Bot internal coffee API
  -> Home Assistant helpers/device
```

| Field or operation | Canonical authority | Transport / executor |
| --- | --- | --- |
| Coffee physical state and availability | Home Assistant | Panel Agent HA REST + WebSocket |
| Confirmed activation timestamp | Home Assistant | `input_datetime.coffee_last_turned_on` |
| Warm-up duration | Home Assistant | `input_number.coffee_warmup_minutes` |
| Long-running warning threshold | Home Assistant | `input_number.coffee_long_running_minutes` |
| Timing edits from Telegram | Home Assistant | AliceTG Bot `CoffeeTimingPolicyService` |
| Timing edits from dashboard | Home Assistant | Panel Agent → AliceTG Bot `CoffeeTimingPolicyService` |
| Notification enable/channel policy | AliceTG Bot persistent state | Protected bot API |
| Coffee notification delivery, receipts and retries | AliceTG Bot | Bot scheduler |
| Coffee turn-on/turn-off | Home Assistant | Narrow bot action gateway + HA read-back |
| Browser credentials | None | Browser calls Panel Agent only |

The 60-minute value is a `running too long` warning threshold, not warm-up and
not a physical overheat signal. Frontend code contains no 13/15/60 timing
constant; fixture values arrive through the same typed dashboard API shape.

### Transport matrix

| Source → consumer | Transport | Cadence / recovery |
| --- | --- | --- |
| Home Assistant → Panel Agent | REST initial snapshot + WebSocket `state_changed` | reconnect with bounded backoff; allow-listed entities only |
| AliceTG Bot settings → Panel Agent | fixed typed HTTP | request-driven with sanitized last-known cache |
| AVALAR Site → Panel Agent | HTTP live/ready polling | shared-hosting polling only; no daemon/WebSocket |
| Panel Agent → browser | SSE `/api/v1/events` | non-durable revision hints |
| Browser → Panel Agent | GET `/api/v1/snapshot` | initial, after SSE, after reconnect, visibility restore and periodic fallback |

`DashboardSnapshot` is the canonical browser reconciliation payload. SSE never
contains raw HA state or secrets and does not guarantee durable delivery.
Missing any event is recovered by a complete snapshot GET.

## 2. Implemented endpoints

### AliceTG Bot

All five routes require:

```text
Authorization: Bearer <CONTROL_CENTER_API_TOKEN>
```

Routes:

```text
GET   /internal/notification-settings/coffee
PATCH /internal/notification-settings/coffee
GET   /internal/control-center/coffee/timing
PATCH /internal/control-center/coffee/timing
POST  /internal/control-center/coffee/action
```

`CONTROL_CENTER_API_TOKEN` is independent from the existing personal
`SHORTCUTS_SECRET_TOKEN`. The personal `/shortcut/espresso` contract and its
authentication remain unchanged.

Notification settings contain only:

- warm-up notification enabled;
- warm-up Telegram/iPhone enabled;
- long-running notification enabled;
- long-running Telegram/iPhone enabled.

Timing and delivery receipts are rejected from notification PATCH. PATCH uses
an opaque `expectedRevision`, forbids unknown fields, saves atomically and
reschedules active alerts once only when settings effectively changed.

Timing GET/PATCH reads and writes the two HA helpers. PATCH:

- accepts at least one whole-minute field;
- checks current HA revision;
- validates the actual helper `min`, `max` and `step`;
- writes through `input_number.set_value`;
- reads both helpers back;
- attempts rollback if a multi-field update fails;
- never changes the initialization marker or writes defaults on error.

Actions accept only `turn_on` and `turn_off` plus a constrained `requestId`.
They have a bounded in-process idempotency cache, serialized execution,
rate-limit, pre-read and HA confirmation read-back. Already-satisfied state is
a confirmed no-op and does not create a new activation cycle.

### Panel Agent

```text
GET   /api/v1/snapshot
GET   /api/v1/events
GET   /api/v1/settings/coffee/timing
PATCH /api/v1/settings/coffee/timing
GET   /api/v1/settings/notifications/coffee
PATCH /api/v1/settings/notifications/coffee
POST  /api/v1/actions/home/coffee
```

Panel Agent attaches the upstream Bearer token server-side. It never returns
that token to the browser. There is no generic forwarding route.

Independent mutation gates:

```text
PANEL_WRITES_ENABLED
PANEL_COFFEE_TIMING_WRITES_ENABLED
PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED
PANEL_COFFEE_ACTIONS_ENABLED
```

A mutation requires the global gate and its specific coffee gate. All default
to `false`. Timing and action mutations additionally refresh the Panel Agent HA
snapshot and compare the new helper/device state with the bot-confirmed result.
Mutation responses use `Cache-Control: no-store`.

`SnapshotPublisher` owns the latest normalized snapshot. Meaningful service,
source, health, capability or data changes increment a process-local monotonic
revision and update `generatedAt`. Volatile freshness/latency/observation
timestamps do not by themselves create revisions. Subscriber queues hold only
the latest revision, so slow/disconnected browsers cannot block adapters or
leak unbounded memory.

SSE event types:

- `connected` with current revision and generation time;
- `snapshot` with the new revision;
- `heartbeat` with current revision.

The browser performs a deduplicated full GET after a newer revision and after
every reconnect. It keeps a calm 45-second reconciliation while SSE is healthy,
falls back to 5-second polling while visible if SSE fails, uses a non-aggressive
60-second interval while hidden, and refreshes immediately on visibility
restore. One coordinator owns an AbortController and coalesces concurrent
refresh requests.

GET responses expose `live`, `stale` or fixture source mode. The server-side
Alice client retains the latest successful GET as an in-memory stale fallback.

### Dashboard

`/settings` contains a compact Coffee section:

- current warm-up and long-running values from the API;
- explanation that values are shared with Telegram and stored in HA;
- pending, confirmed, validation, conflict, unavailable and writes-disabled
  states;
- separate warm-up and long-running notification/channel toggles;
- a 30-second refresh that observes Telegram-side timing changes without a
  dashboard restart.

Home and Overview coffee buttons use the typed action endpoint. Disabled gates
have an explicit explanation. Enabled turn-on requires confirmation, displays
pending state and reports only the HA-confirmed result. After confirmation the
browser fetches a complete snapshot; it never manually mutates the coffee
service. Timeout/unknown result never produces fake success.

Coffee elapsed/progress/remaining presentation uses a local one-second clock
anchored to the last snapshot time. It derives state only from HA
`turnedOnAt` and canonical timing helpers; stale/unavailable timing disables
precise derivation. Warming can therefore become ready and later
running-too-long without waiting for another snapshot.

## 3. Environment variables

Values are intentionally omitted.

AliceTG Bot:

```text
CONTROL_CENTER_API_TOKEN
SHORTCUTS_SECRET_TOKEN
HA_URL
HA_LONG_LIVED_TOKEN
APP_STATE_PATH
COFFEE_TIMING_REFRESH_INTERVAL_SECONDS
COFFEE_TIMING_STALE_AFTER_SECONDS
COFFEE_TIMING_REFRESH_MAX_BACKOFF_SECONDS
```

Panel Agent:

```text
PANEL_ALICE_BASE_URL
PANEL_ALICE_CONTROL_CENTER_TOKEN
PANEL_HA_URL
PANEL_HA_TOKEN
PANEL_HA_STALE_AFTER_SECONDS
PANEL_WRITES_ENABLED
PANEL_COFFEE_TIMING_WRITES_ENABLED
PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED
PANEL_COFFEE_ACTIONS_ENABLED
PANEL_HTTP_REQUEST_TIMEOUT_SECONDS
PANEL_SSE_HEARTBEAT_SECONDS
```

`PANEL_ALICE_CONTROL_CENTER_TOKEN` and `CONTROL_CENTER_API_TOKEN` must contain
the same newly generated value at deployment. Neither is the personal Shortcut
token.

## 4. Branches and review commits

| Project | Branch | Review commit at handoff preparation | Draft PR |
| --- | --- | --- | --- |
| Artem Control Center | `feat/local-integrations-foundation` | reviewed base `f55394f`; rollout-correction commit is the PR HEAD | [#14](https://github.com/decorum-guy/artem-control-center/pull/14) |
| AliceTG Bot | `feat/control-center-ha-timing` | `b4a8825d2c3725052a40414ae93a7e70bdd937d1` | [#1](https://github.com/decorum-guy/AliceTG_Bot/pull/1) |
| AVALAR | `feat/control-center-integration` | `ef7d119` | [#1](https://github.com/decorum-guy/AVALAR/pull/1); unchanged by this slice |

Use the PR metadata as the authoritative full SHA after documentation
publication.

## 5. Files changed in this slice

AliceTG Bot:

- `.env.example`, `README.md`;
- `app/config.py`, `app/main.py`;
- `app/services/app_state.py`;
- `app/services/coffee_timing_policy.py`;
- `app/services/control_center_coffee.py`;
- `app/web/internal_routes.py`;
- `docs/CONTROL_CENTER_API.md`;
- `tests/test_coffee_timing_policy.py`;
- `tests/test_control_center_api.py`.

Control Center:

- dashboard: `App.tsx`, `CoffeeSettings.tsx`, `coffeeApi.ts`, `pages.tsx`,
  `snapshotStream.ts`, `widgets.tsx`, `styles.css`;
- Panel Agent: `alice_control.py`, `contracts.py`, `home_assistant.py`,
  `integrations.py`, `main.py`, `settings.py`, `snapshot.py`;
- shared TypeScript contracts;
- Panel Agent and Playwright tests;
- development and integration documentation.

## 6. Tests and exact commands

AliceTG Bot:

```text
/Users/aartemida/Documents/artem-control-panel-proj/.tooling/alice-bot-venv/bin/python \
  -m unittest discover -s tests -v
/Users/aartemida/Documents/artem-control-panel-proj/.tooling/alice-bot-venv/bin/python \
  -m compileall app tests
git diff --check
```

Control Center:

```text
npm run lint
npm run typecheck
npm run test:unit
npm run test:python
npm run build
npm run test:e2e
git diff --check
```

Current verified totals:

- AliceTG Bot: 28 tests;
- dashboard unit: 11 tests;
- Panel Agent: 34 tests;
- Home Assistant mirror contracts: 4 tests;
- Playwright Chromium: 12 tests.

Screenshots, generated from fixtures and excluded from Git:

```text
/Users/aartemida/Documents/artem-control-panel-proj/artifacts/ui-review/coffee-settings.png
/Users/aartemida/Documents/artem-control-panel-proj/artifacts/ui-review/coffee-home.png
```

## 7. Home Assistant non-Git files and mirror

The local HA config is not a Git repository. Reviewable non-secret copies and
contracts are mirrored in:

```text
integration-patches/home-assistant/
```

Expected entities/scripts:

- `input_number.coffee_warmup_minutes`;
- `input_number.coffee_long_running_minutes`;
- `input_boolean.coffee_timing_initialized`;
- `input_datetime.coffee_last_turned_on`;
- `script.coffee_turn_on`;
- `script.coffee_turn_off`.

The helpers have no permanent `initial`. Initialization is explicit and
idempotent; restart restores the prior HA state. The long-running binary sensor
requires `input_boolean.coffee_timing_initialized == on` in both state and
availability templates, so pre-bootstrap helper values cannot raise a warning.

## 8. Deployment and migration order

No step below was run in this session.

1. Merge/review the HA patch and use the portable HA deployment script in a
   separately approved window.
2. Run HA config validation, apply configuration, and perform the separately
   approved HA reload/restart needed to create entities.
3. Verify helper bounds, script presence, activation automation and restored
   state without operating the physical device.
4. Merge/deploy AliceTG Bot PR #1 with a new random
   `CONTROL_CENTER_API_TOKEN`; keep the personal Shortcut token unchanged.
5. Run migration `status`, then `dry-run`; review legacy/current HA values.
6. Only with explicit approval, run migration `apply`. Verify both values and
   that the initialization marker is set last.
7. Configure Panel Agent with the same new token, HA read credentials and all
   coffee write gates `false`.
8. Verify Bot/Panel GET contracts, automatic Telegram-side refresh and stale
   behavior.
9. Enable notification writes, then timing writes, one gate at a time after
   review.
10. Enable coffee actions last, only after stable HA scripts and a separately
    approved non-device validation plan.

## 9. Rollout verification

- Bot health is live/ready and timing helpers are available.
- Bot readiness is `200` only for fresh, initialized canonical timing;
  cached/stale/uninitialized timing is `503` while liveness remains `200`.
- Snapshot SSE connects, emits heartbeat and causes a full GET after a newer
  revision; temporary GET failure keeps the last successful UI.
- GET timing returns current HA values and a changing opaque revision.
- Change timing through Telegram; Bot refresh and dashboard refresh show it
  without restart.
- With writes still disabled, all PATCH/action calls return policy-disabled.
- After enabling a settings gate, PATCH returns only after HA/bot read-back.
- Stale revision returns `409` and UI asks for refresh.
- Notification channel disabled state is not shown as delivery failure.
- Browser network payloads contain no upstream Bearer token.
- Existing personal Shortcut continues using its original token and behavior.
- Action validation must not be performed on the physical coffee machine
  without separate explicit approval.

## 10. Rollback

1. Disable all three narrow Panel Agent coffee gates first.
2. Roll back Control Center UI/Panel Agent to the prior image/commit.
3. Roll back AliceTG Bot to the prior image/commit; do not alter the personal
   Shortcut token.
4. Retain initialized HA timing helper values unless the HA package itself is
   deliberately rolled back.
5. If rolling back the HA package, validate config and use the documented HA
   configuration backup; do not fabricate or reset helper values.

## 11. Known gaps and disabled behavior

- HA package and initialization migration are not deployed.
- New runtime token is not generated or installed.
- All production coffee write gates remain disabled.
- No production coffee action has been executed.
- The action gateway currently reuses the confirmed switch implementation
  until the reviewed HA scripts are deployed; its public contract is already
  script-compatible.
- `requestId` idempotency is bounded and in-memory; it does not survive a bot
  restart. Durable idempotency is a later hardening task.
- Panel GET cache is in-memory; durable sanitized settings cache is later.
- Snapshot revisions and subscriber state are process-local and intentionally
  non-durable; a Panel Agent restart is recovered by full snapshot GET.
- Loopback-only deployment remains the current security boundary. LAN/public
  authentication is a future deployment gate, not added here.
- Delivery receipts remain bot-internal and have no dashboard UI.
- Dashboard screenshots and E2E mutations use deterministic fixtures.
- Calendar, tasks, backups and unrelated service actions remain fixture or
  placeholder work outside this slice.

## 12. Recommended next task

Perform a GitHub-only security and rollout review of PR #1 and PR #14:

1. inspect route schemas and error redaction;
2. confirm HA helper bounds/scripts in the mirrored patch;
3. review token distribution and gate defaults;
4. prepare an operator checklist for a no-device staging rollout.

Do not broaden that review into AVALAR, a general notification platform or UI
redesign.
