# Home Assistant Resilience Strategy

## 1. Fixed hosting decision

The Samsung Notebook 9 Pro will **not host Home Assistant**.

This is a fixed project decision, not a temporary MVP limitation:

- no HA primary on the laptop;
- no HA warm standby VM/container on the laptop;
- no copied HA automation set running on the laptop;
- no future migration that makes the panel laptop an HA server.

The laptop remains:

- Artem Control Center UI/kiosk;
- local edge controller for explicitly verified LAN-capable actions;
- monitoring node;
- backup download/sync target;
- development and recovery interface;
- ordinary portable computer when needed.

A future local Home Assistant primary must use a **separate dedicated compact server**.

## 2. Current state and repository clarification

The current Home Assistant instance runs on a remote server and remains authoritative during the first implementation phase.

Home Assistant itself does not currently have a dedicated Git repository in this project. `decorum-guy/AliceTG_Bot` is the repository of the Telegram assistant integrated into the HA stack, not a repository of Home Assistant Core/config/data.

Control Center must distinguish:

1. remote HA host failure;
2. HA application/API/WebSocket failure;
3. home Internet loss while LAN remains available;
4. local LAN failure;
5. individual device/integration failure;
6. `AliceTG_Bot` failure while HA remains healthy;
7. backup destination failure.

These states must never be collapsed into one generic `Home Assistant offline` status.

## 3. Preferred long-term topology

```text
Dedicated compact local server
        ├── Home Assistant primary
        ├── local integrations and automations
        ├── stable network/power placement
        └── native HA backups

Samsung laptop
        ├── Artem Control Center UI
        ├── local edge actions
        ├── monitoring and diagnostics
        ├── backup copy/sync
        └── remote recovery interface

Remote server
        ├── current HA until dedicated migration
        ├── later off-site backup/relay role
        ├── external integrations
        └── independent remote monitoring
```

The dedicated server can later be a low-power mini PC or another reliable always-on host with SSD and preferably protected power. Exact hardware is not fixed yet.

## 4. Why HA is excluded from the laptop

The laptop is unsuitable as the permanent smart-home control plane because:

- it is old consumer hardware;
- battery condition is weak/unknown;
- it has a single internal storage failure domain;
- it is occasionally moved or used interactively;
- Windows maintenance and later Linux migration cause planned downtime;
- Chromium, Panel Agent and Android runtime share its resources;
- lid, suspend, reboot and portable use conflict with an always-on HA role;
- an external HDD improves backup capacity but does not remove host failure risk.

The laptop may still communicate directly with selected local devices through the Edge Controller. That does not make it a Home Assistant host.

## 5. Layer A — authoritative remote HA

During the first implementation phase, remote HA owns:

- canonical entity state;
- complete automation set;
- coffee/kettle safety logic;
- integrations requiring cloud/remote services;
- persistent history;
- notifications;
- Telegram/Alice workflows through `AliceTG_Bot`.

Control Center uses authenticated HA REST/WebSocket APIs and existing safe application endpoints.

## 6. Layer B — Local Edge Controller on the laptop

Local Edge Controller is part of Panel Agent or a small companion service. It is not Home Assistant.

It implements only individually approved LAN-capable operations, such as:

- local smart-plug on/off;
- selected lights/relays;
- emergency all-off;
- local device state probes.

An edge action is allowed only when:

- the device has a reliable local protocol/bridge;
- credentials can be scoped and stored securely;
- the operation is idempotent or state-verifiable;
- conflict behavior with authoritative HA is understood;
- required safety timers/protections are preserved or clearly disclosed;
- the action is explicitly registered and audited.

Cloud-only devices do not become offline-capable merely because Control Center exists.

## 7. Authority modes

Panel Agent maintains an explicit mode:

- `remote-primary-online`;
- `remote-primary-degraded`;
- `edge-fallback`;
- `offline-observe`;
- `dedicated-local-primary` after a future migration;
- `migration-in-progress`;
- `split-brain-risk`.

Fallback is always visible. In `split-brain-risk`, normal write actions are blocked until authority is resolved.

There is no `laptop-ha-primary` or `laptop-ha-standby` mode.

## 8. Backups and restore testing

Control Center monitors and downloads native HA backups, but it does not restore/run them on the Samsung laptop.

Tracked state:

- last attempted backup;
- last successful backup;
- age and size;
- checksum/archive verification;
- laptop copy;
- optional encrypted cloud/external-drive copies;
- destination availability;
- encryption-key availability as boolean only;
- last restore test;
- next restore-test due date.

Restore tests must run on:

- the future dedicated HA server before production migration;
- a separate disposable test host/VM not running on the panel laptop;
- another explicitly approved isolated environment.

HA backup and `AliceTG_Bot` backup are separate artifacts:

- native HA backup protects HA runtime/config/data according to the selected HA mechanism;
- Git protects bot source code;
- bot runtime state/config may require a separate encrypted backup profile.

## 9. Future migration to a dedicated local server

Migration begins only when:

- dedicated hardware is purchased and tested;
- local device protocols/integrations are inventoried;
- native HA backup/restore succeeds in a test environment;
- network and power placement are stable;
- remote access uses no public administrative port;
- migration and rollback runbooks exist;
- monitoring covers hardware, HA, storage and backups.

Migration flow:

```text
Prepare dedicated server
        ↓
Restore latest verified HA backup
        ↓
Validate integrations/entities/automations
        ↓
Schedule controlled cutover
        ↓
Fence/stop old authoritative HA
        ↓
Enable dedicated local HA
        ↓
Verify home scenarios and remote access
        ↓
Keep rollback window
        ↓
Convert remote server to off-site/relay role
```

The Samsung laptop remains UI/edge/backup after migration and may be moved or rebooted without disabling the smart home.

## 10. Failure UI

### Internet lost, LAN available

Show:

- Internet offline;
- remote HA unavailable;
- which local edge actions remain available;
- cached remote states with timestamps;
- no suggestion to start HA on the laptop.

### HA host/application down, Internet available

Show:

- failing host/application layer;
- `AliceTG_Bot` separately;
- backup freshness;
- registered remote recovery actions;
- local edge controls where verified.

### `AliceTG_Bot` down, HA healthy

Show:

- HA remains authoritative;
- bot-specific Telegram/coffee workflows unavailable;
- direct HA actions only when independently registered and safe;
- bot restart action without marking the whole HA stack offline.

### LAN lost

Disable local device actions and show network diagnostics.

### Stale data

Every cached entity displays timestamp and stale state. Write actions remain disabled unless a direct read/verification path is available.

## 11. Coffee-machine implications

The animated coffee widget is mandatory, but its source hierarchy must be explicit:

1. authoritative remote HA / existing `AliceTG_Bot` workflow;
2. later direct local edge source only after device capability audit;
3. cached state as display-only when neither source is reachable.

Local edge implementation must not silently bypass warm-up timers, long-running protection or idempotency. Missing protections must be visible before an action is allowed.

## 12. First-release decision

1. Keep remote HA authoritative.
2. Build detailed monitoring and verified native backups.
3. Build the mandatory coffee-machine widget against current HA/bot state.
4. Add selected local edge actions after device audit.
5. Never install or run Home Assistant on the Samsung laptop.
6. Plan and budget a separate compact local HA server as a future infrastructure project.
