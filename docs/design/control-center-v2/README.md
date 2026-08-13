# Artem Control Center V2 design handoff

This directory is a design-only implementation handoff. Nothing under it is
imported by the dashboard, Panel Agent, or production build.

- [`DESIGN_SPEC.md`](DESIGN_SPEC.md) is the normative visual and interaction
  specification.
- [`prototype/`](prototype/) is an isolated static prototype for visual review.
- [`screenshots/`](screenshots/) contains canonical 1280×720 PNG renders made
  from a 1280×720 CSS viewport with Chromium at device scale factor 1.5.

The prototype uses synthetic display content only. Its buttons demonstrate
visual states and do not call a backend, execute an action, or persist data.

## Review the prototype

Open `prototype/index.html` directly, or serve this directory with any static
file server. Select a view through the `view` query parameter:

```text
overview-night
overview-day
overview-edit
weather-clear-day
weather-rain-night
services-degraded
settings
planning
```

## Render the canonical screenshots

From the repository root:

```bash
node docs/design/control-center-v2/prototype/render-screenshots.mjs
```

The render script uses the repository's existing Playwright dependency. It
does not add a package, change `package.json`, or start the production app.
