# Architecture

## 1. Logical overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Chromium kiosk / macOS development window                    │
│ React + TypeScript + local assets                            │
│ Overview / Home / Services / Calendar / Tasks / Widgets      │
└───────────────────────────┬──────────────────────────────────┘
                            │ localhost HTTP + WebSocket/SSE
┌───────────────────────────▼──────────────────────────────────┐
│ Panel Agent                                                   │
│ FastAPI                                                       │
│ auth · policies · registries · adapters · cache · audit      │
└───────┬──────────┬──────────┬──────────┬──────────┬──────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
  Remote HA   Local Edge   Monitoring  Calendar   Task provider
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
  Smart home   LAN devices  Services   iCloud/...  TickTick

Additional adapters:
- n8n
- restricted remote host agents
- GitHub Actions
- proxy/firewall control
- operating system
- weather/geocoder
- backups and storage destinations
```

The Samsung laptop never hosts Home Assistant. Local Edge is a narrow direct-device layer, not HA.

## 2. Core registries

Panel Agent owns authoritative registries:

- Project Registry;
- Service/Environment Registry;
- Capability Registry;
- Action Registry;
- Backup Profile Registry;
- Widget Definition Registry;
- Widget Instance Registry;
- Layout Registry;
- Integration/Adapter Registry.

Frontend does not contain a hard-coded list of projects or services.

## 3. Automatic UI materialization

```text
Project/service enabled
        ↓
Schema + policy validation
        ↓
Registry revision increment
        ↓
Snapshot/event published
        ↓
Frontend Registry Store reconciliation
        ↓
Widget Resolver
   ├── compatible specialized widget
   └── mandatory Generic Service Widget
        ↓
Layout Reconciler
        ↓
Services catalog + New items/default placement
```

A service is not considered onboarded until a visible UI instance exists and an automated test confirms it.

Full snapshots are authoritative. Incremental events improve latency but never replace reconnect reconciliation.

## 4. Deployment phases

### Windows-first production

- Windows remains installed initially.
- Chromium launches local dashboard fullscreen/kiosk.
- Panel Agent runs as a supervised Windows process/service.
- BlueStacks remains available for loyalty application.
- AnyDesk provides separately secured recovery.
- UI/adapters remain OS-neutral.

### macOS development

- frontend runs in ordinary Chromium/Chrome window;
- simulated kiosk viewport available;
- Panel Agent has fixture/read-only/integration-test modes;
- privileged production operations disabled by default;
- Playwright Chromium and screenshots validate normal UI behavior;
- Mac success is not target touchscreen/kiosk acceptance.

### Linux target

Migration only after Live USB validation:

- touchscreen;
- Wi-Fi/audio/brightness;
- sleep/wake/lid;
- screen rotation/tablet posture;
- Chromium kiosk;
- Waydroid loyalty application;
- remote maintenance;
- security and backup migration.

Linux target uses systemd supervision and dedicated users. Home Assistant is still excluded from the laptop.

## 5. Frontend architecture

Recommended structure:

```text
apps/dashboard/
├── src/app/
├── src/features/overview/
├── src/features/home/
├── src/features/services/
├── src/features/calendar/
├── src/features/tasks/
├── src/features/backups/
├── src/features/settings/
├── src/features/system/
├── src/entities/
├── src/widgets/registry/
├── src/widgets/core/
├── src/widgets/specialized/
├── src/shared/api/
├── src/shared/motion/
├── src/shared/theme/
└── src/shared/ui/
```

Frontend responsibilities:

- render current/cached state;
- receive project/widget/layout registry snapshots;
- automatically reconcile new/disabled/removed services;
- resolve generic/specialized widgets;
- isolate widget failures;
- handle touch/keyboard navigation;
- show action/backup lifecycle;
- choose theme/ambient mode;
- edit safe settings/layout state;
- never execute privileged operations directly;
- never contain production secrets.

Data transport:

- HTTP for initial snapshots/settings/commands;
- WebSocket or SSE for state and registry events;
- typed contracts generated from OpenAPI where practical.

## 6. Widget architecture

A widget definition declares:

- stable id/version;
- supported data contracts;
- required/optional capabilities;
- settings schema;
- default/min/max size;
- supported modes;
- performance class;
- permissions.

Resolution order:

1. explicit user assignment;
2. configured specialized widget;
3. compatible specialized widget by priority;
4. compatible generic widget;
5. mandatory `core.generic-service` fallback.

Custom widgets are registered packages, not direct imports into individual pages.

No-code widgets are later declarative presets. They cannot execute arbitrary JS, shell or direct browser requests.

## 7. Layout architecture

MVP:

- stable default layouts;
- automatic new-item placement;
- full Services catalog;
- optional basic show/hide/pin through Settings;
- no service lost because a manual grid entry is absent.

Post-MVP:

- drag/resize;
- section/page movement;
- named layouts;
- ambient/control/handheld profiles;
- undo/reset;
- collision-safe reconciliation;
- layout migration/backup.

Layout state is separate from project state. Hiding a widget does not disable monitoring. Disabling a project stops probes/actions/schedules but preserves layout/history references.

## 8. Mandatory Coffee Widget

`home.coffee-machine` is P0 and follows the normal Widget Registry contract.

Data contract includes:

- authority/source;
- state;
- start time;
- real/known-duration warm-up progress;
- remaining time;
- ready/long-running state;
- freshness;
- action descriptors.

It has deterministic fixtures for all states and is testable on Mac. Real touch/performance/integration acceptance occurs on Windows.

## 9. Panel Agent

Recommended structure:

```text
apps/panel-agent/
├── app/api/
├── app/actions/
├── app/adapters/
├── app/registries/
├── app/widgets/
├── app/layouts/
├── app/health/
├── app/policies/
├── app/cache/
├── app/audit/
├── app/system/
└── tests/
```

Responsibilities:

- integrate remote systems;
- normalize health/status/data models;
- maintain project/widget/layout revisions;
- cache last-known state;
- enforce action allow-list;
- manage backup profiles;
- enforce confirmations/cooldowns/timeouts;
- store secrets outside repository;
- publish audit and registry events;
- verify actual outcomes;
- expose own health.

Initial API outline:

```http
GET  /api/v1/snapshot
GET  /api/v1/events
GET  /api/v1/registry/projects
GET  /api/v1/registry/widgets
GET  /api/v1/layouts
PATCH /api/v1/layouts/{id}
GET  /api/v1/services
GET  /api/v1/services/{id}
POST /api/v1/actions/{action_id}/request
POST /api/v1/actions/{action_id}/confirm
GET  /api/v1/actions/executions/{execution_id}
GET  /api/v1/calendar/agenda
GET  /api/v1/tasks/focus
GET  /api/v1/weather
GET  /health/live
GET  /health/ready
```

## 10. Normalized service model

```json
{
  "id": "avalar-exchange-mcp",
  "name": "AVALAR Exchange MCP",
  "environment": "production",
  "status": "healthy",
  "availability": "remote",
  "latency_ms": 412,
  "last_checked_at": "2026-07-29T00:00:00Z",
  "last_success_at": "2026-07-29T00:00:00Z",
  "stale": false,
  "version": "0.3.1",
  "commit": null,
  "data_contracts": ["service.health.v1"],
  "capabilities": ["monitor", "details"],
  "actions": [],
  "backups": [],
  "preferred_widget": null
}
```

Allowed statuses include healthy, degraded, unhealthy, maintenance, unknown, stale, offline-local and offline-remote.

## 11. Action execution model

```text
requested
  ↓ policy accepted
