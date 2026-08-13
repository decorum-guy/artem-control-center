# Artem Control Center V2 design specification

Status: **normative implementation handoff**

Canonical viewport: **1280×720 CSS px, deviceScaleFactor 1.5, touch**

Character: **calm technical**

This document resolves the visual and interaction decisions needed to
implement the V2 shell, customizable Overview, shared primitives, Weather and
route-density pass. It does not authorize B4 mutations, provider writes, new
execution surfaces, or changes to canonical Planning semantics.

## A. Visual thesis

Artem Control Center V2 is a quiet instrument panel. Information is organized
by operational subject, not by a grid of interchangeable cards. A work zone
has one solid surface; related values and actions are separated by alignment
and dividers inside that surface. State, freshness and the next safe action are
visible before provenance or explanation.

The product uses:

- a low-luminance graphite/mineral night theme and warm-mineral day theme;
- two surface elevations only: work zone and raised interactive/selected;
- restrained amber product accent;
- semantic color paired with text, never color alone;
- system UI typography optimized for Windows Chromium;
- real 20 px line icons, or text-first controls where an icon adds no meaning;
- no decorative glass, per-card glow, letter-avatar icons, fake metrics, or
  unrelated ambient animation.

## B. Exact design tokens

### B1. CSS variables

Use these names as the production token contract. Components must not invent
local neutral colors. Domain illustrations may derive colors with `color-mix`
only from these tokens.

```css
.theme-night {
  --cc-canvas: #0d1213;
  --cc-rail: #111819;
  --cc-surface-1: #171e1f;
  --cc-surface-2: #1e2728;
  --cc-interactive: #253031;
  --cc-hover: #2a3637;
  --cc-pressed: #202a2b;
  --cc-border: #344142;
  --cc-divider: #283334;
  --cc-selected-bg: #30281e;
  --cc-selected-border: #8a693f;

  --cc-text: #f0f4f1;
  --cc-text-secondary: #bbc5c1;
  --cc-text-muted: #8d9a95;
  --cc-text-disabled: #68736f;

  --cc-accent: #d6a45f;
  --cc-accent-strong: #e5b66f;
  --cc-on-accent: #17130e;
  --cc-focus: #f0c57c;

  --cc-success: #72c9a1;
  --cc-success-bg: #173129;
  --cc-success-border: #326c55;
  --cc-warning: #e1aa63;
  --cc-warning-bg: #34271b;
  --cc-warning-border: #765432;
  --cc-danger: #e37e76;
  --cc-danger-bg: #3b2322;
  --cc-danger-border: #87433f;
  --cc-stale: #c6a06d;
  --cc-stale-bg: #30291f;
  --cc-stale-border: #6f5a3b;
  --cc-offline: #a7b0ad;
  --cc-offline-bg: #242a2a;
  --cc-offline-border: #505b58;
  --cc-unavailable: #9a8e85;
  --cc-unavailable-bg: #292523;
  --cc-unavailable-border: #5b5049;
  --cc-uncertain: #9fb4c8;
  --cc-uncertain-bg: #202b33;
  --cc-uncertain-border: #536979;

  --cc-overlay: rgb(4 8 9 / 68%);
  --cc-shadow-overlay: 0 20px 56px rgb(0 0 0 / 42%);
}

.theme-day {
  --cc-canvas: #e8e9e4;
  --cc-rail: #dfe2dc;
  --cc-surface-1: #f7f6f1;
  --cc-surface-2: #eff0eb;
  --cc-interactive: #e5e8e2;
  --cc-hover: #dfe3dc;
  --cc-pressed: #d8ddd6;
  --cc-border: #c4cac3;
  --cc-divider: #d7dbd5;
  --cc-selected-bg: #eee1cd;
  --cc-selected-border: #a77a43;

  --cc-text: #1b2927;
  --cc-text-secondary: #4d5e5a;
  --cc-text-muted: #6d7c78;
  --cc-text-disabled: #939d99;

  --cc-accent: #8b5b24;
  --cc-accent-strong: #744716;
  --cc-on-accent: #fffaf2;
  --cc-focus: #774a16;

  --cc-success: #2e7658;
  --cc-success-bg: #dcebe3;
  --cc-success-border: #8cb8a2;
  --cc-warning: #8e5b1e;
  --cc-warning-bg: #f1e3cf;
  --cc-warning-border: #c9a270;
  --cc-danger: #a74842;
  --cc-danger-bg: #f0ddda;
  --cc-danger-border: #ce928d;
  --cc-stale: #7d603a;
  --cc-stale-bg: #ece3d6;
  --cc-stale-border: #bea580;
  --cc-offline: #53615d;
  --cc-offline-bg: #e1e4e0;
  --cc-offline-border: #a9b1ad;
  --cc-unavailable: #70665f;
  --cc-unavailable-bg: #e7e1dc;
  --cc-unavailable-border: #b8aaa0;
  --cc-uncertain: #3f647f;
  --cc-uncertain-bg: #dce6ed;
  --cc-uncertain-border: #91aabd;

  --cc-overlay: rgb(30 38 36 / 48%);
  --cc-shadow-overlay: 0 20px 56px rgb(32 40 38 / 24%);
}
```

