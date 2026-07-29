# Widget System and Automatic UI Materialization

## 1. Goal

Artem Control Center must never require a developer to manually add a project or service to a hard-coded screen after it has already been enabled in the project registry.

The system uses two connected registries:

1. **Project Registry** — projects, environments, services, capabilities, health, actions and backup profiles.
2. **Widget Registry** — visual components capable of presenting those data contracts.

An enabled service must automatically become visible in the UI even when no specialized widget exists for it.

## 2. Non-negotiable automatic appearance contract

After a project/service is enabled and configuration validation succeeds:

1. Panel Agent increments the registry revision.
2. Panel Agent publishes a fresh project catalog snapshot and a registry-change event.
3. Frontend reconciles its local catalog with the new revision.
4. Widget Resolver searches for a compatible specialized widget.
5. If none exists, it creates a **Generic Service Widget** from the service metadata and capabilities.
6. The service appears automatically in `Services` and in the `New items` placement area.
7. The UI shows a visible onboarding result, not only a success toast.

No service may silently exist only in backend configuration.

A service is considered successfully onboarded only when:

- registry validation passed;
- backend probes/adapters were registered;
- frontend received the new registry revision;
- a visible generic or specialized widget instance was materialized;
- the user can open its detail view;
- automated UI test confirms that the service is present.

## 3. Registry data flow

```text
Settings UI / config/projects.yaml
              ↓
Panel Agent schema validation
              ↓
Project Registry + capability graph
              ↓
registry revision + snapshot/events
              ↓
Frontend Registry Store
              ↓
Widget Resolver
       ┌──────┴────────┐
       ↓               ↓
specialized widget   generic fallback widget
       └──────┬────────┘
              ↓
Layout Reconciler
              ↓
Services catalog + dashboard placement
```

Required events:

- `registry.snapshot`;
- `project.added`;
- `project.updated`;
- `project.enabled`;
- `project.disabled`;
- `project.removed`;
- `service.added`;
- `service.updated`;
- `capabilities.changed`;
- `widget.definition.added`;
- `widget.instance.created`;
- `layout.reconciled`.

Frontend reconnect always begins with a complete snapshot. Events are an optimization, not the sole source of truth.

## 4. No hard-coded service lists

Forbidden patterns:

- manually importing every project into a page;
- `if project.id === ...` chains for ordinary rendering;
- requiring a frontend release to display a monitor-only service;
- assuming every service has restart/deploy/backup actions;
- hiding unsupported services without a fallback card;
- using widget presence as proof that backend onboarding succeeded.

Allowed project-specific code:

- optional specialized widget;
- adapter-specific formatter;
- domain visualization such as coffee warm-up;
- carefully registered action presentation.

The generic path must remain functional for every schema-valid service.

## 5. Generic Service Widget

The generic fallback widget supports:

- project/service name;
- environment;
- current normalized status;
- latency where available;
- last successful check;
- stale timestamp;
- dependency summary;
- incident indicator;
- version/commit/config revision where available;
- zero, one or multiple actions generated from capability policy;
- backup freshness where enabled;
- open/details navigation.

A monitor-only service intentionally has no action bar.

The generic widget is not a temporary broken state. It is a supported production presentation for integrations that do not need a custom design.

## 6. Widget types

### 6.1 Core generic widgets

Provided by the platform:

- service status;
- project group;
- incident summary;
- metric;
- text/status value;
- link/launcher;
- action launcher;
- backup freshness;
- calendar agenda;
- tasks;
- weather;
- system health.

### 6.2 First-party specialized widgets

Built for important domain experiences but registered through the same widget contract:

- coffee-machine warm-up;
- Home Assistant authority/fallback state;
- AVALAR deployment timeline;
- AVALAR Exchange dependency chain;
- proxy allow-list status;
- multi-location weather scene.

### 6.3 Custom coded widgets

Codex/developers create widgets through one template and registry API. A custom widget is not wired directly into a page.

Required package contents:

```text
widgets/<widget-id>/
├── manifest.ts
├── Widget.tsx
├── settings.schema.ts
├── data.contract.ts
├── fixtures.ts
├── Widget.test.tsx
├── Widget.stories.tsx or preview fixture
└── README.md
```

### 6.4 No-code declarative widgets

Planned after the working prototype and MVP.

Users create widgets from safe presets without writing JavaScript. Presets may include:

- status from HTTP/health source;
- link tile;
- clock/countdown;
- text/note;
- metric/value;
- check result;
- grouped service summary;
- image/icon with link;
- registered action launcher;
- simple JSON field mapping through a backend adapter.

No-code widgets are declarative only. They cannot execute arbitrary JavaScript, shell commands or unrestricted network requests.

## 7. Widget manifest contract

Each widget definition declares:

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

Widget code receives normalized presentation data and allowed action descriptors. It does not receive raw secrets or unrestricted backend access.

## 8. Widget resolution

Resolution order:

1. explicit widget instance selected by the user;
2. specialized widget explicitly assigned by project configuration;
3. highest-priority compatible specialized widget;
4. compatible core generic widget;
5. Generic Service Widget as mandatory fallback.

A widget update cannot silently acquire new write permissions. Permissions/capabilities are granted by Panel Agent policy, not by the React component.

