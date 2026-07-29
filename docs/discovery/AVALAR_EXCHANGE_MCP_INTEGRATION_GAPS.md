# AVALAR Exchange MCP Integration Gaps

Discovery date: 2026-07-29  
Repository: `decorum-guy/avalar_exchange_mcp`  
Sources: GitHub connector and read-only SSH aliases `avalar-mcp` / `kz-bot`  
Default branch: `main`  
GitHub `main` inspected HEAD:
`e75ea095f9f4ca573bebb4fc028e08f99a77fef3`  
GitHub `main` package version: `0.9.2`  
Last verified live checkout: `1a41de697541aa029b368e1bd2992cb42b3837ba`  
Last verified live package/runtime version: `0.9.2`

All proposed changes are `NOT APPLIED — READ-ONLY DISCOVERY`.

## Verified current architecture

```text
exchange.avalar.pro
  → foreign HAProxy TCP relay :80/:443
  → Russian Nginx/TLS origin
  ├─ MCP/OAuth 127.0.0.1:8000
  ├─ portal   127.0.0.1:8001
  └─ status   127.0.0.1:8002
      → LanCloud IMAP/EWS
      → main SQLite + private status/support SQLite
```

The relay does TLS passthrough. The origin terminates TLS. The repository
documents the relay as a public single point of failure. The three application
ports are loopback-only in the current systemd examples.

Read-only SSH confirmed that the relay is the `kz-bot` host: HAProxy listens on
public TCP 80/443 and forwards to `37.153.71.79:80/443` with backend checks
every ten seconds. Dante also listens on TCP 1080. Both services were active and
enabled. This makes the relay an explicit infrastructure dependency; Control
Center must not conflate relay health with origin/application health.

## Current health behavior

### MCP `/health`

Current code returns a static JSON document:

- `ok: true`;
- `service: avalar-mail-mcp`;
- auth mode;
- feature list.

It does not check database integrity/writability, LanCloud IMAP/EWS, portal,
status process, deployment marker, or relay/origin state. It is effectively
process/import liveness, not readiness.

There are no current `/health/live`, `/health/ready`, or protected
`/health/details` routes.

### Portal and status

- `/portal-health` is static process health for `avalar-mail-portal`.
- `/public-health` is static process health for `avalar-mail-status`.
- `/status/api` combines operator state with bounded-timeout probes of MCP and
  portal.
- Mail provider state is explicitly `unknown` and “checked on mail access”.
- Operator states are `operational`, `restarting`, `maintenance`, `degraded`,
  and `incident`.
- Missing/invalid operator-state JSON fails closed to incident.
- Nginx returns structured 503 responses for MCP restart/maintenance and status
  failure.

## Deployment, validation, and version

- GitHub default branch `main` now reports package/module version `0.9.2` at
  merge commit `e75ea095f9f4ca573bebb4fc028e08f99a77fef3`.
- The previously observed source/runtime branch discrepancy was resolved by the
  user through the main-branch merge and is no longer an operational risk.
- The last verified live host also runs `0.9.2`, from clean detached HEAD
  `1a41de697541aa029b368e1bd2992cb42b3837ba`.
- The live deployed-commit marker contains
  `37dfc92c4ada7ae9c897fc7852d01ae687d0f28d`, which does not match the actual
  checkout. It is stale and must not be shown as authoritative.
- `scripts/validate_production.py` checks:
  public health/features, portal health, public-status health, status schema,
  OAuth metadata, package/module version, systemd services, disabled updater,
  sanitized recent logs, and current Git commit.
- Release-specific smoke validates controlled read-only LanCloud
  Calendar/Contacts/Tasks behavior and redaction.
- Deployment runbooks are manual, backup-first, and require SQLite online
  backup/integrity checks before change.
- `deploy/update/avalar-mail-mcp-update.sh` has locking, dirty-tree refusal,
  tests, health verification, deployed-commit marker, and rollback.
- However, current runbooks require the updater timer/service to remain
  disabled/inactive. The updater also contains a legacy activation guard looking
  for `avalar_mcp.app:app`, while current split runtime starts
  `avalar_mcp.mcp_only_app:app`; it should not be exposed as a Control Center
  deploy path without review.

At discovery time MCP, portal, status, and Nginx were active; the updater timer
was inactive and disabled. Public health responses were healthy and the status
API reported `operational`, while the mail provider remained `unknown`.

## Storage dependencies

- Main SQLite database: credential-aware application state.
- Separate status/support SQLite database and support spool.
- Credential encryption key and protected environment files.
- Status/operator JSON state and local status assets.
- Git checkout and deployed-commit marker.

