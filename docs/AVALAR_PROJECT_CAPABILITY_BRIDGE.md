# AVALAR project capability bridge and production cutover

AVALAR has completed its production cutover to the capability-based Project
Registry. The registry is the source of truth for AVALAR service identity,
environment/service membership, and exposed capabilities.

Production provisions the canonical `avalar` project during startup. Its
runtime service identities are exactly:

- `avalar.main.website`
- `avalar.stage.website`

The legacy `HttpIntegrationAdapter` no longer materializes AVALAR services.
AliceTG remains materialized by that HTTP integration, and unrelated HTTP
integration behavior is unchanged.

## Registry declaration

The closed declaration for an explicitly enabled AVALAR project is:

```yaml
version: 1
projects:
  - id: avalar
    name: AVALAR
    enabled: true
    category: work
    environments:
      - id: main
        services:
          - id: website
            capabilities:
              monitor:
                adapter: avalar
                url_env: PANEL_AVALAR_MAIN_URL
                interval_seconds: 60
                stale_after_seconds: 180
              details:
                adapter: avalar-ssh
              actions:
                - avalar.main.smoke
                - avalar.main.restart
                - avalar.main.deploy
            presentation:
              widget: core.generic-service
      - id: stage
        services:
          - id: website
            capabilities:
              monitor:
                adapter: avalar
                url_env: PANEL_AVALAR_STAGE_URL
                interval_seconds: 60
                stale_after_seconds: 180
              details:
                adapter: avalar-ssh
              actions:
                - avalar.stage.smoke
                - avalar.stage.restart
                - avalar.stage.deploy
            presentation:
              widget: core.generic-service
```

`category` is a presentation category; it does not grant a write capability.
The monitor and details adapters, action IDs, and action target environments
are server-registered. Unknown adapters, details settings, or action IDs fail
closed. The declaration contains only backend-owned ENV names and the
registered details reference; it never contains a URL, SSH host, user, key,
command, script, password, or token.

The `avalar` monitor reuses the fixed `/health/live` and `/health/ready` reader
used by the former HTTP integration. The registry-backed runtime materializes
ordinary `ServiceSnapshot` values, including health, source/freshness, bounded
latency, environment, sanitized details, and the declared fixed action
descriptors. Health, SSH details, and fixed actions continue to use the
existing specialized adapters and AVALAR executor. Action `enabled` state is
supplied by the executor availability decision, so access profiles, gates,
confirmation, Interaction Lock, cooldowns, revisions, verification, and audit
remain authoritative.

The action UI consumes explicit `service.actions` descriptors. It does not
discover AVALAR actions from service ID strings. After a successful smoke,
restart, or deploy, the fixed executor refreshes the canonical registry-backed
AVALAR snapshots (`avalar.main.website` and `avalar.stage.website`), so
subscribers observe the refreshed project-monitor state.

## Production provisioning and protection

The production startup path reads the current registry, safely ensures the
canonical project, installs the resulting registry into `IntegrationRuntime`,
and only then starts polling. Provisioning is bounded and uses the registry
store's atomic persistence:

- a missing or empty valid registry (available revision `0`) receives the
  canonical AVALAR project atomically;
- unrelated projects are preserved unchanged;
- a real addition increments the registry revision exactly once;
- an already exact canonical project is a no-op with no revision bump;
- a conflicting reserved `id: avalar` fails closed without overwriting or
  merging owner data;
- a corrupt or unavailable registry fails closed and is never replaced by a
  clean registry;
- repeated startup is idempotent.

In production, the generic Project Registry API protects the reserved canonical
project. POST create with `avalar`, PUT/PATCH replace, and DELETE return the
bounded `409 project_reserved` error before any store mutation. GET and the
read-only connection test remain available. Settings displays the extended
AVALAR entry, but the current editor treats it as read-only: edit, enable/
disable, and delete controls are disabled. Ordinary monitor-only projects keep
their existing Settings CRUD behavior.

There is no browser provisioning endpoint and no generic AVALAR executor.

## Legacy service identities and reference audit

`avalar-site-main` and `avalar-site-stage` are no longer production
`ServiceSnapshot` identities. The only production AVALAR services exposed by
`IntegrationRuntime.services()` come from `DeclarativeProjectMonitor`, and
the main and stage services each appear once under their canonical IDs.

The legacy strings remain only where they are intentionally useful as trusted
internal compatibility keys: fixed executor/details lookup, the SSH details
cache/mapping, health compatibility mapping, and tests, docs, or examples that
explicitly model historical/internal behavior. They were not globally renamed.

The source audit found no separate persisted owner-facing store containing
legacy AVALAR service IDs. Overview persistence stores widget identity and
configuration, not AVALAR service IDs, so no persisted layout/history rewrite
migration was needed. Browser/runtime labels, fixtures, and status surfaces
that represent production service identity use the canonical IDs.

| Legacy service identity | Registry project/environment/service | Stable registry snapshot ID |
| --- | --- | --- |
| `avalar-site-main` | `avalar` / `main` / `website` | `avalar.main.website` |
| `avalar-site-stage` | `avalar` / `stage` / `website` | `avalar.stage.website` |

The table is a historical/internal compatibility mapping, not a second
production identity source. Unknown or unrelated service IDs are not rewritten.

## Backup boundary

Backup execution is not implemented by this cutover. Issue #8 remains the
owner of backup execution. A future backup implementation should attach to
AVALAR as a Project Registry capability/profile; it must not restore a bespoke
parallel AVALAR subsystem.
