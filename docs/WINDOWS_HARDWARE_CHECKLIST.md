# Windows Hardware Acceptance Checklist

This checklist is intentionally separate from Mac development success.

## Working tree identity

Before handoff, record:

```text
git status --short --branch
git rev-parse HEAD
git diff --stat
```

An uncommitted handoff must include the exact diff archive or be converted to a
reviewed commit only after explicit user approval.

## Commands

In PowerShell from the repository root:

```text
npm run setup
npm run dev:fixtures
```

Open `http://127.0.0.1:5173` in Chrome/Chromium. Stop with `Ctrl+C`.

## Expected behavior

- visible `fixtures` badge;
- coffee specialized widget and generic service widgets;
- all fixture scenarios selectable;
- `alice-down-ha-healthy` leaves HA and coffee healthy;
- `+ Registry service` creates a Generic Service Widget automatically;
- day/night switch has no white flash;
- reduced-motion disables continuous steam animation;
- Settings explains layout reconciliation;
- simulated kiosk viewport remains usable.

## Touch steps

1. Tap fixture selector and choose coffee states.
2. Toggle day/night, reduced motion, kiosk viewport, and Settings.
3. Add a registry service.
4. Scroll the grid in landscape and portrait/tablet posture.
5. Confirm targets are comfortable and keyboard focus remains visible.

## Metrics to record

- first meaningful UI render;
- steady-state dashboard CPU and RAM;
- animation frame stability for `coffee-warming`;
- Panel Agent and Vite startup time;
- touch latency and missed taps;
- behavior after sleep/resume and Wi-Fi reconnect.

## Logs and failure capture

- browser DevTools Console and Network export;
- terminal output from the combined dev command;
- Playwright artifacts under `test-results/` and `playwright-report/`;
- screenshot and exact fixture scenario.

Do not include tokens, cookies, authorization headers, or private endpoint URLs.

## Rollback and stop

The fixture build has no production write integration. Stop both processes with
`Ctrl+C`. Remove only repository-local generated dependencies if explicitly
desired; never delete user changes. No OS service, kiosk autostart, firewall
rule, or hardware policy is installed by this checklist.