accepted
  ↓ executor started
executing
  ↓ command completed
verifying
  ├── health/state confirmed → succeeded
  └── timeout/error          → failed
```

Each execution records action id, initiator, timestamps, target, sanitized parameters, confirmation, command result, verification and rollback where applicable.

## 12. Integration adapter contract

Every adapter implements a subset of:

```text
get_snapshot()
stream_events()
health()
list_capabilities()
list_data_contracts()
execute(action, params)
verify(action, expected_state)
backup(profile)
```

Adapters define timeouts, retries, cache/stale behavior, secrets, write capabilities, widget data contracts, backup support and audit fields.

## 13. Monitoring split

### External monitoring

Uptime Kuma or equivalent checks public reachability, TLS, latency and push checks.

### Internal diagnostics

Panel Agent queries protected detail endpoints/restricted host agents for process, dependencies, version/config revision, disk/memory, queue/backlog and last successful operation.

Public endpoints remain minimal.

## 14. Network and remote access

- dashboard and Panel Agent bind localhost;
- remote administration uses private overlay/VPN or reviewed authenticated proxy;
- no direct public Panel Agent port;
- HA/service tokens scoped and revocable;
- SSH keys restricted by command/source where possible;
- firewall changes never execute arbitrary frontend input;
- user widget network access goes through protected backend adapters with SSRF controls.

## 15. Platform abstraction

```text
SystemAdapter
├── WindowsSystemAdapter
├── LinuxSystemAdapter
└── DevelopmentSystemAdapter
```

Frontend contains no privileged OS branching. macOS uses DevelopmentSystemAdapter with unsupported operations disabled/simulated.

## 16. Local data

Store locally:

- encrypted credential references;
- project/service/action/widget definitions;
- widget instances and layouts;
- last-known snapshots;
- incident history;
- audit log;
- settings/theme/weather preferences;
- backup manifests/history.

Do not make the laptop the only storage location for important records.