### B2. Interaction states

| State | Treatment |
|---|---|
| Default control | `--cc-interactive`, 1 px `--cc-border`, text `--cc-text` |
| Hover | `--cc-hover`; optional enhancement only |
| Pressed | `--cc-pressed`, translateY(1px), 80 ms; state must also read from pointer/keyboard |
| Selected | `--cc-selected-bg`, `--cc-selected-border`, accent icon/text |
| Focus | 3 px `--cc-focus` outline, 2 px offset; never clipped |
| Disabled | surface remains visible; text/icon `--cc-text-disabled`; no opacity below 0.62 for the whole control |
| Loading | stable reserved geometry; skeleton uses surface-2/divider without shimmer in reduced/low/battery modes |

Success, warning, danger, stale, offline, unavailable and uncertain use their
three-token foreground/background/border sets. Every semantic treatment
contains a visible Russian state label. `uncertain` is reserved for an action
whose result cannot yet be proven; it is not a synonym for offline.

### B3. Typography

Font stack:

```css
font-family: "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif;
```

| Role | Size / line | Weight | Notes |
|---|---:|---:|---|
| Display/time | 28 / 32 | 700 | tabular numerals |
| Weather temperature | 68 / 68 | 680 | Weather hero only |
| Page title | 26 / 32 | 700 | one line at canonical viewport |
| Section title | 21 / 28 | 680 | route work zones |
| Widget title | 17 / 22 | 680 | never uppercase |
| Primary widget state | 26 / 30 | 700 | Coffee and exceptional device states |
| Body | 14 / 20 | 450 | default explanatory text |
| Control | 14 / 20 | 650 | buttons, tabs, nav |
| Metadata | 13 / 18 | 500 | minimum arm's-length size |
| Short section label | 12 / 16 | 700 | uppercase allowed only for ≤18 characters |

Russian labels may wrap to two lines. Essential status/action labels may not be
ellipsized. Long object titles clamp only in compact summaries and are fully
available in their details sheet.

### B4. Spacing, shape and elevation

```css
--cc-space-1: 4px;
--cc-space-2: 8px;
--cc-space-3: 12px;
--cc-space-4: 16px;
--cc-space-5: 20px;
--cc-space-6: 24px;
--cc-space-7: 32px;
--cc-space-8: 40px;
--cc-space-9: 48px;

--cc-radius-control: 8px;
--cc-radius-surface: 10px;
--cc-radius-zone: 12px;
--cc-radius-sheet: 16px;
```

- Normal work zones have no shadow.
- Raised edit items may use `0 8px 24px rgb(0 0 0 / 18%)`.
- Only sheets, dialogs and notices use `--cc-shadow-overlay`.
- Dividers are 1 px `--cc-divider`; outer work-zone borders are 1 px
  `--cc-border`.
- Controls are rectangular with an 8 px radius, not pills.

Icon families:

- 20 px / 1.75 px stroke: rail and normal controls;
- 18 px / 1.75 px stroke: inline state/action detail;
- 24 px / 1.75 px stroke: empty/error state;
- 32 px / 1.5 px stroke: Weather condition glyphs only.

Use one coherent rounded-line SVG set. Icons have `aria-hidden=true` when a
visible label exists. Icon-only controls require an accessible name and 48×48
target.

### B5. Motion

| Motion | Duration | Easing |
|---|---:|---|
| Press feedback | 80–120 ms | `ease-out` |
| Hover/focus color | 160 ms | `ease-out` |
| Status/content reconciliation | 220 ms | `cubic-bezier(.2,.8,.2,1)` |
| Expand/collapse | 240 ms | same |
| Sheet/dialog | 280 ms | `cubic-bezier(.2,.8,.2,1)` |
| Dashboard reflow in Edit | 220 ms | same |
| Cloud ambience | 48–72 s | linear seamless track |
| Fog ambience | 40–64 s | linear seamless track |
| Rain tile | 1.4–2.2 s | linear tile-exact loop |
| Snow near/far planes | 12 s / 19 s | linear tile-exact loops |

