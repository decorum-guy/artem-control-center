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
- touch navigation;
- monitor-only, one-action and multi-action project cards;
- Generic Service Widget;
- mandatory specialized coffee-machine widget;
- backup lifecycle visual states;
- widget preview/gallery route.

Required MVP motion:

- touch feedback;
- card-to-detail shared transitions;
- service state morph;
- coffee warm-up/ready/long-running transitions;
- weather ambience;
- day/night transition without flash;
- command and backup lifecycle;
- reduced-motion/performance fallback.

Exit criteria:

- approved visual direction;
- smooth operation on target laptop;
- UI and widgets run locally on macOS;
- coffee widget fixtures cover all required states;
- projects without actions look intentional;
- no production UI depends on fake data;
- no fake progress.

## Phase 2 — Panel Agent, registries and security foundation

Deliver:

- FastAPI service;
- project/capability/action/backup schemas;
- Widget Registry and widget manifest schema;
- config migrations;
- secure secret references;
- local storage/cache/audit;
- registry revision and snapshot/event stream;
- WebSocket/SSE state stream;
- `/health/live`, `/health/ready`, protected details;
- separate kiosk profile/account;
- localhost-only API;
- firewall/update baseline;
- safe read-only mode;
- Windows supervision and Chromium recovery;
- macOS development/fixture/read-only modes.

Exit criteria:

- automatic start after login/reboot on Windows;
- frontend and agent recover independently;
- Mac one-command dev workflow exists;
- no secret in frontend/Git;
- no arbitrary shell endpoint;
- monitor-only mode works with all actions disabled;
- security acceptance from `docs/SECURITY_MODEL.md` passes.

## Phase 3 — Automatic project onboarding and UI materialization

Deliver:

- runtime `config/projects.yaml`;
- adapter registry;
- Settings onboarding wizard;
- YAML and UI use one validator;
- add/edit/disable/remove project;
- environments/services;
- independent capabilities;
- connection test and card preview;
- registry revision updates;
- automatic Services catalog reconciliation;
- specialized Widget Resolver;
- mandatory Generic Service Widget fallback;
- `New items` placement area;
- import/export config without secrets;
- end-to-end test: enable service → visible UI instance.

Acceptance examples:

- monitor-only external API automatically appears with zero buttons;
- AVALAR stage appears with monitor + smoke + deploy + backup;
- AVALAR main appears without automatic deploy;
- proxy server appears without Git repository;
- disabled project produces no polling;
- capability can be removed without deleting history;
- new service cannot exist only in backend config.

## Phase 4 — Read-only information and monitoring

Deliver:

- multi-location weather/geocoding/cache;
- Home Assistant state adapter;
- AliceTG Bot as child service of HA stack;
- mandatory live coffee widget data integration;
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
- coffee duplicate `turn_on` does not reset timers;
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

- Artem Control Center config/database/layouts;
- Home Assistant native backup downloaded only, never restored/run on panel laptop;
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
- restore test is recorded for at least one critical profile on a separate approved host;
- backup success is not inferred from file existence alone.

## Phase 6 — Safe home control

Deliver:

- coffee controls through existing `AliceTG_Bot` flow;
- kettle and selected HA controls;
- command verification;
- safety/cooldown/idempotency;
- device local/cloud inventory;
- first verified local Edge action;
- explicit authority modes.

Constraints:

- Samsung laptop never hosts HA;
- Edge Controller is not HA;
- no duplicate automation execution;
- safety timers preserved or missing protections disclosed.

Exit criteria:

- every command has verified result;
- HA and bot capability boundaries are explicit;
- offline behavior is honest;
- coffee widget shows real authority/freshness.

## Phase 7 — Service actions and deployments

Deliver restricted actions for:

- AVALAR stage deploy through fixed equivalent of `avalar-reg ./deploy.sh stage`;
- AVALAR stage browser/health verification;
- AVALAR Exchange MCP app/validator/maintenance;
- AliceTG Bot restart;
- proxy service reload/restart;
- n8n registered workflows;
- approved service checks.

Main deploy, restore, firewall and HA migration remain higher-risk separate capabilities.

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

- all panel MVP functions match/exceed Windows;
- loyalty card works;
- suspend/wake/touch reliable;
- backup destinations work;
- remote recovery exists;
- HA is not installed on the laptop.

## Phase 11 — Dedicated Home Assistant server project

Deliver:

- requirements and budget for compact always-on hardware;
- storage/power/network requirements;
- verified native HA backup;
- restore test on separate test/dedicated hardware;
- migration/fencing/rollback runbook;
- monitoring of hardware, HA, storage and backups;
- controlled migration from remote HA when ready.

Fixed decision:

- laptop remains UI/Edge/backup node;
- laptop never becomes HA primary or standby;
- dedicated compact server is the only planned local HA host.

## Phase 12 — Customizable layouts

Post-MVP deliver:

- drag widgets;
- resize within manifest limits;
- move between sections/pages;
- pin/unpin;
- hide/show without disabling project;
- multiple named layouts;
- separate ambient/control/handheld layouts;
- undo/reset;
- keyboard-accessible reordering;
- collision-safe new item placement;
- layout backup/migration.

Exit criteria:

- new widgets never overwrite existing placement;
- hidden widget and disabled project remain distinct;
- layout changes survive restart and backup/restore;
- touch drag is reliable on Windows target.

## Phase 13 — No-code user widgets

Late-phase deliver:

- preset gallery;
- status/link/metric/text/clock/countdown/check/service-group presets;
- registered URL/data source selection;
- bounded refresh interval;
- safe field mapping;
- thresholds/formatting/icons;
- preview;
- placement in layout;
- declarative schema migrations.

Security:

- no arbitrary JavaScript/HTML/shell;
- no direct browser fetch;
- backend SSRF protection;
- registered sources/actions only;
- failure isolation.

## Phase 14 — Polish and expansion

- deeper service analytics;
- deployment/backup history;
- notification policy;
- cameras with privacy controls;
- expanded local edge;
- external-drive health;
- phone PWA;
- settings/onboarding polish;
- additional active repositories;
- periodic security review.
