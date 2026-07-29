# Artem Control Center Design Direction

## Product character

Artem Control Center is an operational surface, not an AI dashboard, landing
page, or visual concept. Beauty comes from hierarchy, typography, proportion,
state clarity, and specialized interactions. Decoration never competes with
device status or controls.

## User interface architecture

The product and development surfaces are intentionally separate:

- `/overview` answers what is happening now: coffee first, then calendar/tasks
  availability, attention items, home quick controls, aggregate services, and
  backup freshness.
- `/home` presents user devices and scenes. Home Assistant is a small
  infrastructure indicator rather than a device card. AliceTG Bot is not a
  home device.
- `/services` is a dense registry-driven catalog grouped into AVALAR, Home
  infrastructure, Personal infrastructure, System, and External services.
- `/calendar`, `/tasks`, `/backups`, `/apps`, `/settings`, and `/system` use
  the same product shell. Until their data contracts exist, they show explicit
  product-level unavailable states rather than invented data.
- `/dev/widget-gallery` retains fixture selection, technical labels, registry
  mutation, kiosk simulation, and motion/theme controls. It is disabled in a
  production build.

The navigation shell uses one compact touch rail. At narrow widths the same
rail becomes a horizontally scrollable primary navigation; it is not a second
navigation system.

## Registry-driven presentation

`ServicePresentation` carries category, group, overview placement, priority,
environment, freshness, latency, incidents, and optional semantic role.
Overview and Services select and order services from these fields and widget
manifests. Unknown enabled services still materialize through
`core.generic-service` and default into the System group instead of requiring a
frontend service-ID list.

The coffee manifest owns its visual asset contract:

```ts
visualAsset: {
  type: "image",
  sourcePath: "./assets/widgets/coffee-machine.png",
  fit: "contain",
  alt: "Кофемашина"
}
```

The supplied transparent PNG belongs at
`apps/dashboard/src/assets/widgets/coffee-machine.png`. Vite discovers the
asset without a component edit. The widget reserves a stable image area, keeps
aspect ratio, constrains the maximum size, and falls back to the neutral text
“Иллюстрация кофемашины” when the file is missing or fails to load. State,
progress, warning, and activity layers remain independent from the image.

## Design principles

1. **State first.** Current state, freshness, authority, and incidents dominate
   visual priority.
2. **Calm by default.** Idle screens are stable. Motion is reserved for state
   transitions, progress, command verification, and newly materialized items.
3. **Dense enough to act.** Use space for useful secondary context rather than
   oversized headlines or empty hero areas.
4. **One system, different domains.** Home, Services, Weather, Calendar, and
   Backups may use domain-specific widgets but share tokens, spacing, type, and
   interaction rules.
5. **Progressive detail.** Overview shows decisions; details reveal history,
   diagnostics, and lower-frequency settings.
6. **No fake data.** Decorative charts, fake metrics, guessed progress, and
   ambiguous status marks are forbidden.

## Visual hierarchy

- Level 1: incidents, active device state, pending/verifying actions.
- Level 2: primary widget title, status, essential value, and freshness.
- Level 3: authority, entity/source, policy revision, timestamps, and actions.
- Level 4: diagnostics and configuration in details/Settings.

Page titles orient the user; they are not marketing headlines. The coffee
widget is the signature operational surface. Calendar/tasks context uses a
compact adjoining column, home controls use inline rows, and generic services
use dense catalog rows rather than a repeated card grid.

## Typography

- Prefer the system UI stack for predictable Chromium/Windows rendering.
- Use no more than four functional sizes per screen: page, widget title,
  primary value, supporting text.
- Use weight and spacing before introducing more colors.
- Uppercase/letter-spaced labels are reserved for short metadata.
- Avoid giant headings when the page contains little useful information.
- Numbers, timestamps, and state labels must remain readable at arm’s length.

## Grid and layout

