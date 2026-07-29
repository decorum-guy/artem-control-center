# Repository Change Index

Date: 2026-07-29  
Deployment status: **not deployed**

## Published feature work

| Project | Local path | GitHub repository | Base | Feature branch | Implementation commit | Draft PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Artem Control Center | `/Users/aartemida/Documents/artem-control-panel-proj/artem-control-center` | `decorum-guy/artem-control-center` | `main` | `feat/local-integrations-foundation` | reviewed base `cdebb69`; transport-liveness correction is PR HEAD | [#14](https://github.com/decorum-guy/artem-control-center/pull/14) | Draft; not deployed |
| AliceTG Bot | `/Users/aartemida/Documents/Homeassistant/TG_Alisa_Assistant_Bot` | `decorum-guy/AliceTG_Bot` | `main` | `feat/control-center-ha-timing` | `75cb62d350ea0b6d9f11f9f927f9226fb11a1de4` | [#1](https://github.com/decorum-guy/AliceTG_Bot/pull/1) | Draft; not deployed |
| AVALAR Website | `/Users/aartemida/Documents/AVALAR` | `decorum-guy/AVALAR` | `stage` | `feat/control-center-integration` | `ef7d1197fc85d8a3c5e2273044d6525d0d36e53f` | [#1](https://github.com/decorum-guy/AVALAR/pull/1) | Draft; not deployed |
| Home Assistant config | `/Users/aartemida/Documents/Homeassistant/HomeAssistant_Server_Config` | no Git repository | n/a | n/a | mirrored in Control Center commit `f6523bf…` | [Control Center #14](https://github.com/decorum-guy/artem-control-center/pull/14) | Local non-secret files changed; server unchanged |
| AVALAR Exchange MCP | no local clone | `decorum-guy/avalar_exchange_mcp` | `main` | none | none | none | Read-only; unchanged |

## Home Assistant package

Review bundle: `integration-patches/home-assistant/`.

Entities:

- `input_number.coffee_warmup_minutes`;
- `input_number.coffee_long_running_minutes`;
- `input_boolean.coffee_timing_initialized`;
- `input_datetime.coffee_last_turned_on`;
- normalized running, running-too-long, ready-at and timing-revision entities;
- stable coffee on/off and kettle boil/stop scripts.

Timing helpers and activation datetime have no permanent YAML `initial`.
Home Assistant therefore restores their last state after restart. Exact
`switch.kofemashina: off → on` records the activation timestamp; startup,
`unknown/unavailable → on`, reconnect and duplicate `on` do not match.

`script.kettle_stop` first turns off
`switch.chainik_podderzhanie_tepla`, then sets
`water_heater.chainik` operation mode to `off`.

Initialization is external and explicit: bot migration `status`, `dry-run`,
then separately approved `apply`. It verifies both timing values before setting
the HA marker. It is never called by HA or bot startup.

Portable deployment uses the existing `ha-push.sh`, which resolves its own
directory and accepts aliases or direct `HA_READ_REMOTE`, `HA_WRITE_REMOTE` and
`HA_REMOTE_ROOT`. `plan` is read-only. `apply` backs up/uploads/checks config
but does not restart HA.

Validation: YAML/include parsing, no-`initial` contract, marker/entity naming,
exact transition and kettle action-order tests. Real container `check_config`
and restart persistence remain deployment gates.

Rollback: restore the timestamped configuration backup or remove the package
and package include after config validation. Do not reset helper values merely
when rolling back the bot.

## AliceTG Bot

The bot reads and writes canonical HA helpers. Its explicit bootstrap:

1. checks the durable HA initialization marker;
2. prefers explicit legacy values, otherwise preserves configured non-default
   HA values or uses defaults 13/60;
3. writes only values that need initialization;
4. verifies both values;
5. sets the marker last.

No default is written when HA is unavailable and initialized HA values are
never overwritten. Current production runtime observed before deployment uses
15 minutes warm-up and 60 minutes long-running warning.

A managed refresh loop runs at a configurable 30-second default, with bounded
backoff, no overlapping cycle, last confirmed revision/fetch time, stale state,
automatic HA recovery and graceful cancellation. Revision changes reschedule
active alerts once; unchanged revisions create no duplicates. Health endpoints
report this state but do not drive recovery.

Health contracts remain:

- public-safe `GET /health/live`;
- `GET /health/ready`;
- protected sanitized `GET /health/details`.

Validation: Python compileall and 9 tests covering helper reads/writes, outage,
one-time initialization, preservation, recovery, stale state, revision
reschedule, cancellation and health.

Rollback: restore the prior bot image/commit; retain canonical HA helper values
and marker.

The bot now also exposes a dedicated Bearer-protected Coffee API for Control
Center. Its token is separate from the personal Shortcut token. Notification
policy, HA-backed timing and allow-listed on/off actions have independent typed
contracts, optimistic revisions and read-back verification. The existing
Shortcut endpoint is unchanged.

## AVALAR Website

Shared-hosting architecture has no daemon, listener, worker or PHP environment
metadata dependency.

HTTP:

- public stateless `GET /health/live`;
- public stateless `GET /health/ready`;
- no HTTP `/health/details`.

Ready validates required `data.json` existence/readability/JSON validity.
Responses exclude paths, environment, raw errors, secrets and user data.

SSH-only details use `scripts/control-center-status.sh` with fixed
`status-main`, `status-stage`, `details-main` and `details-stage` operations.
The sanitized result includes environment, commit, branch, deployment
revision, approximate deployed time, worktree state and observation time.

`scripts/control-center-action.sh` allows only status Main/Stage, smoke
Main/Stage and dry-run-first Stage deploy. Smoke curls live, ready and root.
Execute mode additionally requires an explicit operator gate, lock, cooldown,
timeout (120-second default, maximum 150) and post-deploy smoke. Main deploy,
restart, backup, rollback and arbitrary commands are absent.

Read-only discovery found clean Main/Stage checkouts, no static marker and
`~/avalar.sh status` at roughly 0.16 seconds. No real deploy duration was
measured, so Stage execution remains disabled.

Validation: all PHP files passed syntax checks; Bash syntax, stateless health,
status JSON/schema/redaction, Main/Stage smoke, dry-run, allow-list, production
deploy rejection and timeout-bound tests passed.

Deployment: review/merge only through normal project flow, deploy Stage in a
separate approved window, then propagate to Main. No deployment occurred.

Rollback: no verified application rollback exists; do not register one.

## Control Center runtime

- HA REST initial snapshot and WebSocket reconnect remain read-only.
- HA normalization requires the initialization marker and never fabricates an
  activation timestamp or progress.
- HTTP integrations poll independently at a configurable 30-second default.
- Last-known services transition `live → cached → stale → unavailable` and
  recover without Panel Agent restart.
- Optional AVALAR SSH details poll on a separate 180-second default cadence.
- SSH uses a fixed alias/script/operation list, subprocess argument array,
  host-key verification, timeout, bounded output, strict sanitized JSON and
  cached/stale details; it is disabled by default.
- AVALAR Main priority 90 precedes Stage priority 80. Main has no deploy
  capability. Stage deploy exists only as a disabled descriptor.
- Fixtures remain isolated from read-only/production snapshots.
- Coffee timing/notification settings use fixed AliceTG Bot routes through a
  dedicated server-side token.
- Timing and action mutations refresh the HA snapshot and require matching HA
  confirmation.
- Global and three narrow coffee gates all default to disabled.

Validation: ESLint, TypeScript, 11 frontend unit tests, 34 FastAPI/adapter
tests, production build, 4 HA patch contract tests, YAML/JSON validation and 12 Playwright
Chromium tests.

## Runtime baseline

`docs/discovery/COFFEE_RUNTIME_BASELINE.md` records one sanitized read-only
snapshot. HA and bot activation timestamps matched exactly. Warm-up was 15
minutes and the long-running warning was 60 minutes. The iPhone warm-up
delivery flag became true after the deadline; no 60-minute warning was awaited.
No identifiers or secrets are included.
