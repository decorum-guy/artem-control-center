# Home Assistant Resilience Strategy

## 1. Fixed hosting decision

Samsung Notebook 9 Pro will **not host Home Assistant**.

This is permanent:

- no HA primary;
- no HA standby VM/container;
- no copied HA automations;
- no test restore instance;
- no later migration making the panel laptop an HA server.

Laptop roles:

- Artem Control Center UI/kiosk;
- limited local Edge Controller for separately verified LAN actions;
- monitoring node;
- backup download/sync target;
- development/recovery interface;
- ordinary portable computer when needed.

A future local HA primary uses a separate dedicated compact server.

## 2. Current authority

Current Home Assistant runs on a remote server and remains authoritative until a controlled migration to dedicated local hardware.

HA owns the current smart-home devices in scope:

- coffee machine — P0;
- kettle — P1.

For coffee machine, HA is the only source of physical state, availability,
activation timestamp, command execution, and command verification.

`decorum-guy/AliceTG_Bot` is a separate Telegram assistant and the current
source of user-configurable coffee warm-up duration and long-running threshold.
It is not the coffee/kettle device-state authority.

## 3. Failure states must remain separate

Control Center distinguishes:

1. remote HA host failure;
2. HA API/WebSocket/application failure;
3. home Internet loss while LAN remains available;
4. local LAN failure;
5. coffee/kettle entity/integration failure;
6. `AliceTG_Bot` failure while HA remains healthy;
7. backup destination failure.

A bot outage must not mark HA or coffee widget offline when HA remains available.

## 4. Preferred topology

```text
Dedicated compact local server (future)
        ├── Home Assistant primary
        ├── local integrations/automations
        ├── stable power/network placement
        └── native HA backups

Samsung laptop
        ├── Artem Control Center UI
        ├── limited Edge actions
        ├── monitoring/diagnostics
        ├── backup copy/sync
        └── remote recovery interface

Remote server
        ├── current HA until migration
        ├── later off-site backup/relay role
        ├── external integrations
        └── independent monitoring
```

## 5. Why HA is excluded from laptop

- old consumer hardware;
- weak/unknown battery condition;
- one internal storage failure domain;
- portable/interactively used device;
- Windows maintenance and future Linux migration create downtime;
- Chromium, Panel Agent and Android runtime share resources;
- lid/suspend/reboot conflict with always-on HA;
- external HDD increases backup capacity but does not remove host risk.

## 6. Authoritative remote HA layer

Remote HA owns:

- canonical entity state;
- coffee/kettle control;
- complete automations;
- history;
- notifications;
- integrations;
- Telegram/Alice workflows where currently used.

Control Center uses authenticated HA REST/WebSocket and registered HA scripts/services.

## 7. Coffee machine contract

Panel Agent reads coffee state directly from HA.

Codex must inspect, read-only:

```text
/Users/aartemida/Documents/Homeassistant
```

to discover:

- exact coffee entity id;
- exact kettle entity id;
- scripts/services used for commands;
- last-turn-on helper/source;
- warm-up start/duration/ready logic;
- long-running safety logic;
- included YAML/packages/templates.

No entity IDs or durations may be guessed.

The discovery output belongs only in writable Control Center repo:

```text
docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md
```

Full rules: `docs/HOME_ASSISTANT_DEVICE_CONTRACT.md`.

## 8. AliceTG Bot relationship

Monitor separately:

- process health;
- Telegram connectivity;
- bot-specific state/schedules;
- backup freshness;
- restart action.

Rules:

- coffee widget reads only the safe read-only timing-policy contract, never bot
  physical state;
- coffee commands target HA scripts/services;
- bot outage does not block coffee state when HA is healthy;
- fresh cached timing policy remains usable with timestamp; stale/missing policy
  removes progress but leaves HA state visible;
- bot policy cannot compensate for unavailable HA state.

## 9. Local Edge Controller

Local Edge Controller is not HA.

It may later support only individually approved LAN-capable operations such as:

- direct smart-plug state/action;
- selected lights/relays;
- emergency all-off;
- local probes.

Allowed only when:

- reliable local protocol exists;
- credentials can be scoped;
- operation is idempotent/state-verifiable;
- conflict with HA is understood;
- safety protections remain valid;
- action is explicitly registered/audited.

Cloud-only devices do not become offline-capable merely because Control Center exists.

Coffee/kettle Edge actions are out of scope until actual device protocol and HA safety model are audited.

## 10. Authority modes

- `remote-primary-online`;
- `remote-primary-degraded`;
- `edge-fallback`;
- `offline-observe`;
- `dedicated-local-primary` after future migration;
- `migration-in-progress`;
- `split-brain-risk`.

There is no laptop HA mode. In split-brain risk, normal writes are blocked.

## 11. Backups and restore testing

Control Center downloads and verifies native HA backups but never restores/runs them on Samsung laptop.

Track:

- attempted/success timestamps;
- age/size/checksum;
- laptop copy;
- encrypted cloud/external copies;
- destination state;
- last/next restore test.

Restore tests run only on:

- future dedicated HA server before production cutover;
- separate disposable test host/VM;
- another explicitly approved isolated environment.

HA native backup and AliceTG Bot source/runtime backup are separate artifacts.

## 12. Future dedicated-server migration

Prerequisites:

- hardware purchased/tested;
- integrations/device protocols inventoried;
- HA backup restore succeeds in isolated test;
- stable network/power;
- no public admin port;
- migration/rollback runbooks;
- monitoring for host, HA, storage and backups.

Flow:

```text
prepare server
→ restore verified backup
→ validate entities/automations
→ schedule cutover
→ fence/stop old authority
→ enable dedicated local HA
→ verify coffee/kettle/home scenarios
→ retain rollback window
→ convert remote host to off-site/relay role
```

Samsung laptop remains UI/edge/backup and may reboot without disabling the smart home.

## 13. Failure UI

### Internet lost, LAN available

Show remote HA unavailable, cached states with timestamps and only separately verified local Edge actions. Never suggest starting HA on laptop.

### HA host/application down

Show failing layer, backup freshness, remote recovery actions and Alice bot separately.

### AliceTG Bot down, HA healthy

Show HA and coffee/kettle as healthy when their HA entities are healthy. Only bot-specific workflows are unavailable.

### Coffee/kettle entity unavailable

Show device-specific degraded state without declaring whole HA down.

### LAN lost

Disable local Edge actions and show diagnostics.

## 14. First-release decision

1. Keep remote HA authoritative.
2. Read coffee and kettle directly from HA.
3. Build mandatory coffee widget from HA device/activation state plus the
   separate read-only bot timing policy.
4. Add kettle with simpler HA device presentation.
5. Monitor AliceTG Bot separately.
6. Build verified HA backups.
7. Never run HA on Samsung laptop.
8. Plan a separate compact server as future infrastructure.