Backups must use SQLite online backup APIs and keep encryption keys/protected
configuration in a separately encrypted payload. Git alone is insufficient.

## Existing maintenance/control surfaces

- `scripts/set_service_status.py` atomically writes an allow-listed operator
  state and controls a maintenance flag; it requires root.
- systemd units independently supervise MCP, portal, and status.
- production validator is safe/redacted and returns non-zero on failure.
- Nginx syntax check and systemd status are documented.
- HAProxy syntax check and service status are documented for the relay.

These are operator interfaces, not yet a restricted Control Center API.

## Required Control Center gaps

| Component | Confirmed current state | Required change | Contract | Security/tests/risk |
| --- | --- | --- | --- | --- |
| MCP live | Static `/health` | Keep backward compatibility; add `/health/live` | Event-loop/process only | Public minimal; unit + Nginx fallback tests; low |
| MCP ready | No readiness route | Add bounded DB and required runtime checks; classify optional LanCloud dependency degradation | `200 ready`, `503 not ready`, redacted components | No mailbox content/credentials; timeout and DB-failure tests; medium |
| Protected details | No details route | Add authenticated component/version/deploy/queue/storage summary | version, commit, uptime, DB integrity freshness, last safe provider check | Private overlay/scoped token; redaction tests; medium |
| Relay/origin graph | Public status probes only app/portal | Restricted host probes for HAProxy, origin Nginx, TLS, loopback apps | component DAG with latency/freshness | Separate least-privilege agents; no raw config/logs; high |
| Provider health | Status says unknown | Add safe non-content synthetic readiness or last successful operation age | optional dependency can degrade without leaking mailbox | Controlled account, bounded timeout, never list real content; high |
| Deployment marker | Last verified live marker is stale and disagrees with actual checkout (`37dfc92…` vs `1a41de…`) despite source/runtime both being version `0.9.2` | Reconcile deployment metadata atomically and expose actual/declared mismatch as degraded | main commit, actual commit/runtime version, declared marker, deployed_at, maintenance/deploy id | No arbitrary ref; startup + validator marker-mismatch tests; high |
| Validator | Strong CLI exists | Wrap as named read-only action with sanitized structured result | `avalar_exchange.validate` | Fixed path/args; output category allow-list; medium |
| Restart | systemd units exist | Separate named actions per MCP/portal/status; verify full chain | request → lock → restart → ready → public smoke | No generic unit parameter; rollback/timeout; high |
| Maintenance | Root CLI and flag exist | Restricted typed handler for allowed state/message/reference bounds | maintenance enable/disable with audit | Message length/sanitization; stale flag tests; high |
| Deploy/update | Auto-updater exists but intentionally disabled and legacy-gated | Keep disabled for MVP; design manual reviewed deploy handler from backup-first runbook | exact commit, backup, tests, split services, validator, rollback | Highest risk; later |
| Backup | Manual runbook | Registered app backup profile | SQLite online backups + config/key/status/spool/manifests | Encrypt secrets; restore in isolated host; high |

## Recommended initial capabilities

Prototype:

- public monitor-only `/health`, `/portal-health`, `/public-health`, `/status/api`;
- GitHub `main` `0.9.2` at `e75ea095…` and last verified live runtime `0.9.2`
  at checkout `1a41de…`, represented as distinct source/deployment fields;
- deployment-marker mismatch shown explicitly as degraded metadata;
- Generic Service Widget with dependency graph;
- no restart/deploy/maintenance buttons.

MVP after external changes:

- live/ready/protected details;
- registered validator;
- verified backup profile;
- separate restart action for application only.

Later:

- relay/origin restarts;
- maintenance state control;
- reviewed manual deploy/update and rollback.

## Acceptance tests

1. `/health` remains backward-compatible.
2. `/health/live` succeeds when dependencies are unavailable but process is
   responsive.
3. `/health/ready` fails closed on required SQLite/runtime failure within a
   bounded timeout.
4. Optional LanCloud failure maps to documented degraded/not-ready policy.
5. Details never include mail content, addresses, tokens, raw refs, internal
   credentials, or unredacted logs.
6. Relay, origin, MCP, portal, status, OAuth, storage, and provider failures are
   independently represented.
7. Restart success requires ready + OAuth metadata + public route verification.
8. Validator handler accepts no browser-provided command/path.
9. Backup passes SQLite integrity and archive/checksum tests.
10. Deployed commit and package version match the approved target.
11. Updater remains disabled until a separately approved deployment contract.
12. A stale deployed-commit marker cannot override the actual checkout and
    causes a visible metadata mismatch.

No GitHub branch, commit, Issue, PR, release, or repository file was changed.
Neither SSH host was modified and no service or firewall action was run.