Reduced motion collapses nonessential duration to zero and keeps state-change
crossfades at no more than 80 ms. Low-performance and battery-saving have no
continuous ambience. Decorative animation pauses when `document.hidden`.

## C. Shell and navigation

### C1. Canonical geometry

- Rail: fixed/sticky `176×720` at `x=0`.
- Header: `1104×64` at `x=176, y=0`.
- Workspace: `1104×656` at `x=176, y=64`.
- Route padding: 20 px at canonical viewport.
- Maximum route width: none below 1440; above 1440 cap content at 1440 and
  center it inside workspace.
- Rail divider: 1 px on the right; header divider: 1 px at bottom.

At 200% zoom / effective 640×360, rail becomes a 64 px top product bar plus a
48 px horizontally scrollable route bar. This is the same navigation model,
not a separate hamburger hierarchy. Document horizontal overflow is forbidden.

### C2. Rail anatomy

```text
20,18  ACC mark + “Control Center”                         h44
12,76  Overview                                           h48
        Weather                                           h48
        Home                                              h48
        Services                                          h48
20      PLANNING short group label                        h28
        Calendar                                          h48
        Tasks                                             h48
        Reminders                                         h48
        flexible empty space
        divider
        System                                            h48
        Settings                                          h48
```

Backups and Apps are absent from primary navigation while unfinished. Backup
health remains in Overview/Services/System. Routes remain directly addressable
when useful, but placeholders do not compete with operational routes.

Each route has a 20 px line icon. Planning children are indented 12 px and
connected by a quiet 1 px vertical group rule. Active route uses selected
surface + a 3 px accent bar at the rail edge. Do not use letter initials.

### C3. Header anatomy

- Left, `x=196`: current time `28/32`; date follows at 13/18.
- Right cluster, gap 8:
  - Weather summary, min-width 180, 48 high, opens Weather;
  - system state, 160–190 wide, 48 high, opens System;
  - access state, 48 high and width based on text, opens access sheet;
  - Settings icon-only button, 48×48.
- If horizontal space tightens, date shortens before status labels do.
- Status/access surfaces never host transient notices.

## D. Customizable Overview

### D1. Normal mode

Normal mode is inert with respect to layout. Long-pressing, swiping or dragging
a widget never reorders it. Widget actions remain active. A 48 px secondary
button `Настроить` in the page toolbar is the only entry to Edit mode.

The curated preset uses a 12-column grid:

```css
grid-template-columns: repeat(12, minmax(0, 1fr));
grid-auto-rows: 60px;
gap: 12px;
```

At 1064 px content width, each column is approximately 77.67 px. Grid items
snap to whole columns and rows. No free placement, pixel coordinates, overlap,
rotation or z-index customization is allowed.

### D2. Constraints

- canonical gap: 12 px; route padding: 12 px top, 20 px horizontal/bottom;
- minimum generic widget: 3 columns × 1 row;
- default operational widget minimum: 4 columns × 2 rows;
- maximum: 12 columns × 8 rows;
- resize increment: one column or one 60 px row;
- manifest declares `minW/minH/maxW/maxH` and supported named size variants;
- no item may leave columns `0..11` or have a negative row;
- widgets never overlap after commit;
- compact order is top-to-bottom, then left-to-right;
- one widget failure renders inside its own rectangle and never changes layout.

Breakpoints:

| Workspace width | Grid | Rule |
|---:|---:|---|
| ≥960 px | 12 columns, 60 px rows, 12 px gap | canonical landscape |
| 720–959 px | 8 columns, 64 px rows, 12 px gap | placement derived from 12-col order |
| <720 px | 4 columns, auto-height rows, 10 px gap | one/two-column stacking; editing uses move controls rather than free drag |

Only the 12-column canonical profile is directly persisted. Responsive layouts
are deterministic projections unless a later named-layout decision explicitly
adds independent profiles.

### D3. Edit mode

Entry:

1. Tap `Настроить`.
2. Widget actions become inert immediately.
3. The page toolbar changes to the 56 px Edit toolbar.
4. A visible grid and widget handles appear. A text label announces
   `Редактирование панели`.

Toolbar, left to right:

