# #279 visual foundation — Slice 1

Base: `ca241fa979af2cd9eba7069e92bd39cade9034cf` (`origin/main`, checked 2026-09-24).

## Implementation map

1. Foundation: shared type, surfaces, header, accent roles, quiet motion and visual gates.
2. Overview: working-object hierarchy, confirmed active Coffee contour glow, Climate and service summaries.
3. Calendar: density, optional source dots, touch time picker, event sheet and coordination with #105 writes.
4. Settings: volume/brightness controls, icons, unavailable states and surface hierarchy.
5. Shared polish: Home/System/Services, Weather header assets, Jarvis/touch exceptions and physical review.

Only step 1 belongs to this PR. #278 and AliceTG_Bot are separate work.

## Current-main audit

- The V2 shell already uses a fixed 64 px header, 176 px rail, 48 px navigation and header controls, page/section/widget/state/body/metadata type tokens, semantic status colors, and tabular header time.
- Route pages use shared `RouteHeader`, `SectionHeader`, `OperationalStatusSummary` and `WorkZone`. Overview uses a registry/grid and its own widget CSS. System and Services retain repeated healthy/attention summaries; their information architecture belongs in later slices.
- Sheet/DialogFrame already provide a sticky header/footer, document lock, inert background, focus trap/restore, backdrop click-through protection and visual-viewport/OSK layout. Their structure does not need a rewrite.
- V2 Settings and Calendar still spend vertical room on route/section chrome. Slice 1 keeps route geometry unchanged; their density work belongs in slices 3 and 4.
- The day `--cc-text-muted` was `#6d7c78`: approximately 3.58:1 on the canvas and 4.04:1 on the primary surface. The shared day token is now `#596a65`: approximately 4.68:1 and 5.28:1 respectively. Secondary body text was already stronger and remains distinct.
- The selected V2 navigation state reused a warm filled surface and amber icon close to warning/primary-action color. It now uses a neutral surface and text with a narrow accent locator. Warning, success, stale, offline and unavailable still use their semantic tokens and labels.
- Route content and shared Sheet had no entrance motion, although press/reconcile/expand/sheet tokens and a reduced-motion override existed. The new route and overlay fades do not change geometry or animate live polling updates. CSS `prefers-reduced-motion` still overrides the user's Full setting.
- Undefined CSS references were real: `--border-subtle`, `--surface-raised`, `--text-primary`, `--cc-border-strong`, `--cc-surface`, `--cc-surface-strong` and `--cc-radius-card`. Shared aliases now resolve them; fallbacks and component-specific scopes are preserved.
- Existing E2E gates already cover 1280×720 geometry, 200% effective viewport, touch targets, long labels, focus/inert, visualViewport, route behavior and review screenshots. This slice adds a focused day/night/Calendar/Settings/reduced-motion review family rather than pixel snapshots.

## Slice 1 boundaries

No Coffee glow, calendar dots/picker/write UI, Settings slider redesign, Weather artwork replacement, #278 thermal model, AliceTG_Bot changes, or route/grid rewrite.
