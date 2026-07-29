# Widget System and Automatic UI Materialization

## 1. Goal

Artem Control Center must never require a developer to manually add a project/service to a hard-coded screen after it has been enabled in Project Registry.

Two connected registries:

1. **Project Registry** — projects, environments, services, capabilities, health, actions and backup profiles.
2. **Widget Registry** — visual definitions capable of presenting normalized data contracts.

Every enabled service must become visible even when no specialized widget exists.

## 2. Automatic appearance contract

After enable and validation:

1. Panel Agent increments registry revision.
2. Panel Agent publishes full catalog snapshot plus change event.
3. Frontend reconciles Registry Store.
4. Widget Resolver searches for a compatible specialized widget.
5. If absent, it creates `core.generic-service`.
6. Service appears in `Services` and `New items`.
7. Layout Reconciler places it without overwriting existing layout.
8. Playwright confirms visibility/detail navigation.

No service may silently exist only in backend configuration.

Frontend reconnect always starts with full snapshot. Events are an optimization, not sole truth.

## 3. Forbidden implementation patterns

- manually importing each project into a page;
- `if project.id === ...` chains for ordinary rendering;
- requiring frontend release to display monitor-only service;
- assuming every service has restart/deploy/backup;
- hiding unknown service instead of generic fallback;
- considering backend config success sufficient without visible UI reconciliation.

Project-specific code is allowed only for domain visualization, formatters and explicitly registered action presentation.

## 4. Generic Service Widget

Supports:

- name/environment;
- normalized status;
- latency;
- last successful check/freshness;
- dependency summary;
- incident indicator;
- version/commit/config revision;
- zero, one or several policy-provided actions;
- backup freshness;
- open/details navigation.

A monitor-only service intentionally has no action bar.

## 5. Widget categories

### Core generic

- service status;
- project group;
- incident summary;
- metric/value;
- text/status;
- link/launcher;
- action launcher;
- backup freshness;
- calendar agenda;
- tasks;
- weather;
- system health;
- generic Home Assistant device.

### First-party specialized

- coffee-machine warm-up;
- HA authority/fallback status;
- AVALAR deployment timeline;
- AVALAR Exchange dependency chain;
- proxy allow-list status;
- multi-location weather scene.

### Custom coded

Codex/developers use one package template:

```text
widgets/<widget-id>/
├── manifest.ts
├── Widget.tsx
├── settings.schema.ts
├── data.contract.ts
├── fixtures.ts
├── Widget.test.tsx
├── preview fixture
└── README.md
```

Custom widgets register globally and are not manually wired into pages.

### No-code declarative — later phase

Safe presets may include:

- status/health;
- link;
- clock/countdown;
- text/note;
- metric;
- check result;
- grouped services;
- image/icon launcher;
- registered action launcher;
- sanitized JSON field mapping through Panel Agent.

No arbitrary JavaScript, HTML, shell or direct browser network access.

## 6. Widget manifest

```ts
type WidgetManifest = {
  id: string
  version: number
  title: string
  kind: 'generic' | 'specialized' | 'user-preset'
  supportedDataContracts: string[]
  requiredCapabilities?: string[]
  optionalCapabilities?: string[]
  settingsSchema: unknown
  defaultSize: { columns: number; rows: number }
  minSize: { columns: number; rows: number }
  maxSize?: { columns: number; rows: number }
  supportedModes: Array<'ambient' | 'control' | 'handheld'>
  priority: number
  performanceClass: 'light' | 'medium' | 'heavy'
  permissions: string[]
}
```

Widget receives normalized presentation data and allowed action descriptors only. It never receives secrets or unrestricted backend access.

Resolution order:

1. explicit user assignment;
2. configured specialized widget;
3. highest-priority compatible specialized widget;
4. compatible core generic widget;
5. mandatory `core.generic-service`.

A widget update cannot silently acquire write permissions.

## 7. Coffee Machine Widget — mandatory MVP P0

`home.coffee-machine` is a first-class P0 widget using the normal plugin contract.

### Authority

Home Assistant is the only device-state and command authority.

The widget reads from HA:

- current state/availability;
- last activation timestamp;
- command verification.

Canonical HA helpers provide the current user-configurable warm-up duration and
long-running threshold. `AliceTG_Bot` is only a Telegram editor for those
helpers. Its outage must not affect device state or timing while HA is healthy.

Exact entity IDs and warm-up mapping must be discovered read-only from:

```text
/Users/aartemida/Documents/Homeassistant
```