## 9. Coffee Machine Widget — mandatory MVP P0

The coffee-machine widget is a first-class mandatory MVP feature and must still follow the standard widget plugin contract.

Required states:

- `off`;
- `turning_on`;
- `warming`;
- `ready`;
- `running`;
- `running_too_long`;
- `turning_off`;
- `unavailable`;
- `stale`;
- `edge_fallback` where later supported.

Required data:

- authoritative source (`remote HA`, `AliceTG_Bot`, later `local edge`);
- on/off state;
- started-at timestamp;
- warm-up duration or real progress source;
- remaining time;
- ready state;
- long-running duration;
- last update timestamp;
- action availability and reason when disabled.

Required interactions:

- turn on;
- turn off;
- open detail;
- visible action lifecycle;
- state verification after command;
- no duplicated timer reset on repeated `turn_on`;
- safety warning when running too long.

Required visual behavior:

- animated real progress, never invented progress;
- distinct stage transitions rather than an arbitrary smooth color gradient;
- restrained steam/heat animation;
- rewarding but calm `ready` transition;
- persistent long-running warning without aggressive flashing;
- reduced-motion and low-performance variants.

The widget must be testable with deterministic fixtures for every state.

## 10. Layout system

### MVP

- stable default layouts authored in configuration;
- responsive landscape and handheld layouts;
- automatic materialization of new items;
- pin/unpin and show/hide may be introduced once base Settings UI exists;
- no service disappears because it lacks a manual grid entry.

### Post-MVP

User can:

- drag widgets;
- resize supported widgets;
- move widgets between dashboard pages/sections;
- pin/unpin;
- hide without disabling the underlying project;
- restore default layout;
- create multiple named layouts;
- use separate layouts for `ambient`, `control` and `handheld` modes.

Layout state is separate from project state:

- disabling a project stops probes/actions/schedules;
- hiding a widget changes presentation only;
- removing a widget instance does not delete project configuration;
- re-enabling a project creates/reconciles a visible widget if no instance exists.

## 11. New item placement

New enabled services/widgets follow a deterministic policy:

1. always appear in the complete Services catalog;
2. appear in `Settings → New items`;
3. receive a generic widget instance;
4. enter a designated dashboard inbox/default area unless project policy says `catalog_only`;
5. show a visible `new` badge until acknowledged or positioned;
6. never overwrite or unexpectedly move existing user layout items.

Post-MVP drag-and-drop uses collision-safe layout reconciliation. When a new item has no free space, it is placed below the current layout or in the inbox, not discarded.

## 12. Layout persistence and sync

Layout records include:

- schema version;
- profile/user;
- display target;
- mode;
- breakpoint/orientation;
- widget instance ids;
- positions/sizes;
- hidden/pinned state;
- last modified timestamp;
- source (`default`, `user`, `migration`).

Layouts are stored by Panel Agent and included in Control Center configuration backup. They contain no secrets.

## 13. User widget builder — later phase

Planned Settings flow:

1. choose preset;
2. enter title/icon;
3. choose data source adapter;
4. enter link or select registered source;
5. select refresh/check interval within platform limits;
6. map supported fields;
7. choose display template;
8. configure stale/error behavior;
9. preview with safe fixture/live read-only test;
10. save and place in layout.

Potential configurable fields:

- URL or registered endpoint reference;
- refresh interval;
- timeout;
- expected status/text;
- JSON field path from sanitized backend response;
- units/number formatting;
- icon;
- link behavior;
- threshold rules;
- date/time/countdown;
- size preset;
- visibility by mode;
- optional registered action reference.

Limits:

- network access goes through Panel Agent adapters;
- minimum refresh intervals prevent request storms;
- domains/endpoints follow allow-list and SSRF protection;
- no arbitrary scripts;
- write actions can only reference existing registered action ids;
- user widget failure is isolated and cannot crash the dashboard.

## 14. Settings UI requirements

Settings must allow ordinary configuration without editing code:

- enable/disable projects;
- enable/disable individual services/capabilities;
- show/hide/pin widgets;
- choose a specialized or generic compatible widget;
- configure widget-safe settings;
- manage weather locations;
- manage backup destinations/policies;
- view registry and layout revisions;
- preview changes;
- export configuration without secrets;
- restore defaults with confirmation.

Complex architecture changes, arbitrary code, adapter implementation and unrestricted shell commands are not exposed as user settings.

## 15. Testing requirements

Automated tests must cover:

- enabled service automatically appears after registry update;
- monitor-only service renders without buttons;
- service with multiple actions renders policy-provided controls;
- specialized widget resolves when compatible;
- generic fallback resolves when specialized widget is absent;
- disabled service disappears from active UI and stops polling;
- re-enabled service returns without losing history;
- new item placement never deletes existing layout items;
- widget error boundary isolates one failing widget;
- layout migration preserves widget ids;
- coffee widget fixtures cover every state;
- no-code widget cannot request arbitrary network/shell access.

## 16. Definition of Done

A new service is not considered integrated until it is visible and testable in the UI.

A new widget is not complete until it has:

- manifest;
- typed data contract;
- settings schema;
- loading/stale/offline/error states;
- reduced-motion behavior where animated;
- fixtures;
- tests;
- accessibility labels;
- performance classification;
- generic fallback behavior for unsupported data.
