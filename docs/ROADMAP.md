# Roadmap

## Phase 0 — Discovery and target validation

- inventory laptop hardware, battery, storage and Windows state;
- verify touchscreen/tablet behavior;
- verify BlueStacks loyalty application and AnyDesk recovery;
- identify current HA installation method and backup destination;
- inventory critical home devices and local/cloud protocols;
- inventory proxy-server files, services and scripts directly on the host;
- identify n8n deployment;
- identify authoritative calendar account on iPhone;
- validate TickTick scopes/operations;
- choose initial cloud backup destination;
- define external-drive requirements;
- establish Windows security baseline and Linux Live USB checklist.

Exit criteria:

- no unknown critical dependency for first vertical slice;
- documented project/service/device inventory;
- Windows-first path confirmed;
- backup destination and free-space policy defined;
- security checklist approved.

## Phase 1 — Beautiful static visual MVP

Build the dashboard with realistic schema-driven development fixtures that are impossible to enable accidentally in production mode.

Deliver:

- Overview;
- Home;
- Services;
- Calendar;
- Tasks;
- Backups;
- Apps;
- System/Settings;
- multi-location weather switcher;
- day and night themes;
- ambient/handheld modes;
- signature animations from the first runnable build;
- touch navigation;
- monitor-only, one-action and multi-action project cards;
- backup lifecycle visual states.

Required MVP motion:

- touch feedback;
- card-to-detail shared transitions;
- service state morph;
- coffee progress/ready transitions;
- weather ambience;
- day/night transition without flash;
- command and backup lifecycle;
- reduced-motion/performance fallback.

Exit criteria:

- approved visual direction;
- smooth operation on target laptop;
- no production UI depends on fake data;
- projects without actions look intentional, not incomplete;
- no fake progress.

## Phase 2 — Panel Agent and security foundation

Deliver:

- FastAPI service;
- project/capability/action/backup schemas;
- config migrations;
- secure secret references;
- local storage/cache/audit;
- WebSocket/SSE stream;
- `/health/live`, `/health/ready`, protected details;
- separate kiosk profile/account;
- localhost-only API;
- firewall/update baseline;
- safe mode;
- Windows supervision and Chromium recovery.

Exit criteria:

- automatic start after login/reboot;
- frontend and agent recover independently;
- no secret in frontend/Git;
- no arbitrary shell endpoint;
- monitor-only mode works with all actions globally disabled;
- security acceptance from `docs/SECURITY_MODEL.md` passes.

## Phase 3 — Capability-based project onboarding

Deliver:

- `config/projects.yaml` runtime schema;
- adapter registry;
- Settings onboarding wizard;
- YAML and UI use the same validator;
- add/edit/disable/remove project;
- environments/services;
- independent capabilities;
- connection test and card preview;
- adapter/version compatibility;
- import/export config without secrets.

Acceptance examples:

- monitor-only external API;
- AVALAR stage with monitor + deploy + backup;
- AVALAR main with monitor + backup, no automatic deploy;
- proxy server without Git repository through host agent;
- disabled project produces no polling;
- capability can be removed without deleting project/history.

## Phase 4 — Read-only information and monitoring

Deliver:

- multi-location weather/geocoding/cache;
- Home Assistant state adapter;
- AliceTG Bot as child service of HA stack;
- AVALAR main/stage checks;
- AVALAR Exchange dependency graph;
- proxy checks through server-managed adapter;
- Uptime Kuma aggregation;
- calendar agenda;
- TickTick read adapter;
- system telemetry;
- backup destination monitoring.

Exit criteria:

- all values have freshness timestamps;
- stale/offline behavior tested;
- Overview remains useful from cache;
- weather cache never mixes locations;
- HA and AliceTG Bot failures are separate;
- no secret reaches frontend.

## Phase 5 — Backup engine

Deliver:

- backup profile registry;
- source adapters;
- laptop local destination;
- optional cloud sync with per-run choice;
- future external HDD/SSD destination support;
- checksums/manifests/archive verification;
- encryption before sensitive cloud sync;
- retention/quotas/free-space checks;
- backup history;
- restore-test tracking;
- partial-success state.

