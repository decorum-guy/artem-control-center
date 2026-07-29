# Repository Change Index

Date: 2026-07-29  
Deployment status: **not deployed**

## Published work

| Project | Local path | GitHub repository | Base | Feature branch | Reviewed implementation commit(s) | Draft PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Artem Control Center | `/Users/aartemida/Documents/artem-control-panel-proj/artem-control-center` | `decorum-guy/artem-control-center` | `main` (`44c3e2d`) | `feat/local-integrations-foundation` | `f4984891afdcdcf39d5b1cdf636a40173ef3c6dc`, `e8cae62ccceeb25dd00301fee9a7fd9e031c4c43` | [#14](https://github.com/decorum-guy/artem-control-center/pull/14) | Draft; not deployed |
| AliceTG Bot | `/Users/aartemida/Documents/Homeassistant/TG_Alisa_Assistant_Bot` | `decorum-guy/AliceTG_Bot` | `main` (`494e534`) | `feat/control-center-ha-timing` | `f3ea866`, `5186dc1f9d133c7092db102a8255af9200bbb63d` | [#1](https://github.com/decorum-guy/AliceTG_Bot/pull/1) | Draft; not deployed |
| AVALAR Website | `/Users/aartemida/Documents/AVALAR` | `decorum-guy/AVALAR` | `stage` (`540b053`) | `feat/control-center-integration` | `f814a60`, `f8cebd04d027f51d5994eb7aaff75488b9011b07` | [#1](https://github.com/decorum-guy/AVALAR/pull/1) | Draft; not deployed |
| Home Assistant config | `/Users/aartemida/Documents/Homeassistant/HomeAssistant_Server_Config` | no Git repository | n/a | n/a | review bundle in this PR | [Control Center #14](https://github.com/decorum-guy/artem-control-center/pull/14) | Applied locally; not pushed to server |
| AVALAR Exchange MCP | no local clone | `decorum-guy/avalar_exchange_mcp` | `main` | none | none | none | Read-only; unchanged |

## Home Assistant

Changed local non-secret files:

- `config/configuration.yaml`;
- `config/packages/coffee_control_center.yaml`;
- `ha-push.sh`;
- `ha-push.env.example`;
- `DEPLOYMENT.md`.

The package defines:

- `input_number.coffee_warmup_minutes`;
- `input_number.coffee_long_running_minutes`;
- `input_datetime.coffee_last_turned_on`;
- `binary_sensor.coffee_machine_running`;
- `binary_sensor.coffee_machine_running_too_long`;
- `sensor.coffee_ready_at`;
- `sensor.coffee_timing_policy_revision`;
- stable coffee on/off and kettle boil/stop scripts.

The activation automation accepts only `switch.kofemashina: off → on` and
stores HA’s confirmed entity timestamp. Duplicate `on`, reconnect and HA
startup do not match the trigger.

The existing `ha-push.sh` remains the operator implementation. It now has a
read-only default `plan`, resolves its own directory and supports either SSH
aliases or direct `user@host` values through `HA_READ_REMOTE`,
`HA_WRITE_REMOTE` and `HA_REMOTE_ROOT`. It does not modify SSH config. The
reviewable package and deployment/rollback instructions are in
`integration-patches/home-assistant/`.

Validation: package YAML parse, include-tag-aware `configuration.yaml` parse,
entity naming and exact transition/script tests. A real container
`check_config` is still a deployment gate; no local HA runtime/Docker daemon
was available.

Deployment: run `ha-push.sh plan`, review diffs, then separately authorize
`ha-push.sh apply`; it backs up, uploads and checks config without automatic
restart. Restart only in a maintenance window.

Rollback: restore the timestamped remote backup or follow
`integration-patches/home-assistant/ROLLBACK.md`, check config, then perform an
approved restart.

## AliceTG Bot

Timing values are read from and written to HA helpers. Telegram writes use
`input_number.set_value` and a confirming read; HA outage never causes a local
default write. The explicit migration is dry-run by default, refuses to
overwrite non-default HA values, writes an idempotency marker only after
success, and is not called at application startup.

Health contracts:

- `GET /health/live`;
- `GET /health/ready`;
- protected `GET /health/details`.

Tests: Python 3.13 compileall; seven migration/helper/outage/health tests;
`git diff --check`.

Deployment: merge only after review, deploy the HA helpers first, run migration
dry-run, apply only if its plan is correct, then restart/rebuild the bot in a
separate approved operation.

Rollback: restore the prior bot image/commit; do not delete HA helper values.
The bot can be rolled back independently of coffee physical control.

## AVALAR Website

The existing local `scripts/update.sh` was found outside tracked source through
the repository’s local Git exclude. It implements stage-to-main promotion and
fixed stage/production deploy/restart calls through `avalar-reg`.

The feature adds:

- `/health/live`;
- `/health/ready`;
- protected `/health/details`;
- `scripts/control-center-action.sh` with only `status`, `smoke-main`,
  `smoke-stage` and dry-run-first `deploy-stage`.

Executable Stage deploy delegates to the existing update script, applies an
exclusive lock and cooldown, requires an external timeout utility and verifies
Stage readiness. Main deploy, backup, rollback and arbitrary commands are not
available.

Tests: PHP syntax for application files; health auth/redaction/readiness tests;
shell syntax; JSON dry-run; arbitrary command and production-deploy rejection;
`git diff --check`.

Deployment: review/merge to `stage`, deploy Stage separately, set sanitized
marker environment variables, verify endpoints/smoke, then use the existing
reviewed stage-to-main promotion process. Do not merge the feature branch
blindly into both branches.

Rollback: revert the Stage release through the existing operator process.
Application-level recorded rollback remains unavailable and must be designed
before Control Center exposes it.

## Control Center runtime

Implemented read-only foundations:

- HA REST initial state plus WebSocket state subscription/reconnect;
- allow-listed last-known HA cache and stale timeout;
- canonical coffee/kettle/helper validation and normalization;
- Alice health adapter independent from coffee authority;
- separate AVALAR Main/Stage health/details mapping;
- source modes: `live`, `cached`, `fixture`, `stale`, `unavailable`;
- AVALAR Main before Stage in registry priority;
- disabled registered actions only for handlers that now have a real wrapper:
  Main smoke, Stage smoke and Stage deploy.

There is no action execution endpoint. All action descriptors remain disabled.
Production/read-only snapshots never include fixtures.

Validation: ESLint, TypeScript, seven frontend unit tests, eight FastAPI/adapter
tests, production build, HA patch tests, YAML/JSON validation and Playwright
Chromium.
