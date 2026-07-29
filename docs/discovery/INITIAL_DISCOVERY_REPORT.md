# Initial Discovery Report

Discovery date: 2026-07-29

## Implementation follow-up

This report preserves the initial state at discovery time. Since then:

- the Control Center foundation was merged to `main` at `44c3e2d`;
- canonical HA coffee helpers/scripts were added locally and packaged for
  review, without HA reload/restart;
- AliceTG Bot now reads/writes verified HA timing helpers on
  `feat/control-center-ha-timing` (Draft PR #1);
- AVALAR health and allow-listed wrapper contracts are on
  `feat/control-center-integration` (Draft PR #1, base `stage`);
- Panel Agent now contains REST/WebSocket HA, Alice health and separate AVALAR
  Main/Stage read-only adapters;
- HA timing policy, not bot-local state, is the canonical coffee timing source.
- HA helpers have no permanent `initial`; explicit bootstrap verifies both
  values before setting a durable initialization marker.
- Bot policy and Panel Agent integration states refresh in managed background
  loops and recover without process restart.
- AVALAR uses stateless curl health and optional short SSH details; no daemon,
  PHP runtime metadata environment or HTTP details endpoint is required.

The discovery statements below are historical facts from before these changes,
not current unresolved gaps.

## Verified from writable repository

- Repository root is
  `/Users/aartemida/Documents/artem-control-panel-proj/artem-control-center`.
- Branch is `main`, tracking `origin/main`.
- Pre-existing untracked `.DS_Store` was present and preserved.
- Before this session the repository contained documentation and example YAML
  only.
- There was no application source, package manifest, test suite, CI, or
  deployment package.
- Thirteen open GitHub Issues define the implementation backlog.
- Product decisions require React/TypeScript/Vite, FastAPI, Chromium,
  localhost-only Panel Agent, automatic UI materialization, generic fallback,
  and P0 coffee widget.

## Verified from read-only Home Assistant folder and host

- Coffee entity: `switch.kofemashina`.
- Kettle entity configured by the existing integration:
  `water_heater.chainik`.
- Coffee currently uses HA `switch.turn_on/off`.
- Kettle boil/stop currently uses `water_heater.set_temperature` and
  `water_heater.set_operation_mode`; supporting keep-warm/light/mute switches
  are documented in the entity map.
- HA forwards coffee on/off transition and `last_changed` to `AliceTG_Bot`.
- The provided HA YAML has no coffee warm-up duration/progress/ready/long-running
  helper or template sensor.
- Before deployment, warm-up and long-running thresholds remain in bot
  persisted state; the prepared canonical architecture moves them to durable HA
  helpers with explicit one-time initialization.
- No automatic coffee shutoff was found.
- `AliceTG_Bot` is not required for a direct HA WebSocket/REST state adapter.
- Read-only `ha-vps` inspection confirmed the production include topology,
  zero-byte `scripts.yaml`, and absence of file-backed warm-up/timing entities.
- Production `automations.yaml` is newer than the local copy, but its inspected
  coffee blocks preserve the same behavior.

See `HOME_ASSISTANT_ENTITY_MAP.md`.

## Verified from read-only AVALAR folder and host

- Current checkout is `stage`; stage and main are separate branches.
- Site is plain PHP/static assets/data, without Composer/npm/framework.
- No application health endpoint or release marker exists.
- Current repository wrapper for stage deployment is
  `./scripts/update.sh deploy stage`, which invokes
  `ssh avalar-reg "~/avalar.sh stage"`.
- Read-only `avalar-reg` inspection confirmed that `~/avalar.sh stage` performs
  fetch + fast-forward pull + PHP-CGI termination + permissive curl smoke.
- Stage was clean at `721cae090…`; production was clean at `f438748e…`.
- Both homepages returned 200; `/healthz` and `/health/live` returned 404.
- No safe, complete backup/rollback contract exists in tracked code.
- A legacy write-capable admin/backup PHP component requires security review.

See `AVALAR_SITE_INTEGRATION_GAPS.md`.

## Verified from read-only GitHub repository and production hosts

- `decorum-guy/avalar_exchange_mcp` is a private active repository on `main`.
- GitHub `main` was rechecked after the user's merge and is now
  `e75ea095…` at package version `0.9.2`.
- Last verified production runtime is also version `0.9.2`, clean detached HEAD
  `1a41de697…`.
- The earlier source/runtime branch discrepancy is resolved and is not a
  current risk.
- The live deployed-commit marker is stale (`37dfc92…`) and disagrees with the
  actual checkout.
- Production is relay → Nginx origin → split MCP/portal/status processes →
  LanCloud and SQLite.
- Current health routes are static process checks plus a public status
  aggregator; live/ready/details are missing.
- A redacted production validator, maintenance-state script, systemd units,
  SQLite backup runbooks, update script, deployment marker, tests, and rollback
  logic exist.
- Production runbooks intentionally require the updater to remain disabled.
- Repository HEAD is not proof of the currently deployed server commit.
- Read-only checks found MCP/portal/status/Nginx active and updater disabled.
- On `kz-bot`, active HAProxy forwards public 80/443 to the MCP origin and
  active Dante exposes the separate SOCKS proxy.

See `AVALAR_EXCHANGE_MCP_INTEGRATION_GAPS.md`.

## User-stated facts

- Windows is first production/hardware host; Mac is required for development.
- Samsung laptop never hosts HA.
- Future local HA host is separate compact hardware.
- Coffee is P0; kettle is P1; HA is their only authority.
- Coffee widget and high-quality motion are MVP.
- Drag/resize is post-MVP; no-code widgets are later.
- External sources are read-only.
- Production writes require separate permission.

## Current architecture map

```text
Chromium dashboard
  → localhost Panel Agent
    ├─ fixture/read-only registry + adapters
    ├─ HA WebSocket/REST (future scoped read-only first)
    │   ├─ switch.kofemashina
    │   └─ water_heater.chainik
    ├─ AliceTG Bot independent health monitor
    ├─ AVALAR Main/Stage stateless curl monitors + optional SSH details
    └─ AVALAR Exchange monitor-only baseline

External write paths remain disabled:
  HA services / AVALAR deploy / Exchange restart-maintenance-deploy
```

## Integration dependency graph

```text
Coffee Widget
  → Widget Registry
  → normalized home.coffee-machine.v1
  ├─ Panel Agent HA adapter
  │   → HA API/WebSocket
  │   → switch.kofemashina state/activation/command verification
  └─ HA timing helpers + allow-listed Panel Agent cache
      → warm-up duration / long-running threshold / initialization marker

AliceTG_Bot health ── separate service widget

Generic Service Widget
  → registry reconciliation
  ├─ AVALAR stage/main HTTP/browser probes
  └─ Exchange public health/status component graph
```

## Security boundaries

- Browser receives normalized state and policy-approved action descriptors only.
- Panel Agent binds `127.0.0.1`; no public administrative port.
- Fixtures and fixture mutation endpoints are unavailable in production mode.
- Real integration credentials remain backend-only and referenced indirectly.
- No arbitrary shell/API endpoint.
- Registered external handlers require schema, lock, verification, audit, and
  rollback where applicable.
- External repositories/folders were read-only.

## Highest-risk unknowns

1. Live HA may contain UI-created entities absent from the copied YAML.
2. The prepared durable HA activation/timing package is not deployed; fake
   progress remains forbidden until helpers are initialized and fresh.
3. Persistence across a real HA restart remains an acceptance gate.
4. No HA coffee automatic shutoff was found.
5. AVALAR has no verified backup/rollback or deployment marker, and actual Stage
   deploy duration has not been measured against the shared-hosting limit.
6. AVALAR legacy admin component needs security review.
7. Exchange deployment marker remains stale even though GitHub main and runtime
   are now both version `0.9.2`.
8. Windows touchscreen/performance/kiosk behavior remains untested.

## Engineering proposals

- First implement a deterministic registry/snapshot vertical slice.
- Keep real HA read integration behind a separate scoped development credential.
- Deploy and explicitly initialize the prepared durable HA activation/timing
  contract before production warm-up percentage.
- Start AVALAR and Exchange as monitor-only.
- Add actions only after external contracts and acceptance tests are applied in
  their owning projects.

## Unknown or unverified

- Live HA entity registry/history and current attribute payloads.
- Production HA version/installation and backup freshness.
- AVALAR backup contents, reliable rollback, and bounded Stage deploy duration.
- Exchange deployment-marker reconciliation and truthful deployed-at metadata.
- Exchange provider readiness beyond the current explicit `unknown`.
- Cloud backup destination and Windows hardware metrics.

## Findings that change existing docs/config

- Coffee controls must not route through `AliceTG_Bot`.
- Bot legacy/default values cannot be presented as current HA warm-up truth.
- Placeholder HA warm-up entity IDs in examples imply entities not found.
- AVALAR `/healthz` examples describe nonexistent endpoints.
- Current AVALAR deploy wrapper differs from the historical command text.
- Exchange public `/health` is liveness-like and must not be labeled readiness.
- Exchange source/deployment truth must distinguish GitHub `main` commit,
  actual production checkout/runtime version, and the stale deployed-commit
  marker. GitHub main and runtime are both `0.9.2`.

## Recommended first vertical slice

Build a fixture-only/read-only registry pipeline:

1. FastAPI returns a typed full snapshot and revision.
2. React resolves specialized coffee or generic service widgets.
3. Layout reconciliation materializes every enabled service.
4. Deterministic HA/coffee/kettle/Alice failure fixtures drive the UI.
5. Playwright adds a fixture service at runtime and verifies automatic
   appearance.
6. Production mode refuses fixture routes and contains no real write executor.

This proves the most important architecture without guessed entity timing or
production secrets.

## Foundation implemented after discovery

Implemented only in the writable repository:

- npm workspaces with `apps/dashboard`, `apps/panel-agent`,
  `packages/contracts`, and `packages/config`;
- React/TypeScript/Vite dashboard and loopback FastAPI Panel Agent;
- explicit `fixtures`, `read_only`, `integration_test`, and `production` modes;
- no real write-action endpoint or executor;
- deterministic HA, coffee, kettle, Alice-bot, monitor-only, and multi-action
  fixtures;
- shared Widget Registry with specialized coffee manifest and mandatory generic
  fallback;
- automatic layout reconciliation and runtime fixture service materialization;
- widget-level error isolation;
- day/night, reduced-motion, Settings, and simulated kiosk controls;
- cross-platform Node orchestration plus Mac one-command combined launch;
- unit, API, build, and Playwright Chromium tests;
- Windows hardware acceptance checklist.

At completion, lint, TypeScript, six frontend unit tests, four Panel Agent tests,
production build, all example-YAML/fixture parsing, and five Playwright Chromium
tests passed.
