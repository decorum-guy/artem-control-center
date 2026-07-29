# Home Assistant Resilience Strategy

## 1. Current constraint

The current Home Assistant instance is remote and remains the authoritative controller during the first implementation phase.

Artem Control Center must remain useful in two different failure cases:

1. the remote Home Assistant host fails while the laptop still has Internet/LAN;
2. the laptop/home network loses Internet while local LAN devices remain reachable.

These cases are not equivalent and must be shown separately in the UI.

## 2. Do not use uncontrolled active-active Home Assistant

A second fully active Home Assistant instance with copied automations is not the default design.

Risks:

- duplicate automations;
- competing commands to the same device;
- divergent entity registries and helper state;
- duplicated notifications and timers;
- unclear authority after connectivity returns;
- unsafe automatic failback.

The project therefore uses three layers instead.

## 3. Layer A — Remote primary HA

Primary responsibilities:

- complete automation set;
- integrations requiring remote services;
- persistent smart-home history;
- Telegram/Alice workflows;
- normal coffee and kettle logic;
- notifications;
- canonical entity state.

Control Center communicates through authenticated Home Assistant APIs and existing application endpoints.

## 4. Layer B — Local Edge Controller

The local edge controller is part of Panel Agent or a small dedicated companion service.

It implements only a limited allow-list of critical LAN-capable actions, for example:

- coffee machine smart plug on/off;
- kettle smart plug on/off;
- selected lights/scenes;
- selected local relays;
- emergency all-off;
- local status probes.

An edge action is allowed only when all conditions are true:

- the device has a reliable local protocol or local bridge;
- credentials can be stored securely;
- the action is idempotent or its state can be verified;
- conflict behavior with primary HA is understood;
- the action is explicitly listed in configuration.

Possible local transports, depending on actual devices:

- local HTTP API;
- MQTT on the home LAN;
- ESPHome native API;
- vendor LAN protocol;
- local bridge controlled by Home Assistant-compatible protocol.

Cloud-only devices cannot become offline-capable merely by adding Control Center.

### Authority modes

Panel Agent maintains one of these modes:

- `primary-online`: use remote HA for all normal actions;
- `primary-degraded`: remote HA reachable but a dependency is degraded;
- `edge-fallback`: use only approved local actions;
- `offline-observe`: no safe write path, display cached state only;
- `standby-activation`: controlled warm-standby procedure in progress.

Fallback is visible in the UI. It must never silently pretend that the full smart home is available.

## 5. Layer C — Warm standby HA

A secondary Home Assistant installation may be prepared on the laptop, but normally remains stopped.

Purpose:

- faster recovery from loss of the remote HA host;
- manual or carefully controlled activation;
- restoration from recent encrypted backups.

Recommended behavior:

1. Primary HA creates encrypted automatic backups.
2. Backups are copied to a second destination available to the laptop.
3. Control Center monitors backup age and restore-key availability.
4. Warm standby periodically receives a tested backup, but remains stopped.
5. Activation requires an explicit failover flow.
6. Primary access is fenced/disabled before the standby begins controlling shared devices where possible.
7. Failback is a separate confirmed operation, not an automatic side effect of restored connectivity.

This is warm standby, not seamless high availability.

## 6. Failover flow

```text
Primary HA unhealthy
        ↓
Confirm Internet/LAN status
        ↓
Use edge fallback for critical actions
        ↓
Offer warm-standby activation only if outage persists
        ↓
Show backup timestamp and missing capabilities
        ↓
Require hold + second confirmation
        ↓
Fence primary where possible
        ↓
Start/restore standby
        ↓
Verify selected entities and automations
        ↓
Mark temporary authority explicitly
```

Automatic activation is deferred until fencing, device ownership and split-brain behavior are proven.

## 7. Backup requirements

Control Center monitors:

- last attempted backup;
- last successful backup;
- backup age;
- backup destination availability;
- encrypted emergency/restore key availability as a boolean only;
- last restore test date;
- standby configuration age.

Do not display or store the actual encryption key in frontend state.

Suggested policy:

- frequent encrypted primary backups;
- at least one copy outside the primary HA host;
- retention policy;
- periodic restore test;
- alert when backup or restore test is stale.

## 8. UI behavior during failures

### Internet lost, LAN available

Show:

- Internet offline;
- remote HA unavailable;
- local edge available/unavailable;
- which controls remain functional;
- cached remote states with timestamps.

### Primary HA down, Internet available

Show:

- remote host/service failure;
- cloud services may still work;
- local edge controls;
- restart/recovery actions if configured;
- standby readiness.

### LAN lost

Do not offer local device actions. Show network recovery diagnostics only.

### Stale state

Every cached entity displays:

- last update time;
- stale badge;
- disabled or guarded actions unless a direct local read/verification is available.

## 9. Implementation prerequisites

Before implementing edge control, inventory each important device:

- entity id;
- physical device/model;
- current HA integration;
- local/cloud classification;
- local API availability;
- credentials;
- state read method;
- command verification;
- conflict behavior;
- safe fallback actions.

The first candidate is the coffee machine path because existing Home Assistant and AliceTG Bot logic is already known. The edge implementation must preserve safety timers or clearly state which protections are unavailable during fallback.
