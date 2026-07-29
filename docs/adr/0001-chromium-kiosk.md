# ADR 0001: Chromium kiosk as the primary UI runtime

- Status: Accepted
- Date: 2026-07-29

## Context

The project needs a highly animated touch-first interface that:

- runs fullscreen on the Samsung Notebook 9 Pro;
- starts on Windows and later moves to Linux;
- integrates with a local backend and remote services;
- can optionally be opened from another device;
- does not require separate native UI implementations per operating system.

## Decision

Use a React + TypeScript web application rendered by Chromium in kiosk mode.

The dashboard is served locally and does not depend on a public website or Internet connection for its own assets.

Privileged operations are executed by a separate local Panel Agent. Chromium is responsible only for rendering, interaction and calling the typed local API.

## Consequences

Positive:

- the same frontend runs on Windows, Linux and other browsers;
- modern CSS, SVG, Canvas and WebGL remain available;
- React motion/layout tooling can provide premium animation quality;
- development and preview are faster than a native OS-specific UI;
- backend integration uses ordinary HTTP/WebSocket contracts;
- the UI can later be packaged as PWA/Tauri without rewriting its core.

Trade-offs:

- browser sandbox cannot directly manage services, files, SSH or the OS;
- a Panel Agent is mandatory for privileged actions;
- Chromium resource usage must be measured on the 8 GB target laptop;
- kiosk supervision is required to restore the UI after a crash;
- touch/rotation behavior depends partly on the host OS.

## Rejected alternatives

### Custom operating system shell

Rejected as disproportionate complexity with little visual advantage.

### Fully native Windows application

Rejected because Linux migration would require a second UI implementation and development would be slower.

### Electron from day one

Rejected because it adds packaging and memory overhead before it provides a concrete benefit.

### Tauri from day one

Deferred. Tauri remains an option if native window/system integration becomes valuable after the Chromium kiosk implementation is proven.

## Review triggers

Review this decision only if:

- Chromium cannot deliver stable touch/kiosk behavior on the target OS;
- measured performance cannot meet the agreed UX after optimization;
- required native features cannot be safely provided by Panel Agent;
- packaging as Tauri materially improves reliability.
