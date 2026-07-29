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

Provide a development route/flag that:

- hides development chrome inside the app;
- uses the production viewport and layout constraints;
- simulates ambient/control/handheld mode;
- supports fullscreen where the browser allows it;
- does not lock the developer out of the Mac session.

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

The UI must visibly identify non-production mode.

## 6. Widget development workflow

A coded widget must be testable independently on Mac.

Codex workflow:

1. create widget package from template;
2. implement manifest, data contract and settings schema;
3. add deterministic fixtures;
4. run component tests;
5. run the widget in preview/gallery route;
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
