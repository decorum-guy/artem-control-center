# Integrations and Health Registry

Этот документ фиксирует системы, которые Artem Control Center должен отображать или контролировать, и изменения, которые потребуются в их backend.

Статусы происхождения:

- **confirmed repository** — репозиторий найден в подключённом GitHub;
- **confirmed runtime/context** — система подтверждена рабочей историей проекта;
- **referenced, repository not located** — система упомянута, но отдельный GitHub-репозиторий не найден; нельзя угадывать его расположение.

## 1. Priority 0 — MVP integrations

### Artem Control Center

Repository: `decorum-guy/artem-control-center` — **confirmed repository**.

Required health:

- `GET /health/live` — Panel Agent process;
- `GET /health/ready` — config loaded, local database/cache writable, adapters initialized;
- frontend heartbeat;
- kiosk process status;
- WebSocket/SSE stream status.

Allowed actions:

- restart dashboard;
- restart Panel Agent;
- reload configuration;
- refresh all states;
- switch theme/ambient mode;
- open desktop;
- reboot/shutdown with hold + confirmation.

### Home Assistant + AliceTG Bot

Repository: `decorum-guy/AliceTG_Bot` — **confirmed repository**.

Runtime stack known from project history:

- Home Assistant;
- `telegram-bot` container;
- Caddy;
- bot aiohttp server on port `8088`;
- existing bot `GET /health`;
- existing coffee control endpoint and Home Assistant REST integration.

Monitoring targets:

- public HA reachability;
- authenticated HA API readiness;
- selected entity freshness;
- Caddy/TLS;
- Telegram bot liveness;
- bot readiness against Home Assistant;
- coffee timer/state persistence;
- PushWard error count where available;
- backup freshness.

Backend changes:

1. Keep current `/health` backward compatible.
2. Add `/health/live` without external dependency checks.
3. Add `/health/ready` that checks configuration and HA API with strict timeout.
4. Add protected `/health/details` with sanitized dependency states.
5. Add a safe status endpoint for coffee workflow state.
6. Reuse existing authenticated coffee action instead of bypassing bot/HA logic.
7. Add idempotency keys for control requests where practical.

Control Center actions:

- coffee on/off;
- kettle on/off if existing workflow supports it;
- clear approved workflow flags;
- repeat HA check;
- restart bot container through restricted host action;
- restart Caddy only through restricted action;
- create HA backup;
- activate emergency local edge mode.

### AVALAR public site — production and stage

Repository: `decorum-guy/AVALAR` — **confirmed repository**.

Known deployment mapping:

- `main` → `avalar.pro`;
- `stage` → `stage.avalar.pro`.

Monitor both environments independently:

- homepage HTTP/TLS;
- representative pages `/contact`, `/conf`, `/politico`, `/service`, `/about`;
- response time;
- certificate expiry;
- content/data loading;
- lead submission path in a non-destructive synthetic mode;
- deployed commit/version marker.

Backend changes:

- add minimal `GET /health/live` or `/healthz` returning no secrets;
- add protected readiness/details endpoint or host-side check for:
  - PHP execution;
  - readable `data.json`;
  - writable lead log directory;
  - expected environment;
  - deployed commit/release id;
- add non-destructive synthetic form validation endpoint rather than creating fake leads;
- expose stage/main as distinct service ids.

Allowed actions:

- recheck;
- open site/admin/log view;
- trigger approved deployment workflow;
- rollback only through a separately confirmed workflow;
- tail sanitized recent application errors through protected diagnostics.

### AVALAR Exchange MCP

Repository: `decorum-guy/avalar_exchange_mcp` — **confirmed repository**.

Known architecture:

- `exchange.avalar.pro`;
- foreign HAProxy TCP relay;
- Russian Nginx/application host;
- `avalar-mail-mcp.service`;
- existing public `/health`;
- OAuth/UI/MCP and mail dependencies.

Monitor as multiple components, not one green/red dot:

1. public DNS/TLS/HTTP;
2. relay HAProxy process and backend availability;
3. origin Nginx;
4. application liveness;
5. application readiness;
6. OAuth metadata;
7. selected MCP smoke check without accessing real mail content;
8. certificate expiry;
9. updater/service state;
10. disk and backup freshness through protected host diagnostics.

Backend changes:

- preserve existing `/health` response;
- add `/health/live`;
- add `/health/ready` with bounded checks of required dependencies;
- add authenticated `/health/details` containing version, commit and feature readiness but no credentials/mail data;
- provide a safe smoke operation that does not mutate mailbox state;
- expose deployment/update status.

Allowed actions:

- repeat full chain check;
- restart application service;
- restart Nginx or HAProxy only as distinct restricted actions;
- run config validation before restart;
- trigger approved update/deployment;
- fetch sanitized recent errors;
- create backup.

### Proxy server / proxy control

Status: **confirmed runtime/context; referenced, repository not located**.

Known or likely components from current infrastructure context:

- Danted/SOCKS on `1080`;
- Python/Telegram proxy on `8080`;
- HAProxy relay on `80/443` shares a host but remains a separate service;
- source-IP allow-list is important.

Do not implement repository-specific changes until the actual repository/deployment source is identified.

