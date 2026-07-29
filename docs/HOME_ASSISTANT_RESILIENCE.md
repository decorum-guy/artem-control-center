# Home Assistant Resilience Strategy

## 1. Current state and clarification

The current Home Assistant instance is remote and remains the authoritative controller during the first implementation phase.

Home Assistant itself does not currently have a dedicated Git repository in this project. `decorum-guy/AliceTG_Bot` is the repository of the Telegram assistant integrated into the HA stack, not the repository of Home Assistant Core/config/data.

Artem Control Center must distinguish:

1. remote HA host/service failure while Internet/LAN still work;
2. home Internet loss while LAN devices remain reachable;
3. local LAN failure;
4. failure of an individual device/integration;
5. failure of `AliceTG_Bot` while HA remains healthy.

These states are not interchangeable and must be displayed separately.

## 2. Hosting decision

### Do not make the Samsung laptop the only permanent HA primary in the initial architecture

The laptop is valuable as:

- UI/kiosk;
- local edge controller;
- backup target;
- monitoring node;
- temporary recovery/standby host;
- ordinary portable computer when needed.

It is not the preferred single critical HA host because:

- it is old consumer hardware;
- battery health is weak/unknown;
- internal storage is a single failure domain;
- the laptop may be moved, closed, rebooted or used interactively;
- Windows-first maintenance and later Linux migration create planned interruptions;
- panel/Chromium/Waydroid workloads share resources with HA;
- external HDD can improve backup capacity but not remove host failure risk.

This is a reliability decision based on the described use, not a claim that HA technically cannot run on the laptop.

### Preferred long-term topology

```text
Dedicated compact local HA server
        ├── Home Assistant primary
        ├── local integrations/automations
        └── native backups

Samsung laptop
        ├── Artem Control Center UI
        ├── local edge actions
        ├── monitoring
        ├── backup copy/sync
        └── optional stopped recovery environment

Remote server
        ├── off-site backup/relay
        ├── external integrations
        └── remote monitoring
```

A future compact server can be a low-power mini PC or another reliable dedicated host with SSD and preferably protected power. Exact hardware is a later purchasing decision and is not fixed in this repository.

## 3. Do not use uncontrolled active-active Home Assistant

A second fully active HA instance with copied automations is not the default design.

Risks:

- duplicate automations;
- competing commands to the same device;
- divergent entity/helper state;
- duplicated notifications and timers;
- unclear authority after connectivity returns;
- unsafe automatic failback.

The project uses explicit layers and authority modes instead.

## 4. Layer A — Remote primary HA

First implementation responsibilities:

- complete automation set;
- canonical entity state;
- integrations requiring remote services;
- persistent history;
- normal coffee/kettle logic;
- notifications;
- Telegram/Alice workflows through `AliceTG_Bot`.

Control Center communicates through authenticated HA APIs and existing safe application endpoints.

## 5. Layer B — Local Edge Controller

The local edge controller is part of Panel Agent or a small companion service.

It implements only an allow-list of critical LAN-capable actions, for example:

- coffee machine smart plug on/off;
- kettle on/off;
- selected lights/relays;
- emergency all-off;
- local status probes.

An edge action is allowed only when:

- the device has a reliable local protocol or bridge;
- credentials can be stored securely;
- action is idempotent or state-verifiable;
- conflict behavior with primary HA is understood;
- action is explicitly registered;
- required safety timers/protections are preserved or clearly disclosed.

Possible transports depend on actual devices:

- local HTTP API;
- MQTT;
- ESPHome native API;
- vendor LAN protocol;
- local bridge.

Cloud-only devices do not become offline-capable merely because Control Center exists.

## 6. Authority modes

Panel Agent maintains an explicit mode:

- `remote-primary-online`;
- `remote-primary-degraded`;
- `edge-fallback`;
- `offline-observe`;
- `standby-activation`;
- `local-primary`;
- `split-brain-risk`.

Fallback is always visible. In `split-brain-risk`, normal write actions are blocked until authority is resolved.

