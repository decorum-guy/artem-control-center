# Integrations and Health Registry

Этот документ фиксирует системы, которые Artem Control Center отображает, резервирует или контролирует, и изменения, необходимые в их backend/runtime.

## 1. Source statuses

- **confirmed repository** — repository найден в подключённом GitHub;
- **confirmed runtime/context** — runtime подтверждён рабочей историей проекта или прямым вводом владельца;
- **server-managed, no repository** — source/config существует непосредственно на сервере;
- **referenced, deployment not identified** — система известна, но её текущий host/runtime ещё не подтверждён;
- **proposed** — capability/contract запланированы, но не реализованы.

Repository existence не доказывает active deployment. Отсутствие repository не мешает мониторингу, backup или safe control через restricted host agent.

## 2. Capability-based registry

Каждый project/environment/service подключает независимые capabilities:

- `monitor`;
- `details`;
- `actions`;
- `deploy`;
- `backup`;
- `restore`;
- `logs`;
- `open`;
- `heartbeat`;
- `notifications`.

Monitor-only проект является нормальным сценарием. У проекта может быть 0, 1 или несколько actions. Наличие restart не требуется. Наличие backup не означает наличие restore, deploy или restart.

Детальный onboarding contract: `docs/PROJECT_ONBOARDING.md`.

## 3. Standard health contract

Для собственных backend/runtime adapters:

```http
GET /health/live
GET /health/ready
GET /health/details
```

### Liveness

Проверяет только процесс/event loop.

### Readiness

Проверяет способность выполнять primary function с bounded dependency timeouts.

### Protected details

Может включать:

- version/commit;
- uptime;
- dependency states;
- queue/backlog;
- storage status;
- last successful operation;
- deployment state;
- backup freshness.

Не включает:

- secrets;
- access tokens;
- email/calendar/task contents;
- raw private logs;
- full stack traces;
- unnecessary internal topology.

Legacy health endpoints сохраняются backward-compatible, пока consumers не переведены.

## 4. Artem Control Center

Repository: `decorum-guy/artem-control-center` — **confirmed repository**.

Health:

- Panel Agent live/ready/details;
- frontend heartbeat;
- Chromium kiosk process;
- WebSocket/SSE stream;
- config schema/migrations;
- SQLite integrity/writability;
- disk free space and backup quota;
- adapter scheduler;
- stale/error adapter counts;
- OS update/firewall status where available.

Capabilities:

- monitor;
- details;
- local system actions;
- backup own config/database;
- open Desktop mode.

Actions:

- restart Chromium;
- restart Panel Agent;
- reload validated config;
- refresh states;
- reboot/shutdown with protected confirmation.

## 5. Home Assistant runtime stack

Status: **confirmed runtime/context; Home Assistant itself has no dedicated Git repository in this project**.

Home Assistant is a runtime/infrastructure integration. Его config, database, native backups и deployment state мониторятся через HA API, host checks и backup adapters, а не через repository assumption.

Known stack:

- remote Home Assistant authoritative instance;
- Caddy/reverse proxy in runtime context;
- Home Assistant API/WebSocket;
- automations/scripts/entities;
- native backups;
- PushWard integration where enabled;
- related `AliceTG_Bot` container/repository.

Monitoring:

- public/TLS reachability;
- authenticated API readiness;
- WebSocket subscription;
- selected entity freshness;
- critical integration state;
- config validation;
- database/storage health signal;
- native backup freshness;
- current authority mode: remote-primary/local-primary/edge-fallback/standby;
- host disk/RAM/restart count.

Actions:

- run selected scripts/scenes;
- create native backup;
- validate config;
- restart Core only through restricted action;
- full failover/restore separate from normal actions.

Backup profile:

- native HA backup downloaded to laptop;
- optional encrypted cloud/external-drive sync;
- restore-test status;
- separate from `AliceTG_Bot` repository/runtime backup.

## 6. `decorum-guy/AliceTG_Bot`

Status: **confirmed repository**.

Clarification: this repository is the Telegram assistant integrated with Home Assistant. It is not the Home Assistant repository and should appear as a child service in the HA stack.

Verified behavior from repository:

- aiohttp server on port `8088`;
- existing `/health`;
- internal HA endpoints;
- coffee/kettle workflows;
- coffee warm-up/long-running timers;
- authenticated coffee shortcut endpoint;
- persistent bot states/reminders;
- Docker restart policy documented.

Required health additions:

- `/health/live` — process/event loop;
- `/health/ready` — Telegram transport, HA API and canonical timing helpers;
- protected `/health/details` — sanitized HA/timing-helper readiness, version,
  commit and observation time;
