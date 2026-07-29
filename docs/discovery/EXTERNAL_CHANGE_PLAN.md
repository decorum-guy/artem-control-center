# External Change Plan

Every item is `NOT APPLIED — READ-ONLY DISCOVERY`.

## Home Assistant

Repository/folder: `/Users/aartemida/Documents/Homeassistant`; live host:
read-only alias `ha-vps`

| Phase | Required change | Why Control Center needs it | Contract | Acceptance tests |
| --- | --- | --- | --- | --- |
| Prototype | Scoped read-only HA credential and live entity-registry verification | Confirm copied config matches runtime | Health/data only; WebSocket + REST; no writes | exact entity exists; state/attributes schema; bot-down independence |
| MVP | HA-owned durable coffee activation timestamp | Reliable last activation after reconnect/restart | `turned_on_at` ISO timestamp with documented reset semantics | off→on, duplicate on, HA restart, history recovery |
| MVP | Optional dedicated coffee/kettle scripts | Centralize idempotency and safety | named scripts with exact target and post-state | duplicate on, service failure, state verification |
| Later | Native HA backup adapter and restore-test runbook | Verified off-device resilience | native backup, download, checksum, encrypted sync | archive check and isolated restore test |

Security: least-privilege tokens, no token in frontend/logs, no public admin port,
no direct device bypass, no restore on the panel laptop.

## AliceTG Bot

Repository/folder:
`/Users/aartemida/Documents/Homeassistant/TG_Alisa_Assistant_Bot` (read-only)

| Phase | Required change | Why Control Center needs it | Contract | Acceptance tests |
| --- | --- | --- | --- | --- |
| Prototype | Authenticated read-only `GET /api/v1/coffee/timing-policy` | Users change warm-up and long-running values through Telegram; frontend constants would drift | `{warmup_duration_seconds, long_running_threshold_seconds, updated_at, revision}` only | current values, changed values, auth failure, schema bounds, no secret/config leakage |
| Prototype | Cache/freshness semantics | Coffee state must survive bot outage without pretending timing is current | fetched time, source revision, stale threshold, last-known policy | bot down fresh cache, bot down stale cache, missing cache, restart |

Security: endpoint must expose no Telegram/HA tokens, chat IDs, webhook URLs,
arbitrary bot state, or write capability. Coffee on/off remains exclusively a
Home Assistant action. `NOT APPLIED — READ-ONLY DISCOVERY`.

## AVALAR Website

Repository/folder: `/Users/aartemida/Documents/AVALAR`; live host: read-only
alias `avalar-reg`

| Phase | Required change | Why | Contract | Acceptance tests |
| --- | --- | --- | --- | --- |
| Prototype | HTTP/browser monitor-only probes | Observe stage/main before changing site | homepage/routes/assets/TLS/freshness | independent stage/main failure fixtures |
| MVP | Minimal public live and protected ready/details | Distinguish PHP/router from content/runtime failures | `/health/live`, protected ready/details, deployment marker | dependency failures, auth/redaction, bounded latency |
| MVP | Registered backup handler | Deploy safety and recovery | allow-listed data/config/uploads; manifest/checksum/archive | isolated restore to stage |
| MVP | Harden/remove legacy write-capable admin component | Close unknown public write surface | deny public route or strong authenticated admin boundary | route/auth/CSRF/path tests |
| Later | Replace/wrap current `~/avalar.sh stage` with a safe named deploy handler | Current handler has no discovered lock/backup/marker/rollback and uses a permissive TLS-disabled smoke | precheck → lock → backup → exact FF target → marker → strict TLS health/browser verify | concurrency, dirty checkout, TLS failure, failed health, separate rollback |
| Later | Separate rollback | Recover verified previous release | recorded deployment id only | code/data rollback and post-health |

Security: no arbitrary target/ref/path; forced command or restricted host API;
sanitized output; main deploy absent until separate approval.

## AVALAR Exchange MCP

Repository: `decorum-guy/avalar_exchange_mcp`; live hosts: read-only aliases
`avalar-mcp` and `kz-bot`

| Phase | Required change | Why | Contract | Acceptance tests |
| --- | --- | --- | --- | --- |
| Prototype | Monitor current public endpoints | Immediate read-only visibility | `/health`, portal/public health, `/status/api`, OAuth metadata | component mapping and stale/offline |
| Prototype | Report actual/source/declared deployment metadata independently | GitHub `main` and runtime are both `0.9.2`; live marker still needs reconciliation | main commit + actual checkout/runtime version + declared marker, with marker mismatch degraded | stale marker, missing marker, actual/runtime mismatch |
| MVP | Add live/ready/protected details | Trustworthy health semantics | backward-compatible `/health`; new live/ready/details | DB/provider/portal/status failures and redaction |
| MVP | Registered validator | Safe deep diagnosis | fixed `validate_production.py` handler, structured redacted result | success/failure/timeout/no secret output |
| MVP | Registered backup | Protect SQLite/config/key/status before actions | SQLite online backup + encrypted protected payload + manifest | both DB integrity checks and isolated restore |
| Later | MCP-only restart action | Recover application without broad shell | fixed unit, lock, ready/OAuth/public verify | restart failure, timeout, rollback/escalation |
| Later | Typed maintenance action | Controlled planned state | allowed state/message/reference only | atomic flag/state, expiry/stale handling |
| Later | Reviewed deploy/rollback | Controlled upgrades | exact approved commit, backup-first, split services, full validator | version/commit match; updater remains disabled |
| Later | Relay/origin actions | Diagnose/recover network chain | separate HAProxy/Nginx handlers | syntax check before restart, end-to-end TLS verify |

Security: do not expose mailbox content, addresses, refs, tokens, raw logs,
internal paths, or unrestricted systemd unit names.

## Suggested implementation sequence

1. Control Center fixture/read-only registry vertical slice.
2. Live HA read-only entity verification.
3. External health endpoints and protected details.
4. Verified backups in each owning project.
5. Registered validators/smokes.
6. Low-scope restart actions.
7. Stage deploy and explicit rollback.
8. Higher-risk maintenance/network actions.

No external change was applied. SSH commands were limited to read-only
inspection; no deploy, fetch/pull, restart, reload, firewall, migration, or API
write was executed.