- `Добавить виджет` — primary, 56 high;
- `Сбросить` — secondary, 48 high;
- unsaved state text, flexible;
- `Отмена` — 48 high;
- `Готово` — primary, 56 high.

Every edit widget has:

- a 48×48 drag handle at top-left, only grip that begins drag;
- 48×48 remove control at top-right;
- 48×48 resize handle at bottom-right when resize is supported;
- a text size label such as `7 × 4` near the resize handle;
- a context menu with accessible `Вверх / Вниз / Влево / Вправо / Размер`
  alternatives for keyboard and non-drag touch operation.

Drag starts immediately from the explicit handle. Normal widget body cannot
drag. The dragged item remains under the pointer; a dashed ghost shows the
candidate cell. Collisions use **push-down only**: colliding widgets retain
their x/width and move to the first free lower row in stable order. No lateral
shuffle occurs. If the proposed item cannot satisfy its bounds, the ghost turns
danger-colored, drop returns the item to origin, and an aria-live message
explains the reason.

Resize anchors the top-left cell and changes by whole grid units. Collisions use
the same push-down preview. Removing a widget hides its instance; it does not
disable its service or delete history/configuration.

`Отмена` restores the entry snapshot without a server write. `Готово` validates
the complete draft and performs one revision-checked save. While saving, all
handles disable and button copy becomes `Сохраняем…`. A transport timeout is
`uncertain`; Edit mode stays open until read-back proves the canonical layout.

`Сбросить` requires a normal confirmation dialog, replaces the draft with the
current shipped preset version, and remains unsaved until `Готово`.

### D4. Widget picker

Open as the shared right sheet, 560 px wide at canonical viewport. Header is
sticky. Content groups registered widget definitions into:

- Управление;
- Планирование;
- Дом;
- Состояние;
- Контекст.

Each 72 px row has 24 px icon, title, one-line description, supported size
label, and a 48 px `Добавить` control. Already visible singleton widgets show
`Добавлен` disabled. Search appears only when registry has more than 12
available definitions. It searches local registry metadata; it cannot accept a
URL, endpoint, HTML, JavaScript, action ID or data binding.

New widgets use deterministic row-major first-fit. If no safe gap exists, append
below the current layout. Existing items never move until the user confirms the
draft.

## E. Default 1280×720 Overview layout

Coordinate origin is the browser viewport. Content width is 1064 px.

| Area | x | y | w | h |
|---|---:|---:|---:|---:|
| Rail | 0 | 0 | 176 | 720 |
| Header | 176 | 0 | 1104 | 64 |
| Page toolbar | 196 | 76 | 1064 | 48 |
| ROG | 196 | 136 | 1064 | 60 |
| Coffee | 196 | 208 | 615.7 | 276 |
| Planning | 823.7 | 208 | 436.3 | 276 |
| Home actions | 196 | 496 | 615.7 | 132 |
| Services/backup health | 823.7 | 496 | 436.3 | 132 |

The remaining 72 px below the grid protects the Windows/kiosk edge and gives
notices room without forcing a layout shift.

ROG anatomy:

```text
12 px | device icon | ASUS ROG G703GI · В сети | freshness | [Гибернация 48h] | 12 px
```

- status text 14/20, device name weight 680;
- semantic dot 8 px plus explicit label;
- action width 144–164 px, height 48;
- online exposes only Hibernate; offline only Wake;
- waking/hibernating shows progress at origin and disabled action;
- unknown/unavailable contains no guessed power action.

## F. Widget anatomy

Every work-zone widget uses 16 px outer padding in standard size and 12 px in
compact size. Header is 28–36 px high. Header order: icon, title, optional
freshness/status, optional details control. Body owns state and primary action.
Footers are used only for essential authority/freshness.

### F1. Coffee (`home.coffee-machine`)

Supported sizes:

- compact `4×3`: no illustration; state, remaining time, one 56 px action;
- standard `7×4`: default; state/action left, restrained 112×148 line/optimized
  raster illustration right;
- large `8×5`: adds progress history/policy detail, not a larger image.

Priority: title → state → remaining/last activation → action → HA authority.
The current multi-megabyte PNG must be resized/converted for actual display
density and lazy-loaded; it never occupies more than 28% of widget area.

States:

- loading: fixed state/action skeleton, no image loading shift;
- off: `Выключена`, last change, `Включить`;
- warming: `Разогрев · 8 мин`, verified progress and restrained steam;
- ready/running: explicit state and `Выключить` when allowed;
- stale: last-known state + stale strip and timestamp; actions follow policy;
- unavailable/offline: no fabricated physical state; safe retry/details action;
- error: isolated error body;
- action progress: action button disabled with stage `Проверяем состояние…`;
  success only after HA verification.