- Telegram timing changes use `input_number.set_value` and confirming HA reads;
- idempotency support for control requests.

Actions:

- reset only documented flags/modes;
- restart bot container;
- recheck HA dependency.

Coffee/kettle device commands are intentionally absent here: Control Center
executes and verifies them through Home Assistant.

Backups:

- Git repository protects source code;
- runtime state/config backup is a separate artifact;
- do not assume HA native backup necessarily replaces a tested bot-specific restore profile.

## 7. AVALAR Website — stage and main

Repository: `decorum-guy/AVALAR` — **confirmed repository**.

Environments:

- `main` → `avalar.pro`;
- `stage` → `stage.avalar.pro`.

Monitor independently:

- DNS/TLS/certificate expiry;
- homepage and representative pages;
- response time;
- critical assets/data loading;
- PHP/runtime checks;
- readable required data files;
- writable application directories where relevant;
- non-destructive form validation;
- deployed branch/commit/release marker;
- browser smoke.

Required health additions:

- public stateless `/health/live`;
- public stateless `/health/ready`, validating required content JSON;
- optional sanitized source/deployment details through fixed read-only SSH
  commands on a slower cadence.

REG.RU shared hosting is not expected to sustain a daemon or Control Center
listener. PHP health does not depend on process environment variables.
`/health/details` is intentionally absent; there is no reviewed shared-hosting
secret-storage contract. Panel Agent curls Main and Stage independently and may
run `details-main`/`details-stage` through the allow-listed SSH adapter.

### Stage deployment

Required registered action is a hardened equivalent of the current operator
procedure:

```text
ssh avalar-reg "~/avalar.sh stage"
```

Implementation:

- current live handler remains an implementation detail; the repo-side adapter
  adds dry-run-first policy, lock/cooldown, a 120-second default timeout and
  strict post-operation curl smoke;
- exact fixed handler, not arbitrary shell;
- target explicitly `stage`;
- optional validated ref/commit parameter only if deploy script supports it;
- precheck repository/deployment state;
- execute restricted server-side action;
- capture sanitized output;
- verify public live/ready/root smoke and optional SSH commit details;
- audit correlation id;
- rollback action separate and not inferred automatically.

Main deployment is a different high-risk capability and remains disabled until separately specified.

Stage deployment also remains disabled until a real run proves it reliably
fits the shared-hosting session limit. Backup and rollback capabilities are not
registered because no verified implementation exists.

Backups:

- stage/main profiles separate;
- server data/config/deployment metadata;
- local laptop destination always;
- optional encrypted cloud/external-drive sync;
- restore test on stage before considering a main restore process trusted.

## 8. AVALAR Exchange MCP

Repository: `decorum-guy/avalar_exchange_mcp` — **confirmed repository**.

Known architecture:

- `exchange.avalar.pro`;
- foreign HAProxy TCP relay;
- Russian Nginx/application host;
- MCP/OAuth/portal/status services;
- LanCloud IMAP/EWS dependencies;
- existing public `/health`.

Monitor as dependency graph:

1. DNS/TLS/public HTTP;
2. relay HAProxy;
3. origin Nginx;
4. MCP application liveness/readiness;
5. portal/status services;
6. OAuth metadata;
7. safe MCP smoke without real mail content;
8. databases/storage;
9. LanCloud IMAP/EWS;
10. deployment version/commit;
11. updater/service state;
12. backup freshness.

Required additions:

- keep existing `/health` backward compatible;
- add live/ready/protected details;
- expose redacted component states;
- safe non-mutating smoke;
- deployment/maintenance state.

Actions are independent:

- recheck full chain;
- restart MCP app;
- restart Nginx/HAProxy only as separate actions;
- run validator;
- set maintenance state;
- deploy/update only through approved workflow;
- create backup.

## 9. Proxy server

Status: **confirmed runtime/context; server-managed, no repository**.

Clarification: отдельного repository сейчас нет. Config/scripts/service units находятся непосредственно на server. Интеграция не должна ждать появления Git repository, но перед write actions необходимо создать inventory и restricted host agent.

Known components:

- Danted/SOCKS on `1080`;
- Python/Telegram proxy on `8080`;
- HAProxy relay on `80/443` on the same host as a separate component;
- source-IP allow-list/firewall rules.

Monitoring:

- process/service state;
- listener ports;
- authenticated egress test;
- latency;
- config syntax;
- allow-list revision/hash;
- failed connection/auth counters where safe;
- host disk/RAM;
- backup freshness.

