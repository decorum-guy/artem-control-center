# Roadmap

## Phase 0 — Discovery and target validation

- inventory target laptop hardware and Windows state;
- confirm exact CPU/storage/battery health;
- verify touchscreen and tablet behavior;
- identify loyalty Android application and emulator constraints;
- identify Home Assistant installation method;
- inventory critical smart-home devices and local/cloud protocols;
- locate proxy-server source/deployment;
- locate n8n deployment;
- identify authoritative calendar account on iPhone;
- register TickTick API application and verify required scopes/operations;
- list live deployments among optional repositories.

Exit criteria:

- no unknown critical dependency for MVP;
- documented device/service registry;
- Windows-first path confirmed;
- Linux Live USB test checklist prepared.

## Phase 1 — Static visual prototype

Build the dashboard with realistic schema-driven mock fixtures, clearly marked as development fixtures.

Deliver:

- Overview;
- Home;
- Services;
- Calendar;
- Tasks;
- System;
- day theme;
- night theme;
- ambient mode;
- signature animations;
- touch navigation;
- responsive landscape/portrait behavior.

Exit criteria:

- approved visual direction;
- stable navigation;
- smooth operation on target laptop;
- no production UI depends on fake data.

## Phase 2 — Panel Agent foundation

Deliver:

- FastAPI service;
- configuration loading;
- service/action registry;
- local storage/cache;
- audit log;
- WebSocket/SSE state stream;
- `/health/live` and `/health/ready`;
- Windows service/supervision setup;
- Chromium kiosk launcher and recovery.

Exit criteria:

- automatic start after login/reboot;
- frontend survives agent restart;
- agent survives frontend restart;
- command lifecycle and audit proven.

## Phase 3 — Read-only integrations

Deliver:

- weather adapter;
- Home Assistant state adapter;
- AVALAR main/stage checks;
- AVALAR Exchange MCP checks;
- proxy checks without write control;
- Uptime Kuma aggregation;
- calendar agenda read adapter;
- TickTick read adapter;
- system telemetry.

Exit criteria:

- all values have freshness timestamps;
- stale/offline behavior tested;
- Overview works without Internet using cache;
- no secret reaches frontend.

## Phase 4 — Safe home control

Deliver:

- coffee controls through existing workflow;
- kettle and selected home controls;
- command verification;
- safety/cooldown rules;
- edge device inventory;
- first local fallback action;
- explicit primary/edge mode UI.

Exit criteria:

- no duplicate automation execution;
- every command has verified result;
- offline behavior is honest and deterministic;
- coffee safety behavior documented.

## Phase 5 — Service control

Deliver restricted actions for:

- AVALAR Exchange MCP application;
- relay HAProxy;
- origin Nginx;
- AliceTG Bot;
- Caddy/Home Assistant stack where safe;
- proxy services;
- approved deployments/workflows.

Exit criteria:

- no arbitrary shell endpoint;
- each action validates before applying;
- restart actions verify health;
- firewall/allow-list actions support diff and rollback;
- complete audit trail.

## Phase 6 — Calendar and task write operations

Deliver only capabilities supported safely by selected providers:

- quick task create;
- task completion;
- optional event creation;
- source-aware write permissions;
- conflict/error handling;
- official app launch for unsupported operations.

Exit criteria:

- no scraping of private local app databases;
- provider limitations displayed correctly;
- write operations tested against sandbox/non-critical data.

## Phase 7 — Home Assistant resilience

Deliver:

- encrypted backup monitoring;
- off-host backup copy;
- backup age alerts;
- local edge allow-list expansion;
- stopped warm-standby HA preparation;
- manual failover runbook;
- restore test;
- explicit fencing/failback process.

Exit criteria:

- no uncontrolled active-active operation;
- restore test succeeds;
- fallback capabilities documented by device;
- UI distinguishes every outage type.

## Phase 8 — Linux migration

Before installation:

- create complete Windows backup;
- test Ubuntu/Linux Live USB;
- verify hardware checklist;
- verify Chromium kiosk;
- verify AnyDesk/remote maintenance alternative;
- verify loyalty application through Waydroid or retain approved alternative.

After installation:

- systemd services;
- kiosk session;
- power/lid policy;
- local firewall;
- auto recovery;
- performance and thermal test.

Exit criteria:

- all MVP functions match or exceed Windows implementation;
- loyalty card path works;
- suspend/wake and touch are reliable;
- remote recovery path exists.

## Phase 9 — Polish and expansion

- deeper service analytics;
- deployment history;
- personalized scenes;
- custom sounds where useful;
- expanded local edge support;
- optional wall/desk layouts;
- optional phone PWA view;
- onboarding/configuration UI;
- additional active repositories.