- Use a 12-column landscape grid and intentional spans.
- Align widget headers, state baselines, and footer metadata.
- Primary Home widgets may span more columns; generic services remain compact.
- New registry items enter Services/New items without moving existing widgets.
- Cards group one operational subject. Do not turn every label or control group
  into another floating card.
- Corner radii are restrained and consistent; elevation is subtle.

## Day and night character

Day uses a quiet warm-neutral canvas, high-contrast dark text, and solid light
surfaces. Night uses a low-luminance neutral canvas and solid dark surfaces.
Status color is semantic and always paired with text.

Neither theme uses decorative gradient blobs, purple/blue AI gradients,
per-card glow, or heavy glass blur. Domain ambience may appear only when backed
by real data and kept subordinate to state.

## Touch principles

- Navigation and frequent controls are at least 48 CSS pixels.
- Destructive/high-risk actions require the documented confirmation gesture.
- Controls expose visible focus and pressed/disabled states.
- Related controls stay spatially close to the state they affect.
- Do not hide essential actions behind hover.
- Handheld mode avoids placing critical controls in grip zones.

## Motion principles

- Animate cause and effect: state change, progress, verification, expansion,
  reconciliation.
- Only the affected component moves.
- Continuous animation is exceptional: restrained coffee steam while warming
  is acceptable; ambient motion on every card is not.
- Warnings remain visible without flashing.
- Reduced-motion keeps all state information and collapses non-essential
  duration.
- Entry animation must not make the whole grid float simultaneously.

## Anti-slop checklist

Reject a change when it introduces:

- decorative gradient blobs or arbitrary violet/blue gradients;
- glass blur as the default surface;
- glow/shadow around every card;
- identical oversized rounded cards for unrelated information;
- pill-shaped treatment for ordinary rectangular controls;
- hero slogans or giant headlines replacing navigation/context;
- decorative charts, fake metrics, sparkles, or “magic” icons;
- floating cards without a clear grid hierarchy;
- animation on unrelated elements at the same time;
- excessive whitespace that hides information density;
- a SaaS landing-page composition instead of an operational UI.

Functional exceptions must be explained in the component contract.

## Visual review checklist

1. Can state, health, and freshness be read from arm’s length?
2. Is every number backed by a real contract or explicit fixture?
3. Does hierarchy still work in day/night and at 1366×768?
4. Are touch targets and keyboard focus obvious?
5. Does bot-policy degradation leave HA device state understandable?
6. Does motion explain a transition, and is reduced-motion equivalent?
7. Did a generic service remain compact and use the shared grid?
8. Is any gradient, blur, glow, large radius, or icon merely decorative?
9. Could this screen be mistaken for an AI-generated SaaS landing page?
10. Does one failing widget remain visually isolated?

## Too decorative or too templated

Too decorative:

- a full-screen colorful radial background behind health cards;
- glowing coffee card with steam, particles, and pulsing progress at once;
- animated graphs with no operational values.

Too templated:

- six identical 28px-radius glass cards with title, fake metric, and sparkline;
- a large inspirational headline above three sparse cards;
- every action rendered as the same pill regardless of risk.

Acceptable:

- a solid canvas, compact service rows, one larger coffee widget;
- restrained steam only during verified warming;
- clear state/policy provenance in secondary metadata;
- a long-running border/status treatment with no claim of physical overheating.

## Implemented surface and state tokens

- Surfaces: canvas, navigation rail, primary, secondary, inline/interactive,
  alert, and detail/placeholder.
- Borders: soft section divider, standard control border, semantic alert edge,
  and dashed unavailable/stale treatment.
- Radii: `8px` controls, `12px` sections, and `18px` only for the primary
  coffee surface.
- Semantic colors: success, warning, danger, stale, focus, and product accent;
  every status is also expressed in text.
- Interaction: visible keyboard focus, pressed displacement, disabled opacity,
  48px frequent targets, and no essential hover-only behavior.
- Motion: full, reduced, low-performance, and battery-saving classes plus
  `prefers-reduced-motion`. Only coffee warming activity and progress/state
  transitions animate.
