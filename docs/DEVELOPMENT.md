# Development and Cross-Platform Validation

## 1. Goal

The production host begins on Windows and may later move to Linux, but ordinary development must also work on the owner's Mac.

Codex/developers must be able to run, inspect and test the frontend and most Panel Agent behavior locally on macOS without access to the Samsung laptop for every code change.

The Mac mode is a development environment, not production acceptance for touch, kiosk, power, BlueStacks/Waydroid or target-device performance.

## 2. Supported development hosts

### macOS — primary developer convenience mode

Supported for:

- React UI development;
- ordinary Chrome/Chromium rendering;
- Panel Agent development mode;
- fixtures and simulated integrations;
- read-only real integrations using dedicated development credentials;
- Playwright Chromium tests;
- screenshots and visual regression;
- accessibility tests;
- responsive landscape/handheld layouts;
- widget manifests and registry reconciliation;
- settings and layout editing;
- command lifecycle simulation;
- backup lifecycle simulation with temporary directories.

Not accepted as proof of:

- Samsung touchscreen behavior;
- actual Windows kiosk autostart/recovery;
- lid/power behavior;
- BlueStacks loyalty app;
- Windows service/privileged helper;
- thermal and RAM behavior on the target laptop;
- Linux/Waydroid compatibility.

### Windows — first production and hardware acceptance host

Required for:

- real Chromium kiosk flags and startup;
- Windows service/scheduled startup;
- touchscreen and tablet posture;
- power/lid settings;
- BlueStacks and loyalty application;
- AnyDesk recovery;
- target performance, RAM, thermal and power measurements;
- Windows Firewall/Defender/security acceptance;
- real local OS actions.

### Linux — future target validation

Required later for:

- systemd units/sandboxing;
- Wayland/touch/rotation;
- Waydroid loyalty app;
- suspend/resume/lid behavior;
- firewall and encryption;
- long-running kiosk recovery.

## 3. One-command development goal

The repository should expose cross-platform commands with no Bash-only dependency for normal development.

Target commands:

```text
npm run dev
npm run dev:fixtures
npm run dev:mac
npm run test
npm run test:e2e
npm run test:visual
npm run build
```

Recommended behavior:

- a Node orchestration script starts Vite and Panel Agent;
- Python environment setup is documented and validated;
- `dev:mac` opens the dashboard in normal Chromium/Chrome application mode, not locked kiosk;
- browser URL remains local;
- fixtures are clearly marked;
- production build cannot accidentally enable fixtures;
- commands work from macOS and Windows terminals.

Actual command names may change during bootstrap, but equivalent one-command workflows are required.

### Implemented bootstrap

From the repository root:

```text
npm run setup
npm run dev:mac
```

`setup` installs repository-local Node dependencies and creates a
repository-local `.venv`. Install the Playwright-managed Chromium cache once
with `npm run install:browsers`. `dev:mac` starts both processes and opens a
normal browser window. Other implemented modes:

```text
npm run dev:fixtures
npm run dev:read-only
npm run check
npm run test:e2e
```

Both servers bind loopback only. The fixture mutation route exists only in
`fixtures` and `integration_test`; it returns 404 in `read_only` and
`production`. No real remote action executor exists in the foundation.

### Cache and non-source artifact policy

Source and project artifacts are writable only inside `artem-control-center`.
Tool caches and non-source installation artifacts may use the designated parent
workspace or standard tool cache directories. External project folders remain
strictly read-only.

Preference order:

1. project-local ignored cache;
2. parent workspace `.cache/`, `.tooling/`, `.tmp/`, or `artifacts/`;
3. standard tool cache when redirection adds fragility, such as Playwright
   browser binaries.

Never put caches, downloaded binaries, lockfiles, or dependencies inside the
Home Assistant or AVALAR folders. Cache contents must not contain secrets and
must not be committed.

## 4. Browser modes

### Development window

On Mac, open the dashboard in an ordinary browser window with DevTools available.

Uses:

- fast reload;
- responsive viewport testing;
- console/network inspection;
- screenshots;
- component development;
- keyboard navigation.

### Simulated kiosk

Use `/dev/widget-gallery` for the simulated kiosk flag. The route:

