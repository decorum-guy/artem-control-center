# Windows Production Runtime

## Purpose

The Samsung panel runs Artem Control Center as a local, supervised Windows application rather than a Vite/Uvicorn development session.

The production runtime:

- serves the built dashboard from Panel Agent on `127.0.0.1:8787`;
- runs Uvicorn without `--reload`;
- supervises the Panel Agent process and restarts it after bounded failures;
- opens Microsoft Edge with a dedicated kiosk profile;
- starts after Windows logon through Task Scheduler;
- respects an intentional full shutdown through a manual-stop marker;
- stores runtime configuration and logs outside Git;
- updates only from `main`, validates the new revision and rolls back automatically on failure.

The first installation may use fixture data for hardware acceptance. That is a production-grade host runtime with non-production data. Real integrations are enabled later by changing the local runtime configuration after their own acceptance work.

## Architecture

```text
Windows Task Scheduler
└── start-production.ps1 -AutoStart
    └── production-runtime.mjs
        ├── Panel Agent / Uvicorn, 127.0.0.1:8787
        │   ├── /api/*
        │   ├── /health/*
        │   └── built dashboard + SPA fallback
        ├── health watchdog and bounded restart budget
        ├── runtime command channel
        ├── state/log files
        └── panel-owned Edge kiosk lifecycle
```

The browser never submits arbitrary shell commands. Runtime control accepts only the existing allow-listed `hide` and `shutdown` actions.

## Local paths

Repository:

```text
C:\Users\ARTEM-PANEL\Projects\artem-control-center
```

Mutable runtime data:

```text
%LOCALAPPDATA%\ArtemControlCenter\
├── runtime.env
├── runtime-state.json
├── runtime-command.json       # transient
├── manual-stop.json           # exists only after intentional full stop
├── last-known-good.txt
├── rollback-head.txt
├── panel-state-cache.json
├── edge-profile\
└── logs\
```

No file under the mutable runtime directory is committed to Git.

## Install

From the clean `main` checkout on the Samsung:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-production.ps1
```

The installer:

1. stops the legacy fixture launcher if present;
2. runs repository setup and builds the dashboard;
3. creates a safe local `runtime.env` only when one does not exist;
4. applies Edge kiosk policies;
5. registers the `Artem Control Center Runtime` logon task;
6. creates production desktop shortcuts;
7. removes the old Test shortcuts;
8. starts the production runtime and verifies readiness.

Default first-install mode is `fixtures` with every deployment write gate disabled. An existing local configuration is never overwritten.

## Desktop shortcuts

- `Start Control Center.cmd` — explicitly clears the manual-stop marker, starts services and opens the kiosk.
- `Open Control Center.cmd` — opens only the kiosk; starts services first if required.
- `Stop Control Center.cmd` — closes the kiosk, stops services and creates a manual-stop marker.
- `Update Control Center.cmd` — performs a guarded update from `main` with automatic rollback.
- `Control Center Status.cmd` — shows runtime, health, kiosk, task, revision and log status.

Closing Edge with Alt+F4 or using `Скрыть панель` does not stop Panel Agent. Use `Open Control Center.cmd` to return to the panel.

## Autostart and manual stop

Task Scheduler starts the runtime after logon and restarts the task up to three times when it fails.

The Node supervisor separately restarts Panel Agent up to five times in a rolling ten-minute window. Three consecutive failed health probes also trigger an agent restart. Exhausting the restart budget exits with failure so Task Scheduler can retry the entire runtime.

An intentional full shutdown creates:

```text
%LOCALAPPDATA%\ArtemControlCenter\manual-stop.json
```

Autostart sees the marker and exits successfully, so it does not undo the user's explicit stop. `Start Control Center.cmd` removes the marker.

## Runtime configuration

Edit only:

```text
%LOCALAPPDATA%\ArtemControlCenter\runtime.env
```

The file uses strict `KEY=value` lines. Comments beginning with `#` are supported. Provider secrets remain in this local file and must never be copied into Git, logs, screenshots or issue comments.

Safe initial configuration:

```text
PANEL_AGENT_MODE=fixtures
PANEL_WRITES_ENABLED=false
PANEL_COFFEE_TIMING_WRITES_ENABLED=false
PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=false
PANEL_COFFEE_ACTIONS_ENABLED=false
```

Changing the file requires a runtime restart. Future runtime access profiles do not rewrite this file; deployment gates remain the maximum permissions.

## Update and automatic rollback

The update helper requires:

- current branch `main`;
- a clean working tree;
- fast-forward-only update from `origin/main`.

It performs:

```text
fetch main
→ stop runtime without manual marker
→ record previous commit
→ fast-forward
→ npm ci
→ setup Python dependencies
→ full read-only validation
→ production start and health check
→ record last-known-good commit
```

If any step fails after the previous commit is known, it automatically:

```text
stops partial runtime
→ git reset --hard <previous commit>
→ restores dependencies and build
→ starts the previous runtime
→ verifies health
```

Update transcripts are stored under:

```text
%LOCALAPPDATA%\ArtemControlCenter\logs\update-*.log
```

The updater never modifies `runtime.env`.

## Logs and state

Supervisor logs:

```text
%LOCALAPPDATA%\ArtemControlCenter\logs\runtime-YYYY-MM-DD.log
```

Runtime logs are retained for 14 days. They contain process lifecycle and sanitized application output, not configuration values.

Current state:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\status-production.ps1
```

Machine-readable output:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\status-production.ps1 -Json
```

## Removal and rollback to manual operation

Remove the scheduled task and production shortcuts while preserving configuration/logs:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-production.ps1
```

Also remove local runtime data only with explicit intent:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-production.ps1 -RemoveRuntimeData
```

The repository checkout is not deleted.

## Hardware acceptance boundary

CI validates Node/Python tests, builds, static serving and PowerShell parsing on Windows and Ubuntu. The Samsung must still prove:

- Task Scheduler registration under the actual Windows account;
- real Edge kiosk launch and dedicated profile behavior;
- touch and fullscreen behavior;
- logon/reboot autostart;
- recovery after an actual Panel Agent process kill;
- manual-stop persistence across a logon/reboot;
- update and rollback behavior on the real checkout.