Required host agent operations:

- sanitized status/details;
- export config/service units/firewall/allow-list backup;
- reload/restart named service;
- transactional allow-list add/remove;
- validate → diff → confirm → backup current config → atomic apply → syntax check → reload → verify → rollback.

Frontend never sends raw config or shell text.

## 10. n8n

Status: **referenced, deployment not identified**.

Monitor after host identification:

- liveness/readiness;
- database/Redis/queue mode where applicable;
- failed executions;
- workflow-specific push heartbeats;
- credentials/storage health;
- backup freshness.

Actions:

- run only registered workflows;
- schema-validated parameters;
- show execution id/final state;
- restart instance separately;
- arbitrary workflow id prohibited.

Backup:

- workflows;
- database and credential material through an encrypted dedicated export;
- binary storage if used;
- restore contract required.

## 11. Weather

Status: **proposed MVP integration**.

Capabilities:

- multiple saved locations;
- geocoding for city/district/address;
- normalized address and coordinates before save;
- current/hourly/daily forecast;
- favourite/default location;
- quick switcher;
- per-location cache/freshness;
- sunrise/sunset for theme automation.

A district/address forecast may proxy nearest provider grid point and is not an exact measurement at the building. UI shows selected point and data time.

No provider token in frontend.

## 12. Calendar

Adapters:

- iCloud/CalDAV;
- Google Calendar;
- Exchange/Outlook;
- local/read-only ICS.

Baseline:

- identify authoritative account displayed on iPhone;
- read-only aggregation first;
- source/freshness per event;
- writes only for verified provider capability;
- no assumption that iPhone Calendar means iCloud only.

AVALAR work calendar can be read through `avalar_exchange_mcp` while preserving its security boundaries.

## 13. TickTick

Status: official API/client exist, exact coverage requires validation.

Priority:

1. official API for supported operations;
2. official calendar feed for read-only fallback;
3. launch official app/web for unsupported operations;
4. never scrape private local application storage.

Required capabilities:

- today/overdue/upcoming;
- complete;
- quick create;
- lists/projects;
- due dates;
- sync freshness;
- graceful read-only fallback.

## 14. CleaManager

Repositories:

- `decorum-guy/CleaManager` — **confirmed repository**;
- `decorum-guy/clemanager-design` — **confirmed repository**.

Until active deployment is confirmed, monitor CI/build/preview only.

Future runtime health:

- frontend;
- backend live/ready;
- database/migrations/storage;
- document queue;
- AI/provider dependency as optional/degraded where appropriate;
- version/commit.

Possible independent actions:

- open preview;
- run health check;
- restart API/worker;
- deploy approved environment;
- replay non-destructive failed job;
- backup real data store.

## 15. ИнфоПульс

Repository: `decorum-guy/AI_final_project_HSE_ivanchenko_sokolov` — **confirmed repository**.

Monitor only when active deployment is identified:

- process/watchdog;
- Telegram API;
- storage;
- scheduler;
- RSS/provider dependencies;
- delivery heartbeats;
- last safe synthetic self-test.

Required additions:

- live/ready/details HTTP endpoints;
- version/commit;
- non-user-messaging synthetic test;
- restricted restart;
- backup profile for DB/config/runtime data.

## 16. Optional repositories

Repositories found but not automatically treated as running services include:

- `decorum-guy/tgbot`;
- `decorum-guy/gin_tg_app`;
- `decorum-guy/3games_bot`;
- `decorum-guy/sav4us_tg_bot`;
- `decorum-guy/converter_tg_bot`;
- `decorum-guy/KROS_DocGen`;
- `decorum-guy/nok_site_redisign`;
- `decorum-guy/MusicMuseum`;
- `decorum-guy/BreakGateWorkout`.

Onboarding для каждого определяется capabilities. Можно подключить monitor-only, open-only или backup-only без создания restart button.

## 17. Uptime Kuma role

Uptime Kuma — external checker и incident source, но не единственная source of truth.

Использование:

- HTTP/TCP/ping;
- TLS expiry;
- latency;
- push monitors;
- incident history/notifications.

Panel Agent дополняет Kuma protected diagnostics, capability registry, backup state и action verification.

## 18. Open identification tasks

- actual n8n host/deployment;
- current HA installation method and backup destination;
- inventory local/cloud protocols for home devices;
- authoritative calendar account on iPhone;
- TickTick scopes/exact operation coverage;
- server inventory/versioning approach for proxy configs/scripts;
- active deployments among optional repositories;
- selected cloud backup provider and external-drive filesystem/encryption policy.