- is available only in development builds;
- uses the production viewport and layout constraints;
- simulates ambient/control/handheld mode;
- supports fullscreen where the browser allows it;
- does not lock the developer out of the Mac session.

Normal product routes never show fixture selection, registry mutation, contract
labels, motion diagnostics, or kiosk controls.

### Production kiosk

Production kiosk launchers are OS-specific and live under deployment packages. Their correctness is verified on Windows/Linux, not inferred from macOS.

## 5. Panel Agent development modes

Panel Agent supports explicit modes:

- `fixtures` — deterministic local data, no real remote writes;
- `read_only` — optional real reads, all write actions disabled;
- `integration_test` — sandbox/test services only;
- `production` — real policies and secrets, unavailable by accidental development default.

On macOS:

- local privileged Windows/Linux operations are unavailable or simulated;
- remote actions are disabled by default;
- secrets use development-only references;
- production tokens are not required for UI work;
- fixtures cover healthy, degraded, stale, offline, incident and action lifecycle states.

Read-only integration environment variables are inherited by `npm run
dev:read-only`:

```text
PANEL_HA_URL
PANEL_HA_TOKEN
PANEL_HA_STALE_AFTER_SECONDS
PANEL_STATE_CACHE_PATH
PANEL_ALICE_HEALTH_URL
PANEL_ALICE_DETAILS_TOKEN
PANEL_ALICE_BASE_URL
PANEL_ALICE_CONTROL_CENTER_TOKEN
PANEL_AVALAR_MAIN_URL
PANEL_AVALAR_STAGE_URL
PANEL_HTTP_REFRESH_SECONDS
PANEL_HTTP_REQUEST_TIMEOUT_SECONDS
PANEL_INTEGRATION_STALE_AFTER_SECONDS
PANEL_INTEGRATION_UNAVAILABLE_AFTER_SECONDS
PANEL_AVALAR_SSH_ENABLED
PANEL_AVALAR_SSH_HOST
PANEL_AVALAR_SSH_STATUS_COMMAND
PANEL_AVALAR_SSH_REFRESH_SECONDS
PANEL_AVALAR_SSH_TIMEOUT_SECONDS
PANEL_AVALAR_SSH_OUTPUT_LIMIT_BYTES
PANEL_WRITES_ENABLED
PANEL_COFFEE_TIMING_WRITES_ENABLED
PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED
PANEL_COFFEE_ACTIONS_ENABLED
PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED
PANEL_OVERVIEW_LAYOUT_PATH
PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED
PANEL_CALENDAR_DISPLAY_COLOR_PATH
PANEL_SSE_HEARTBEAT_SECONDS
```

AVALAR public health is polled every 20–30 seconds by short HTTP requests.
Optional sanitized deployment details use fixed SSH operations on a slower
default cadence of 180 seconds. No shared-hosting daemon or PHP environment
metadata is required. OpenSSH host-key verification remains enabled.

Set `PANEL_STATE_CACHE_PATH` to an ignored project path or the parent workspace
`.cache/`; the adapter stores only allow-listed HA state fields and never a
token. `PANEL_WRITES_ENABLED` and all three narrow coffee gates default to
false. Coffee mutation endpoints exist but reject requests until both the
global and matching narrow gate are enabled. Fixtures are never merged into a
read-only snapshot.

The dashboard obtains its initial state from `/api/v1/snapshot`, listens for
revision hints on `/api/v1/events`, and always reconciles through another full
snapshot GET. SSE is non-durable; fallback polling and visibility restore make
missed events safe.

Calendar display colours are Panel-owned preferences, not provider mutations.
`PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED=false` remains subject to the
global `PANEL_WRITES_ENABLED` gate and the standard owner access capability.
The default development document is `.cache/calendar-display-colors.json`.
The Windows production runtime injects a durable default under
`%LOCALAPPDATA%\\ArtemControlCenter\\calendar-display-colors.json`, so ordinary
source updates do not replace it. The bounded file contains only safe
provider/calendar identity pairs and canonical `#RRGGBB` colours.

The development gallery visibly identifies non-production mode. Ordinary user
routes do not expose development mode or fixture controls.