### F2. ROG (`system.rog-g703-operational`)

- compact `6×1`; standard/default `12×1`; optional detail `6×2`;
- status and one contextual action only;
- transition is shown inline and via NoticeCenter;
- stale/unknown/unavailable never exposes a guessed action;
- exact fixed action IDs, confirmation and PIN flow remain unchanged.

### F3. Planning (`planning.summary`)

- compact `4×3`: next reminder/task/event, one line each;
- standard/default `5×4`: three 64 px rows with status/freshness;
- large `7×5`: adds second item per domain, not mutation forms.

Rows use domain icon, title, time/status, and chevron when navigable. Empty
states remain one compact row. Loading preserves three rows. Stale/offline use
the summary-level truth banner and per-row last-known data. Future B4 may add
one header `Добавить` control; it must not change the grid anatomy.

### F4. Home actions (`home.quick-actions`)

- compact `4×2`: one action;
- standard/default `7×2`: up to two actions side by side;
- each action cell has device name/state and a 48–56 px contextual button;
- loading/stale/offline is per device, so one failure does not disable the
  other cell;
- action origin shows requested/executing/verifying state.

### F5. Services health (`system.health-summary`)

- compact/default `5×2`; large `7×3`;
- top line: aggregate status, e.g. `4 в норме · 1 требует внимания`;
- second line: highest-priority incident;
- footer: backup freshness as one text segment;
- degraded/offline/stale are explicit and link to Services/System;
- no service action is executed from this summary.

### F6. Weather alert (`weather.alert`)

- compact `4×1`; standard `6×2`;
- absent from default when no meaningful alert exists;
- uses a registered alert kind, time window and source freshness;
- no animated ambience; icon + concise operational copy;
- stale forecast is labelled and never phrased as current certainty.

### F7. Future calendar agenda (`planning.calendar-agenda`)

- compact `4×3`; standard `6×4`; large `8×5`;
- all-day band first, timed rows below; overlapping events retain identities;
- source/calendar identity and freshness are visible but compact;
- provider errors affect their source row, not local events;
- external phase remains read-only until separately authorized.

### F8. Future task widget (`planning.task-list`)

- compact `4×3`; standard `6×4`; large `8×5`;
- today/overdue/upcoming segments; title, date/time, project/source identity;
- TickTick is provider/projection, not canonical persistence;
- B3 read-only has no fake completion control; B4 controls appear only behind
  domain capability/feature flags.

## G. Weather design

### G1. First viewport

At canonical viewport:

- 48 px location/actions toolbar;
- 260 px condition hero;
- 12 px gap;
- 184 px hourly work zone spanning 8 columns;
- 184 px sun/wind/precipitation context spanning 4 columns;
- daily forecast begins below the first viewport without hiding current/hourly
  decisions.

The hero is a domain work zone, not a marketing hero. Location, freshness,
temperature and condition dominate; four metrics align on one bottom divider.
Atmosphere stays behind a solid/tonal content scrim with tested contrast.

### G2. Condition language

| Condition | Palette and layers |
|---|---|
| Clear day | warm stone/sky tonal field; one 96 px sun disk; optional static short rays |
| Clear night | graphite-blue field; 72 px moon disk; sparse static stars, no twinkle |
| Partly cloudy | clear palette + one duplicated cloud track; sun/moon remains static |
| Cloudy | mineral grey field; two depth-separated cloud shapes on one track |
| Fog | desaturated field; two low-opacity tiled horizontal veils, max two moving layers |
| Rain | cool graphite field; static cloud mass + one oversized repeating rain plane |
| Storm | darker rain palette, denser rain; no permanent lightning flash |
| Snow | cool pale/dark field; two tile-exact near/far snow planes |

`isDay` is a required visual input. It affects palette, sun/moon glyph and
contrast, not only copy.

### G3. Seamless compositor

- every moving plane overdraws hero bounds by at least one full tile;
- rain tile example: 24×72 px, transform exactly `translate3d(-24px,72px,0)`;
- snow planes translate by their exact background tile dimensions;
- cloud track contains two identical groups and translates exactly one group
  width before wrapping;
- start and end frames are visually equivalent;
- moving nodes animate only transform and rare opacity;
- do not animate `background-position`, blur, filter or layout properties;
- maximum two continuously animated layers total;
- `prefers-reduced-motion`, `.motion-low-performance`,
  `.motion-battery-saving`, and `document.hidden` stop ambience.

