# AVALAR project capability bridge

This document describes the parity-only bridge for the capability-based Project
Registry. It is intentionally not a production cutover plan.

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
used by the legacy HTTP integration. The registry-backed runtime materializes
ordinary `ServiceSnapshot` values, including health, source/freshness, bounded
latency, environment, sanitized details, and the declared fixed action
descriptors. Action `enabled` state is supplied by the existing AVALAR executor
availability decision, so access profiles, gates, confirmation, locks,
cooldowns, revisions, verification, and audit remain authoritative.

## Coexistence and cutover boundary

This slice does not synthesize or persist an AVALAR project during startup. The
legacy `HttpIntegrationAdapter`, SSH details adapter, action routes, and legacy
snapshot IDs continue to serve the normal production path. A registry-backed
AVALAR snapshot appears only when the project is explicitly present in the
server-side Project Registry; this makes the bridge safe for parity fixtures and
manual development configuration without creating production duplicates.

## PR B identity/layout strategy

The compatibility mapping for a later migration is explicit and deterministic:

| Legacy service identity | Registry project/environment/service | Stable registry snapshot ID |
| --- | --- | --- |
| `avalar-site-main` | `avalar` / `main` / `website` | `avalar.main.website` |
| `avalar-site-stage` | `avalar` / `stage` / `website` | `avalar.stage.website` |

PR A does not rewrite layouts or history. Before PR B removes the legacy
materialization, PR B must apply this mapping as an explicit, revisioned
migration for every persisted layout/history reference and retain a rollback
record. A new ID must not silently replace either legacy reference.

Backup execution remains outside this bridge and belongs to #8.