and documented in `docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md`.

### Required states

- `off`;
- `turning_on`;
- `warming`;
- `ready`;
- `running`;
- `running_too_long`;
- `turning_off`;
- `unavailable`;
- `stale`.

### Required data

- HA device-state object with `authority: home-assistant`;
- exact entity state, availability, confirmed last-on timestamp, and freshness;
- separate HA timing-policy object with duration, threshold, revision,
  fetch time, and stale state;
- derived remaining time/progress;
- running duration;
- freshness;
- allowed actions and disabled reason.

### Progress rules

Progress requires both a confirmed HA activation time and sufficiently fresh
HA timing policy. A cached HA policy is allowed with explicit timestamp/stale
state. Missing or stale policy produces `running` without percentage. Never
hard-code the discovered 13/60-minute values.

### Interactions

- turn on through existing HA script/service;
- turn off through existing HA script/service;
- details;
- visible action lifecycle;
- state verification in HA;
- duplicate turn-on does not reset timer;
- long-running policy warning (“работает слишком долго”).

Do not label the policy threshold as physical overheating without a real
HA/device overheat signal.

### Visual behavior

- animated real progress only;
- distinct stage transitions;
- restrained steam/heat animation;
- calm ready transition;
- persistent non-flashing long-running warning;
- reduced-motion/low-performance versions;
- deterministic fixtures for every state.

Full HA mapping rules: `docs/HOME_ASSISTANT_DEVICE_CONTRACT.md`.

## 8. Kettle widget

The kettle is HA-controlled and included from the beginning, but lower priority.

MVP may use `core.generic-home-device`:

- HA availability/on/off;
- freshness;
- existing HA script/service actions;
- HA verification.

Coffee-specific warm-up assumptions must not be reused.

## 9. Layout system

### MVP

- stable configured defaults;
- responsive landscape/handheld layouts;
- automatic new-item materialization;
- full Services catalog;
- basic show/hide/pin when Settings supports it;
- no service disappears due to missing manual grid entry.

### Post-MVP

User can:

- drag;
- resize within manifest limits;
- move between pages/sections;
- pin/unpin;
- hide without disabling project;
- restore defaults;
- create named layouts;
- keep separate ambient/control/handheld profiles;
- undo layout changes.

Project state and layout state are independent.

## 10. New-item placement

New enabled widgets:

1. always enter Services catalog;
2. appear in `Settings → New items`;
3. receive a generic/specialized instance;
4. enter inbox/default area unless `catalog_only`;
5. show `new` until acknowledged;
6. never overwrite or unexpectedly move existing items.

When no space exists, place below or in inbox — never discard.

## 11. Layout persistence

Store through Panel Agent:

- schema version;
- profile/user/display;
- mode/breakpoint/orientation;
- widget instance ids;
- positions/sizes;
- hidden/pinned state;
- modified timestamp/source.

Include layouts in Control Center config backup; no secrets.

## 12. User widget builder — late phase

Flow:

1. choose preset;
2. title/icon;
3. registered data source;
4. optional permitted link;
5. bounded refresh interval;
6. safe field mapping;
7. display template;
8. stale/error behavior;
9. preview;
10. save/place.

Network requests go through Panel Agent with allow-list, rate limits and SSRF protection. Write actions reference existing registered action IDs only.

## 13. Settings UI

Without code editing:

- enable/disable projects/services/capabilities;
- show/hide/pin widgets;
- choose compatible widget;
- edit safe widget settings;
- weather locations;
- backup destinations/policies;
- registry/layout revisions;
- preview;
- export config without secrets;
- reset defaults with confirmation.

Arbitrary code, adapters, shell or privilege escalation are never ordinary settings.

## 14. Required tests

- enabled service automatically appears;
- monitor-only renders with no buttons;
- multi-action controls come only from policy;
- specialized resolution;
- generic fallback;
- disable stops polling and hides active UI;
- re-enable preserves history;
- placement never deletes existing layout;
- widget error isolation;
- layout migration preserves ids;
- all coffee fixtures;
- coffee widget remains available when Alice bot fixture is down but HA is healthy;
- no-code widget cannot request arbitrary network/shell access.

## 15. Definition of Done

A service is integrated only when visible and testable.

A widget is complete only with:

- manifest;
- typed data/settings contracts;
- loading/stale/offline/error states;
- fixtures/tests;
- accessibility;
- reduced-motion;
- performance classification;
- secure action/data boundaries.