Weather management uses the shared sheet. `Управление` never expands content at
the end of the page.

## H. Shared NoticeCenter and sheet primitives

### H1. NoticeCenter

- rendered through a portal directly under app root;
- `position: fixed`; never participates in route flow;
- canonical anchor: `right: 20px; top: 76px`;
- width 360 px; maximum three notices; 8 px gap;
- access indicator remains in header and therefore does not overlap this anchor;
- if a modal/sheet is open, notices anchor to the unobscured workspace edge;
- each notice minimum 80 px high, 12 px padding, 48×48 dismiss/action target;
- progress notice persists until terminal/reconciled state; success defaults to
  6 seconds, warning 10 seconds, error requires dismissal or 12 seconds;
- deduplicate by logical id + correlation id;
- action progress is also visible at the originating widget/button.

At ≤760 px, notices occupy `left/right: 12px`, `top: 124px`, one at a time with
the rest available through a notice count. Placement must pass collision tests
against focused/primary controls.

### H2. Sheet/dialog

Canonical right sheet:

- width 560 px, max-width `calc(100vw - 24px)`;
- height `min(680px, visualViewport.height - 24px)`;
- right/bottom inset 12 px;
- surface-1, 16 px radius, overlay shadow;
- backdrop uses solid translucent overlay, no backdrop blur;
- header min-height 72 px, sticky top, 20 px padding;
- close control 48×48;
- body scrolls independently with 20 px padding;
- footer min-height 80 px, sticky bottom, 12/20 px padding, top divider;
- primary footer action 56 high; secondary 48 high;
- focus trap, restore focus to trigger, Escape closes only when safe;
- background becomes inert and non-scrollable.

`visualViewport.resize/scroll` updates `--cc-visible-height` and bottom inset.
With approximately 360 px visible height, header is 60 px, footer 72 px and at
least 204 px remains scrollable. The focused field is scrolled into the body
safe area above the sticky footer. No field or confirmation control may be
covered by the OSK.

Dialogs use the same anatomy at max-width 520 px and are centered in the
visible viewport. Strong-confirmation interaction remains intentionally
unchanged until its separate owner decision.

## I. Route-by-route layouts

### Overview

Use the default grid in section E. Remove explanatory subtitle at canonical
viewport. Recovery occupies the health widget/status origin, not an inserted
banner. Normal and Edit modes are visually distinct.

### Weather

Use section G. Location switcher remains 48 high. `+ Место`, `Управление` and
refresh are in one toolbar. Management opens sheet. Daily rows use dividers,
not a repeated card per day.

### Home

First viewport: 40 px page toolbar, 56 px HA authority line, then a 12-column
device grid. Coffee is compact `6×3`, kettle `6×2`, remaining devices dense
rows below. No giant duplicate Coffee hero or future-placeholder card. Primary
actions stay beside current device state.

### Services

First viewport: page toolbar, 84 px attention summary, then one full-width
attention work zone. Degraded/offline services appear first as 64–72 px rows.
Healthy groups collapse to one 56 px row such as `Дом · 4 сервиса в норме` and
expand on explicit tap. Technical facts live in details sheet. No action is
inferred from service type.

### Tasks

First viewport: title/source freshness and future primary-action slot; 48 px
segmented view; optional 48 px project filter; dense 64 px rows. B3 has no fake
checkbox. B4 later inserts registered controls without changing row geometry.

### Calendar

First viewport: title/source freshness, 48 px date navigation, all-day band,
then 64 px timed agenda rows. Source/calendar identity is a 13 px secondary
line. Overlap uses a 3 px side rule and explicit text; it is not presented as a
sync conflict.

### Reminders

Same Planning route frame. Segments: `Предстоящие / Просрочено / Доставка`.
Each 64–72 px row separately displays lifecycle and delivery state. `Доставлено`
never becomes `Выполнено`. Future B4 actions appear only after capability and
feature gates.

### System

First viewport: 84 px aggregate health strip, ROG detailed zone `6×3`, Panel
Agent/runtime zone `6×3`, then compact connectivity/update/backup rows. System
is diagnostics and host operations; it is not another service catalog.

### Settings

First viewport: title, full-width 112 px Appearance zone, then two columns:
Coffee and Notifications left; Access and Runtime right. Every section is a
compact 64 px summary row that opens a sheet, except theme/motion which remain
direct controls. Avoid a single 2200 px form. Native 22 px checkboxes are
replaced by a 48 px row/switch affordance. Settings never accepts production
credentials.