Required monitoring:

- process/service status;
- listening ports;
- external connectivity through each proxy type;
- latency;
- current allow-list revision/hash;
- failed authentication/connection counters where safely available;
- disk/memory;
- config syntax.

Required control API/host agent:

- list sanitized allow-list entries;
- propose new entry;
- validate IP/CIDR and duplicate/conflict;
- generate config diff;
- explicit confirmation;
- apply atomically;
- validate service config;
- reload rather than restart where supported;
- verify new rule;
- rollback automatically on failed verification;
- audit every change.

The frontend must never accept arbitrary firewall commands or arbitrary config text.

### Weather

Provider is intentionally abstracted.

Required data:

- current conditions;
- feels-like;
- hourly precipitation;
- daily high/low;
- freshness timestamp;
- location;
- cached fallback.

No provider token in frontend.

### Calendar

Sources supported through adapters:

- iCloud/CalDAV or read-only calendar feed;
- Google Calendar;
- Exchange/Outlook;
- local read-only `.ics` source where appropriate.

Baseline:

- read-only aggregation first;
- write actions only for adapters proven to support write safely;
- source and sync freshness shown for every event;
- no assumption that “iPhone Calendar” means only iCloud: iPhone can display several account types.

### TickTick tasks

TickTick has an official Open API and an official Linux client, but API coverage must be tested against required operations before treating it as complete.

Integration priority:

1. official API adapter for projects/tasks supported by the API;
2. official calendar feed for read-only display where useful;
3. launch official TickTick Linux/web app for unsupported advanced operations;
4. never scrape local application data as the primary architecture.

Required functions:

- today/overdue/upcoming;
- complete task;
- quick create;
- project/list filtering;
- due dates;
- sync freshness;
- graceful read-only fallback.

## 2. Priority 1 — active project monitoring

### CleaManager

Repositories:

- `decorum-guy/CleaManager` — **confirmed repository**;
- `decorum-guy/clemanager-design` — **confirmed repository**.

Until a production deployment is confirmed, monitor CI/build and optional preview only.

Future health contract:

- frontend availability;
- backend liveness/readiness;
- database/migrations;
- document processing queue;
- AI/provider dependency status;
- storage;
- version/commit.

Potential actions:

- open preview;
- trigger build/deploy;
- restart worker/API;
- replay a failed non-destructive job after confirmation.

### Infopulse Showcase Telegram bot

Repository: `decorum-guy/AI_final_project_HSE_ivanchenko_sokolov` — **confirmed repository**.

Monitor only when an active deployment is identified:

- bot process;
- Telegram API connectivity;
- generation/provider dependency;
- queue/backlog;
- last successful user request;
- storage limits.

Required backend additions if absent:

- live/ready/details endpoints;
- version/commit;
- safe synthetic request that does not message real users;
- restricted restart.

### n8n

Deployment/repository must be identified during implementation.

Monitor:

- instance liveness/readiness;
- worker/queue mode if used;
- failed executions;
- workflow-specific push monitors;
- credential/database/storage health;
- backup freshness.

Control actions:

- run only allow-listed workflows;
- pass schema-validated parameters;
- show execution id and final result;
- do not expose arbitrary workflow IDs or credentials to frontend.

## 3. Priority 2 — opt-in projects

Repositories found but not automatically treated as production services:

- `decorum-guy/tgbot`;
- `decorum-guy/gin_tg_app`;
- `decorum-guy/3games_bot`;
- `decorum-guy/sav4us_tg_bot`;
- `decorum-guy/converter_tg_bot`;
- `decorum-guy/KROS_DocGen`;
- `decorum-guy/nok_site_redisign`;
- `decorum-guy/MusicMuseum`;
- `decorum-guy/BreakGateWorkout`.

They enter the service registry only after confirming that an active deployment exists and monitoring provides value. Repository existence alone is not evidence of a running service.

## 4. Standard health contract

### Public liveness

```http
GET /health/live
```

Example:

```json
{
  "ok": true,
  "service": "example-service"
}
```

### Readiness

```http
GET /health/ready
```

Returns success only when the service can perform its primary function. Dependency checks must have strict timeouts.

### Protected details

```http
GET /health/details
Authorization: Bearer <scoped-monitoring-token>
```

May include:

- version/commit;
- uptime;
- dependency states;
- queue depth;
- storage status;
- last successful operation;
- backup age.

Must not include:

- secrets;
- access tokens;
- message/email content;
- full personal data;
- raw stack traces;
- unnecessary internal topology.

## 5. Uptime Kuma role

Uptime Kuma is an external checker and incident source, not the only source of truth.

Use it for:

- HTTP/TCP/ping;
- TLS expiry;
- latency;
- push monitors from jobs;
- incident history and notifications.

Panel Agent combines Kuma results with protected application/host diagnostics.

## 6. Open identification tasks

Before implementing control actions, identify and record:

- actual proxy-server repository or deployment source;
- actual n8n host/deployment;
- current Home Assistant installation method and backup destination;
- which calendar account is authoritative on iPhone;
- TickTick API scopes and exact required operations;
- which optional repositories currently have live deployments.