Overview V2 layout reads are available independently of editing. The editor is
opt-in with `VITE_OVERVIEW_EDITOR_ENABLED=false`; persistence is separately
gated by `PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED=false` and the global
`PANEL_WRITES_ENABLED` gate. `PANEL_OVERVIEW_LAYOUT_PATH` defaults to
`.cache/overview-layout.json`. The Panel Agent owns the bounded canonical
document, ETag/If-Match checks and atomic replacement. Corrupt or legacy data
is recovered in memory without rewriting the file; use an explicit `Готово` or
reset save to persist a new document. The config-only backup profile for this
file is documented in `config/backups.example.yaml`; no generic backup engine
is implied by the example.

## 6. Widget development workflow

A coded widget must be testable independently on Mac.

Codex workflow:

1. create widget package from template;
2. implement manifest, data contract and settings schema;
3. add deterministic fixtures;
4. run component tests;
5. run the widget at `/dev/widget-gallery`;
6. test day/night, ambient/control/handheld and reduced-motion;
7. test loading/stale/offline/error states;
8. run Playwright screenshot checks;
9. test integration through Widget Resolver and automatic layout reconciliation;
10. only then request target Windows validation when hardware-specific behavior matters.

A widget may not require a live production service merely to render its states.

## 7. Coffee widget development fixtures

Mandatory fixtures:

- off;
- turning on;
- warming at early/middle/late progress;
- ready;
- running;
- running too long;
- turning off;
- unavailable;
- stale;
- action requested/accepted/executing/verifying/success/failed;
- reduced-motion;
- narrow/handheld layout.

Mac development must be sufficient to validate its visual behavior and animations. Final touch feel, performance and real-state integration are validated on Windows.

## 8. Playwright and visual testing

Use Playwright Chromium for:

- navigation;
- registry update → automatic service appearance;
- generic fallback widget;
- specialized widget resolution;
- settings enable/disable;
- weather location switcher;
- coffee widget states;
- day/night switching without white flash;
- backup/action lifecycle;
- layout reconciliation;
- accessibility smoke;
- screenshots at target viewport sizes.

Store baseline screenshots only when the project adopts an explicit visual-regression workflow. Avoid approving broad screenshot changes without inspection.

For an explicit local review pass while the fixture server is running:

```bash
npm run visual:review
```

The command writes review-only screenshots to the parent workspace
`artifacts/ui-review/`; they are not source artifacts and must not enter Git.

## 9. Target-device handoff checklist

After Mac tests pass, hardware-dependent changes produce a concise checklist for the owner to run on Windows.

The checklist must state:

- exact branch/commit;
- exact start command or installer;
- expected screen/state;
- touch interactions to test;
- performance values to observe;
- log/export path if failure occurs;
- whether the test is destructive;
- rollback/stop procedure.

Codex should not describe a Mac-only success as target-device acceptance.

## 10. Platform abstraction

OS-specific operations go through interfaces:

```text
SystemAdapter
├── WindowsSystemAdapter
├── LinuxSystemAdapter
└── DevelopmentSystemAdapter
```

Examples:

- launch/close kiosk;
- open Desktop mode;
- reboot/shutdown;
- battery/power telemetry;
- mount/unmount external drive;
- service status/restart;
- app launcher.

Frontend uses normalized API contracts and contains no OS branching for privileged behavior.

## 11. Configuration and settings development

Settings UI works locally with a temporary development database/config root.

Required:

- add/disable project;
- automatic widget materialization;
- show/hide/pin widget;
- edit safe widget settings;
- manage weather locations;
- preview layouts;
- export config without secrets;
- reset development state;
- schema migration tests.

Development settings must never mutate production configuration unless a separate explicit import/export step is used.

## 12. Definition of Done

A frontend/Panel Agent feature is development-complete when:

- it runs on macOS in development mode;
- lint/type/unit tests pass;
- relevant Playwright tests pass;
- fixtures cover non-happy states;
- secrets are absent;
- production-only actions remain disabled locally by default;
- hardware-dependent validation is explicitly marked pending or completed on Windows;
- documentation and configuration schemas are updated.