Initial profiles:

- Artem Control Center config/database;
- Home Assistant native backup;
- AliceTG Bot runtime state/config;
- AVALAR Website stage/main;
- AVALAR Exchange MCP;
- proxy configs/firewall/allow-list;
- n8n after runtime identification.

Exit criteria:

- one-button backup downloads verified local artifact;
- optional cloud sync is explicit;
- sensitive cloud copy encrypted;
- disk cannot be silently filled;
- restore test is recorded for at least one critical profile;
- backup success is not inferred from file existence alone.

## Phase 6 — Safe home control

Deliver:

- coffee controls through existing `AliceTG_Bot` flow;
- kettle and selected HA controls;
- command verification;
- safety/cooldown/idempotency;
- device local/cloud inventory;
- first verified local edge action;
- explicit authority modes.

Exit criteria:

- no duplicate automation execution;
- every command has verified result;
- HA and bot capability boundaries are explicit;
- offline behavior is honest;
- safety timers preserved or missing protections disclosed.

## Phase 7 — Service actions and deployments

Deliver restricted actions for:

- AVALAR stage deploy through fixed equivalent of `avalar-reg ./deploy.sh stage`;
- AVALAR stage browser/health verification;
- AVALAR Exchange MCP app/validator/maintenance;
- AliceTG Bot restart;
- proxy service reload/restart;
- n8n registered workflows;
- approved service checks.

Main deploy, restore, firewall and HA failover remain higher-risk separate capabilities.

Exit criteria:

- no arbitrary command or workflow id;
- each action validates and verifies;
- stage deploy records target/commit/output/health;
- rollback is separate and explicit;
- complete audit trail.

## Phase 8 — Transactional proxy allow-list

Deliver:

1. host inventory and version/checksum strategy;
2. restricted host agent;
3. current revision and sanitized list;
4. typed CIDR/project/reason input;
5. conflict validation;
6. exact diff;
7. hold + final confirmation;
8. backup current config;
9. atomic apply;
10. syntax validation/reload;
11. connectivity verification;
12. automatic rollback;
13. audit.

No repository is required, but server-side scripts/configs must become checksummed or otherwise versioned.

## Phase 9 — Calendar and task writes

Deliver only capabilities proven by selected providers:

- quick task create/complete;
- optional event creation;
- source-aware permissions;
- conflict/error handling;
- official app launch for unsupported operations.

No scraping of private local databases.

## Phase 10 — Laptop Linux migration

Before installation:

- full Windows backup;
- Live USB hardware test;
- Chromium kiosk;
- remote recovery;
- Waydroid loyalty app;
- encryption/firewall/update plan;
- local backup migration test.

After installation:

- systemd services and sandboxing;
- dedicated users;
- kiosk session;
- power/lid policy;
- auto recovery;
- performance/thermal/security test.

Exit criteria:

- all MVP functions match/exceed Windows;
- loyalty card works;
- suspend/wake/touch reliable;
- backup destinations work;
- remote recovery exists.

## Phase 11 — HA resilience and dedicated-server decision

Deliver:

- native HA backup monitoring;
- off-host encrypted copies;
- restore test;
- local edge expansion;
- optional stopped laptop standby;
- failover/failback/fencing runbook;
- requirements and budget for a dedicated compact local HA server.

Decision:

- laptop remains UI/edge/backup node;
- do not make it sole permanent HA primary;
- migrate HA to dedicated compact server only after hardware, backup and local-protocol readiness.

Exit criteria:

- no uncontrolled active-active;
- tested restore;
- explicit authority modes;
- laptop can reboot/move without permanently disabling smart home after dedicated migration.

## Phase 12 — Polish and expansion

- deeper service analytics;
- deployment/backup history;
- notification policy;
- cameras with privacy controls;
- expanded local edge;
- external-drive health;
- phone PWA;
- onboarding/settings polish;
- additional active repositories;
- periodic security review.