## J. Prototype and canonical screenshots

The isolated prototype is under `prototype/`. It is not imported by any
production module and makes no network request. Canonical renders under
`screenshots/` are:

1. `overview-night.png`
2. `overview-day.png`
3. `overview-edit.png`
4. `weather-clear-day.png`
5. `weather-rain-night.png`
6. `services-degraded.png`
7. `settings.png`
8. `planning.png`

They are rendered at 1280×720 CSS px, deviceScaleFactor 1.5.

## K. Layout persistence schema

Panel Agent remains the persistence boundary. Browser state contains no
credentials, endpoints or executable definitions.

```json
{
  "schemaVersion": "overview.layout.v2",
  "profileId": "samsung-control",
  "presetId": "overview.default",
  "presetVersion": 2,
  "revision": 7,
  "viewportClass": "landscape-12",
  "updatedAt": "2026-08-13T12:00:00Z",
  "items": [
    {
      "instanceId": "widget.coffee.primary",
      "widgetType": "home.coffee-machine",
      "visibility": "visible",
      "placement": { "x": 0, "y": 1, "w": 7, "h": 4 },
      "sizeVariant": "standard",
      "config": { "showRemainingTime": true }
    }
  ]
}
```

Requirements:

- `widgetType` must exist in the fixed registry;
- `config` is validated against that manifest's bounded schema;
- data binding and allowed action IDs are server/registry-owned, not editable
  layout fields;
- save uses revision/If-Match semantics; timeout is uncertain until read-back;
- migrations are pure, version-to-version and preserve instance IDs;
- migration clamps only to declared manifest limits and records a warning;
- an unknown widget type is skipped and appears in `Неразмещённые`, while valid
  items still render;
- malformed placement is deterministically reflowed after the last valid row;
- corrupt root/schema or zero valid items falls back to the shipped preset;
- fallback never overwrites stored bytes until the owner explicitly saves or
  resets;
- reset references the current shipped preset version;
- layout is included in config backup and contains no secrets.

## L. Luna PR-by-PR implementation handoff

### PR 1 — V2 tokens, typography and shell/navigation

**Goal:** implement section B/C without changing domain behavior.

Likely files:

- `apps/dashboard/src/styles.css`
- `apps/dashboard/src/Shell.tsx`
- new `apps/dashboard/src/icons.tsx`
- focused token/shell tests and Playwright screenshots.

Create shared `Icon`, `StatusText`, `RouteHeader`, `WorkZone` primitives. Remove
letter avatars and unfinished placeholder routes from primary navigation;
visibly group Planning.

Tests: exact 1280×720 geometry, day/night token contrast, 48 px targets,
keyboard focus, long Russian labels, 200% no horizontal overflow. Screenshots:
shell on Overview/Weather/Planning/Settings.

Feature flag: `VITE_V2_VISUAL_SHELL=false` until screenshot review.

Must not change route APIs, ROG actions, access policy or Planning semantics.

### PR 2 — non-reflow NoticeCenter and OSK-aware sheet

Likely files:

- `NoticeCenter.tsx/.css`
- `PlanningRoutePrimitives.tsx`
- new `Sheet.tsx`, `DialogFrame.tsx`, `useVisualViewport.ts`
- migrate Weather management to the shared sheet.

Tests: no route-flow displacement; three notices/access state; dedupe; 360 px
visible viewport; focus trap/restore; sticky actions; OSK resize; reduced mode.
Screenshots: notice matrix, 360 px sheet, Weather management.

Feature flag: not needed if primitive tests and migrations land together.

Must not change confirmation strength or mutation behavior.

### PR 3 — safe Overview grid and widget manifest constraints

Likely files:

- `registry.ts`
- contracts package widget/layout types
- new `features/overview/DashboardGrid.tsx`
- new `features/overview/layoutValidation.ts`
- fixture definitions.

Implement 12-column rendering, fixed registry metadata, size variants, error
boundaries and responsive projection. Rendering only; persistence/editing off.

Tests: min/max/bounds, deterministic first-fit, stable push-down, unknown widget
fallback, one-widget failure isolation, 12/8/4-column projection.

Feature flag: `VITE_OVERVIEW_V2_ENABLED=false`.

Must not add arbitrary HTML/JS/network/action configuration.

### PR 4 — curated default Overview and shared compact ROG controller

Likely files:

- `pages.tsx` / new `features/overview/OverviewPage.tsx`
- `PlanningOverviewCard.tsx`
- `RogG703Controls.tsx` refactored into shared controller + compact/detail views
- Coffee and Home widgets/styles.

Implement exact section E preset. Optimize the coffee asset. Recovery is
rendered inside reserved health/status origin.

Tests: all ROG states and exact safe payloads; PIN/confirmation; first viewport;
Coffee truth states; stale/offline; notices do not move grid. Screenshots:
night/day/default, ROG transitions, long Russian.

Physical acceptance: no dedicated pass; include in next grouped visual pass.

Must not add S5, generic action/proxy/shell or optimistic success.

### PR 5 — Overview Edit mode and persistence

Likely files:

- new `features/overview/EditToolbar.tsx`
- `WidgetPicker.tsx`, `EditableWidgetFrame.tsx`
- layout reducer/validation/migrations
- Panel Agent fixed layout GET/PATCH routes and storage module
- contracts/fixtures/e2e.

Implement section D/K: explicit Edit, handles, accessible move controls,
revisioned single-save draft, cancel/reset, safe picker and migrations.

Tests: add/remove/reorder/resize/reset/cancel/save/conflict/timeout/read-back;
touch handle only; invalid layout; stale schema; unknown widget; dirty state;
backup inclusion; no secrets. Screenshots: Edit mode, picker, invalid drop.

Feature flag: `PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED=false` plus frontend editor
flag false. Read/default rendering remains available independently.

Migration: accept current configured default as preset v1; do not silently
overwrite existing configured layout.

Must not add arbitrary plugin execution or editable endpoints/action IDs.

### PR 6 — Weather compositor and route

Likely files:

- `Weather.tsx`, `Weather.css`
- new condition presentation/compositor module
- weather fixtures and Playwright motion tests.

Implement section G, use `isDay`, remove large orb/blob system, tile-exact
rain/snow, shared sheet management.

Tests/screenshots: eight conditions × day/night as applicable; T−ε/T/0 seam
frames; full/reduced/low/battery; hidden-page pause; no background-position or
filter animation; 1280×720/200%/long labels.

Physical acceptance: one grouped Weather Samsung pass after synthetic review.

Must not invent hardware performance claims or reduce data truthfulness.

### PR 7 — Home, Services and System density

Likely files: route components in `pages.tsx` split into feature folders,
shared `HealthRow`, `DeviceRow`, `CollapsibleGroup`.

Implement section I. Preserve registry-driven rendering and generic fallback.

Tests/screenshots: Home degraded HA/Alice-independent Coffee; Services healthy
collapsed/degraded first; System ROG/runtime/connectivity; 1280/200%; one widget
failure isolation.

Must not infer actions from project/service type.

### PR 8 — Settings information architecture

Likely files:

- `pages.tsx` / new settings feature folder
- `CoffeeSettings.tsx`
- access/runtime settings components
- shared 48 px switch/setting-row.

Implement section I with Appearance first and detail sheets.

Tests/screenshots: first viewport, 200%, OSK, disabled policy, long Russian,
theme/motion persistence, 48 px targets.

Must not store/request credentials or decide strong-confirmation replacement.

### PR 9 — Planning visual/module foundation

Dependency: issue #63; still no B4 mutations.

Likely files:

- `PlanningRoutes.tsx`, `planningRoutes.css`
- `planningRouteConfig.ts`, `App.tsx`, `Shell.tsx`
- new Planning module/route registry
- provider/calendar identity contracts and fixtures.

Implement consistent Tasks/Calendar/Reminders frames, module registration,
per-domain capability slots, source/calendar identity and future-action slots.

Tests/screenshots: B3 current/stale/offline/degraded/empty; multiple calendar
identities; all-day/overlap; reminder delivery vs completion; long/hostile text;
all mutation flags false.

Must not implement B4, provider writes, TickTick OAuth/sync, parser mutation or
change canonical Planning persistence.

## M. Open questions

No visual owner decision blocks PRs 1–9. The locked calm-technical direction,
grouped Planning navigation, customizable Overview and provider split are
sufficient.

The following existing decisions remain intentionally outside this design and
must not be silently resolved:

- `SNOOZE_PRESET_PRODUCT_DECISION_PENDING`;
- `STRONG_CONFIRMATION_TOUCH_REPLACEMENT_DECISION_PENDING`;
- `TELEGRAM_TASK_EVENT_CREATION_PRODUCT_DECISION_DEFERRED`.