## 7. Layer C — Laptop warm standby

A secondary HA environment may be prepared on the laptop, but normally remains stopped.

Purpose:

- test restore procedures;
- faster temporary recovery from remote host loss;
- validate a future local-primary migration;
- preserve a runnable emergency environment.

Recommended behavior:

1. Primary HA creates native encrypted backups.
2. Control Center downloads a copy to the laptop.
3. Optional encrypted copy is synced to cloud/external drive.
4. Backup age and last restore test are monitored.
5. Standby remains stopped during normal operation.
6. Activation requires explicit failover flow.
7. Primary is fenced/disabled where possible before standby controls shared devices.
8. Failback is a separate confirmed procedure.

This is warm standby, not seamless HA clustering.

## 8. Future dedicated local primary

A dedicated compact server becomes the preferred candidate when the goal changes from experimental fallback to reliable local smart-home operation.

Decision gate:

- local device protocols have been inventoried;
- native HA backup/restore has been tested;
- power/network placement is stable;
- sufficient storage and backup destinations exist;
- remote access does not require public administrative ports;
- migration and rollback runbook exists;
- monitoring covers server, HA, storage and backups.

After migration:

- dedicated server is authoritative local HA;
- laptop remains UI/edge/backup node;
- remote server becomes off-site/relay/integration layer;
- laptop can be moved or rebooted without disabling the whole smart home.

## 9. Failover flow

```text
Primary HA unhealthy
        ↓
Classify Internet / LAN / host / application failure
        ↓
Use only verified local edge actions where available
        ↓
Show latest backup and missing capabilities
        ↓
Offer standby activation only after explicit decision
        ↓
Hold + second confirmation
        ↓
Fence primary where possible
        ↓
Start/restore standby
        ↓
Verify selected entities and automations
        ↓
Mark temporary authority explicitly
```

Automatic full activation is deferred until fencing and split-brain behavior are proven.

## 10. Backup requirements

Control Center monitors:

- last attempted backup;
- last successful backup;
- backup age/size;
- laptop copy;
- optional cloud/external-drive copies;
- destination availability;
- encryption-key availability as boolean only;
- checksum/archive verification;
- last restore test;
- standby configuration age.

Do not expose the encryption key in frontend state.

HA backup and `AliceTG_Bot` backup are separate artifacts:

- HA native backup protects HA runtime/config/data according to selected HA mechanism;
- Git protects bot source code;
- bot runtime state/config may require a dedicated encrypted backup profile.

## 11. UI behavior during failures

### Internet lost, LAN available

Show:

- Internet offline;
- remote HA unavailable;
- local edge available/unavailable;
- functional controls only;
- cached remote states with timestamps.

### Primary HA down, Internet available

Show:

- remote host/application failure;
- other cloud services may work;
- local edge controls;
- restricted restart/recovery actions;
- standby and backup readiness.

### AliceTG Bot down, HA healthy

Show:

- HA remains authoritative;
- bot-specific coffee/Telegram flows unavailable;
- direct HA actions only if separately registered and safe;
- bot restart action without marking whole HA offline.

### LAN lost

Disable local device actions and show network diagnostics.

### Stale state

Every cached entity displays timestamp/stale badge. Write actions remain disabled unless a direct local read/verification path exists.

## 12. Implementation prerequisites

Before edge/local-primary work, inventory each important device:

- entity id;
- physical model;
- HA integration;
- local/cloud classification;
- local API;
- credentials;
- state read method;
- command verification;
- conflict behavior;
- safe fallback actions;
- safety timers/protections.

The coffee machine path is the first candidate because existing HA and `AliceTG_Bot` logic is known. Local implementation must preserve safety behavior or explicitly state what is unavailable.

## 13. First-release decision

1. Keep remote HA authoritative.
2. Build reliable monitoring and backups.
3. Add selected local edge actions after device audit.
4. Use laptop for backup copies and optional stopped standby tests.
5. Do not make laptop the sole permanent HA host.
6. Plan a separate compact local server when budget and local-first requirements justify it.
