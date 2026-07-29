# Architecture

## 1. Logical overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Chromium kiosk                                               │
│ React + TypeScript + local assets                            │
│ Overview / Home / Services / Calendar / Tasks / Apps         │
└───────────────────────────┬──────────────────────────────────┘
                            │ localhost HTTP + WebSocket
┌───────────────────────────▼──────────────────────────────────┐
│ Panel Agent                                                   │
│ FastAPI                                                       │
│ auth · policies · adapters · cache · audit · orchestration   │
└───────┬──────────┬──────────┬──────────┬──────────┬──────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
 Remote HA   Local edge   Monitoring  Calendar   Task provider
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
 Smart home   LAN devices  Services   iCloud/...  TickTick

Additional adapters:
- n8n
- SSH restricted actions
- GitHub Actions
- proxy/firewall control
- operating system
- weather
```

## 2. Deployment phases

### Phase A — Windows-first

- Windows remains installed.
- Chromium/Chrome launches local dashboard in fullscreen.
- Panel Agent runs as a Windows service or supervised process.
- BlueStacks remains available for the loyalty application.
- UI and adapters are developed without OS-specific assumptions.

### Phase B — Linux target

Migration happens only after Live USB validation:

- touchscreen;
- Wi-Fi;
- audio;
- brightness;
- sleep/wake;
- lid behavior;
- screen rotation;
- tablet posture;
- Chromium kiosk;
- Android application through Waydroid or approved alternative.

Linux target:

- desktop distribution with stable touch support;
- systemd supervision;
- Chromium kiosk session;
- Panel Agent service;
- optional containers for auxiliary services.

## 3. Frontend architecture

Recommended structure:

```text
apps/dashboard/
├── src/app/
├── src/features/overview/
├── src/features/home/
├── src/features/services/
├── src/features/calendar/
├── src/features/tasks/
├── src/features/automations/
├── src/features/apps/
├── src/features/system/
├── src/entities/
├── src/shared/api/
├── src/shared/motion/
├── src/shared/theme/
└── src/shared/ui/
```

Frontend responsibilities:

- render current and cached state;
- handle touch/keyboard navigation;
- show command lifecycle;
- choose theme and ambient mode;
- never execute privileged operations directly;
- never contain production secrets.

Data transport:

- HTTP for commands and initial snapshots;
- WebSocket or Server-Sent Events for state streams;
- typed contracts generated from OpenAPI where practical.

## 4. Panel Agent

Recommended structure:

```text
apps/panel-agent/
├── app/api/
├── app/actions/
├── app/adapters/
├── app/health/
├── app/policies/
├── app/cache/
├── app/audit/
├── app/system/
└── tests/
```

Responsibilities:

- integrate remote systems;
- normalize health/status models;
- cache last-known state;
- enforce action allow-list;
- enforce confirmation/cooldown/timeout;
- store secrets outside the repository;
- publish audit events;
- verify actual outcomes;
- expose its own live/readiness health.

Initial API outline:

```http
GET  /api/v1/snapshot
GET  /api/v1/events
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

## 5. Normalized service model

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
  "dependencies": [],
  "incidents": [],
  "actions": ["restart-avalar-exchange-mcp"]
}
```

Allowed statuses:

- `healthy`;
- `degraded`;
- `unhealthy`;
- `maintenance`;
- `unknown`;
- `offline-local`;
- `offline-remote`.

## 6. Action execution model

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

Each execution records:

- action id;
- initiator;
- timestamps;
- target;
- sanitized parameters;
- confirmation method;
- command result;
- verification result;
- rollback result where applicable.

## 7. Integration adapter contract

Every adapter implements a subset of:

```text
get_snapshot()
stream_events()
health()
list_capabilities()
execute(action, params)
verify(action, expected_state)
```

Adapters must define:

- timeouts;
- retries;
- caching;
- degraded behavior;
- secret requirements;
- write capabilities;
- audit fields.

## 8. Monitoring split

Use two layers:

### External monitoring

Uptime Kuma or equivalent checks public reachability, TLS, latency and selected push checks.

### Internal diagnostics

Panel Agent queries protected detail endpoints and/or restricted host agents for:

- process health;
- dependency health;
- version/commit;
- disk/memory;
- queue/backlog;
- last successful operation.

Public endpoints remain minimal. Detailed diagnostics require authenticated private connectivity.

## 9. Network and remote access

Default rules:

- dashboard and Panel Agent bind to localhost;
- remote administration uses Tailscale/ZeroTier or another private overlay;
- no direct public port for Panel Agent;
- Home Assistant and service tokens are scoped and revocable;
- SSH keys are restricted by command/source where possible;
- firewall changes are never executed from arbitrary frontend input.

## 10. Local data

Store locally:

- encrypted credentials/config references;
- service definitions;
- action policies;
- last-known snapshots;
- short incident history;
- audit log;
- UI preferences;
- theme override.

Do not make the laptop the only storage location for important records.
