# UI and Motion Specification

## 1. Visual direction

Artem Control Center should feel like a premium personal operating surface, not a generic admin template.

The normative visual hierarchy and anti-AI-slop checklist live in
`docs/DESIGN_DIRECTION.md` and apply to every visual review.

Core qualities:

- calm while idle;
- expressive while interacting;
- dense enough to be useful, never spreadsheet-like;
- tactile and responsive;
- visually coherent across Home, Services, Calendar, Tasks and Backups;
- readable from arm’s length on a desk;
- comfortable when held as a tablet;
- scalable through registered widgets rather than page-specific one-off components.

## 2. Design system

Use semantic tokens rather than hard-coded component colors:

```text
surface.canvas
surface.panel
surface.elevated
surface.interactive
text.primary
text.secondary
text.muted
status.success
status.warning
status.error
status.unknown
accent.primary
accent.secondary
shadow.soft
blur.panel
```

Status colors must never be the sole carrier of meaning.

## 3. Day theme

- clean light canvas;
- elevated cards with restrained depth;
- high legibility in daylight;
- richer accent moments around interactive elements;
- weather/home ambience may influence background subtly.

## 4. Night theme

- dark low-luminance canvas;
- no large pure-white surfaces;
- restrained glow;
- errors visible without flooding the room with red;
- lower motion amplitude in ambient mode;
- no white flash during startup/switch.

## 5. Theme switching

Inputs:

- sunrise/sunset for selected default weather location;
- optional HA preference;
- local time;
- manual override;
- system preference fallback.

Transition:

- animate semantic tokens over controlled duration;
- avoid flashing whole display;
- weather background/charts transition coherently;
- manual mode remains until reset or expiry.

## 6. Motion principles

Motion shows:

- where an element came from;
- what changed;
- whether a command/backup is pending;
- whether data is live or stale;
- whether a screen expands from a summary card;
- whether a newly onboarded service was materialized in UI.

Recommended starting ranges:

- press response: 80–140 ms;
- small state transition: 160–260 ms;
- page/shared-layout transition: 280–450 ms;
- ambient weather loops: slow/subtle;
- hold confirmation: 1.2–1.8 s depending on risk.

Use spring motion for press/release, card expansion, navigation selection and drag/snap. Avoid excessive bounce for incidents and safety controls.

## 7. Mandatory Coffee Machine Widget — P0 MVP

The coffee widget is mandatory in the first runnable build.

States:

- off;
- turning on;
- warming;
- ready;
- running;
- running too long;
- turning off;
- unavailable;
- stale;
- later Edge fallback where verified.

Motion:

- temperature/progress animated only from real or known-duration state;
- distinct stage transitions/colors, not arbitrary continuous gradient;
- restrained steam/heat visualization;
- ready transition rewarding but not game-like;
- warning motion persistent but not aggressively flashing;
- actions show request, execution and verification;
- duplicate `turn_on` cannot visually restart timer unless source actually changed;
- source freshness/authority available in detail.

Mac fixtures must cover every state. Windows validates touch feel/performance and real integration.

## 8. Other signature interactions

### Overview card → detail

Summary card expands using shared geometry rather than disappearing/recreating unrelated content.

### Service onboarding

After enable:

- Services catalog updates without full reload;
- new generic/specialized card enters designated `New items` area;
- placement animation does not move existing cards unexpectedly;
- visible result links to service detail.

### Service restart/deploy

- hold ring fills;
- card enters maintenance/executing state;
- timeline shows stages;
- status returns only after health verification;
- failure expands actionable diagnostics.

### Weather

- subtle ambient background tied to selected location conditions;
- precipitation/sun/cloud effects simplify in battery saver/reduced motion;
- no heavy permanent WebGL;
- switching locations preserves spatial continuity and never mixes cached values.

### Calendar

- timeline follows current time;
- event cards expand without losing position;
- source color remains secondary to readability.

### Tasks

- completion has short satisfying transition;
- undo interval where supported;
- no excessive celebration animation.

### Backup

- real stages only;
- local success + remote failure animates to `partial`, not success;
- destination/checksum state visible;
- no invented percentage when source cannot report one.

## 9. Touch requirements

- no hover-only actions;
- primary controls at least 56 CSS px high where space permits;
- edge gestures do not conflict with OS gestures;
- destructive controls stay away from grip zones;
- scrolling and horizontal swipes do not compete ambiguously;
- long press has visible progress/cancellation feedback.

## 10. Widget and layout motion

All widgets follow common mounting, resizing and state-transition primitives.

MVP:

- stable default positions;
- automatic new-item placement;
- optional show/hide/pin settings;
- generic fallback widget uses normal platform motion.

Post-MVP layout editor:

- drag starts from explicit handle or safe long-press mode;
- placeholder shows final grid position;
- collision resolution is visible and predictable;
- invalid size/position snaps back;
- touch and keyboard reordering supported;
- undo after layout change;
- drag does not trigger widget primary actions;
- existing cards never jump because a new service was added.

## 11. Ambient mode

After inactivity:

- navigation/controls reduce prominence;
- key information remains;
- animation frame rate/intensity may decrease;
- subtle layout movement may reduce static retention;
- touch restores control mode;
- active incident remains visible;
- coffee ready/long-running state remains visible.

## 12. Performance budget

Target device has 8 GB RAM and older low-power CPU.

Rules:

- one Chromium application surface;
- lazy-load heavy details/widgets;
- avoid permanent particle systems/video backgrounds;
- cap chart history;
- suspend hidden animations;
- use transforms/opacity where practical;
- measure FPS/memory/long tasks on target hardware;
- automatically reduce effects when performance drops;
- one failing/heavy widget must not degrade all dashboard updates.

## 13. Accessibility and degraded states

- support `prefers-reduced-motion`;
- keyboard access;
- readable focus rings;
- screen-reader labels;
- stale/offline/unknown distinct;
- skeletons never imply fresh data;
- last-known values carry timestamp;
- layout editor has non-drag alternative;
- widget errors show isolated fallback.

## 14. Animation Definition of Done

A screen/widget is not complete until:

- entrance/exit transitions coherent;
- state changes animated appropriately;
- pending/verification visible;
- reduced-motion behavior exists;
- animation remains acceptable on target hardware;
- no animation blocks urgent action;
- no fake progress;
- fixtures/screenshots work on Mac;
- hardware-specific behavior has Windows acceptance where required.
