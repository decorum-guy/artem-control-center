# Samsung tablet UX audit

Date: 2026-08-11

Scope: issue #61, planning only
Canonical target: the production Samsung reached through `control-panel-pc`

## Evidence and method

The audit was not performed against a generic tablet preset. The Samsung was inspected read-only over SSH, then the current `main` checkout was run on the Mac with Playwright at the measured effective viewport: **1280 × 720 CSS px**, `deviceScaleFactor: 1.5`, touch enabled, no mouse/keyboard assumptions. DOM evidence includes bounding boxes, page/region scroll dimensions, visible hit targets, horizontal intersections, text overflow, fixed layers and computed font sizes. Raw measurements are in [measurements.json](assets/samsung-tablet/measurements.json) and [interaction-measurements.json](assets/samsung-tablet/interaction-measurements.json).

### Verified Samsung baseline

| Item | Observed value |
| --- | --- |
| Windows | Windows 10 Pro 10.0.19045, build 19045, x64 |
| CPU | Intel Core i7-7500U, 2 cores / 4 logical processors, 2.70–2.90 GHz |
| RAM | 8 GB (2 × 4 GB DDR4-2133); about 5.1 GB free during inspection |
| GPU | Intel HD Graphics 620; no CUDA-capable discrete GPU |
| Display | 1920 × 1080 @ 59 Hz |
| Scaling | 150% (`AppliedDPI=144`); Edge uses `--device-scale-factor=1.5` |
| Canonical CSS viewport | **1280 × 720** |
| Input | HID touch screen, touch pad and pen reported healthy |
| Edge | Stable 151.0.4129.72, fullscreen kiosk |
| Kiosk URL | `http://127.0.0.1:8787/overview` |
| Production revision | `76946a9b7b22`; clean `main`, one commit behind inspected local `main` (`54bfd938`) |
| Runtime | Panel Agent live/ready; production writes enabled; HA and AliceTG healthy; AVALAR Stage healthy; AVALAR Main unavailable |
| Resource sample | Edge: 7 processes / ~260 MB working set; Node: ~25 MB working set |

The local fixture runtime required `eval-type-backport` in its ignored Python 3.9 virtualenv. `pyproject.toml` declares Python 3.9 support but Pydantic models use evaluated `X | None` annotations; a clean 3.9 setup currently cannot collect all Panel Agent tests without the missing dependency. This is a reproducibility defect, not a production change made by this audit.

### First-viewport measurements

| Route/state | Document height | Excess over 720 px | Notes |
| --- | ---: | ---: | --- |
| Overview, day/night and all motion modes | 958 px | 238 px / 33% | support/monitoring row starts below the fold |
| Home, stale coffee | 1001 px | 281 px / 39% | primary device dominates the first screen |
| Services, degraded | 1129 px | 409 px / 57% | operational metadata is dense and small |
| Weather, day | 1477 px | 757 px / 105% | hero consumes almost the full first viewport |
| Settings | 1228 px | 508 px / 71% | frequent and dangerous controls are split across screens |
| Calendar / Tasks / Backups / Apps / System | 720 px | 0 | these are placeholders, not implemented product states |

There was no document-level horizontal overflow. The Weather hourly row intentionally scrolls horizontally, but one 82 px card ended at x=1304.4 and is cut without a strong continuation affordance. The navigation rail exactly fits 720 px and did not trap or hide its last item.

## What already works

- The visual identity is coherent in day/night themes; hierarchy and accent color remain legible.
- Global pressed feedback exists (`button:active` / `a:active`) and navigation links are at least 48 px high.
- Reduced, low-performance and battery-saving modes stop coffee/weather decorative animations. `prefers-reduced-motion` is also handled.
- PIN elevation is genuinely touch-first: no input field, twelve 64 px keypad buttons, 460 × 625 px dialog fully inside the viewport. Evidence: [PIN elevation](assets/samsung-tablet/pin-elevation.png).
- Everyday coffee confirmation uses 54 px actions and fits without scrolling. Evidence: [coffee confirmation](assets/samsung-tablet/coffee-confirmation.png).
- Stale/degraded state is communicated with text and semantic color rather than color alone.

No P0 blocker was reproduced. The P1 findings below should be resolved before adding dense reminders/tasks/calendar content; otherwise the new product layer will amplify the current scrolling and collision problems.

## Findings

### P1-01 — Overview is not glanceable at the real viewport

- Route/state: `/overview`, day/night, healthy and degraded.
- Evidence: document height 958 px; the coffee/today grid begins around y=330 and the support/monitoring row begins around y=752. [Overview screenshot](assets/samsung-tablet/overview-night.png).
- Issue: the coffee hero consumes most of the useful first viewport while Calendar, Tasks and incidents share a narrow column. The existing support summaries, including backups and services, require scrolling.
- Why Samsung touch matters: at arm's length, Overview must answer “what needs attention now?” without a precise scroll gesture. Adding three planning widgets as-is would overload the narrow column or push them off-screen.
- Fix: reduce the coffee hero to roughly 280–320 px height and 55–60% width; replace the three tall “today” blocks with one compact “Дела” summary containing next reminder, overdue task count and next event; keep the current visual language and move secondary service/backups summaries below.
- Acceptance: at 1280 × 720, header + page heading + complete coffee state/action + all three planning signals are visible without vertical scrolling; no primary target is below y=700; long Russian titles wrap to two lines without changing card height while touched.

### P1-02 — Weather hero and ambience dominate instead of informing

- Route/state: `/weather`, day/night, full motion.
- Evidence: document height 1477 px; the 390+ px hero occupies the first screen and only the next section heading appears at the bottom. The hourly scroller contains a card ending at x=1304.4. [Weather screenshot](assets/samsung-tablet/weather-day.png).
- Issue: 22° is rendered at poster scale while hourly/daily information requires more than one full-screen scroll. Ambient orb/cloud layers use continuous transforms and large translucent surfaces.
- Why Samsung touch matters: the useful forecast is hidden below a decorative hero; the i7-7500U/HD 620 has limited animation headroom and content can move behind a finger.
- Fix: cap hero around 270–300 px on the canonical viewport, retain one restrained ambient layer, expose 4–6 upcoming hours in the first viewport, and add edge fade/“ещё” affordance to the localized horizontal scroller. Default this specific Samsung to low-performance unless a production trace proves full motion stays smooth.
- Acceptance: current conditions plus at least four hourly points are visible at 720 px; only `.weather-hourly` may have `scrollWidth > clientWidth`; no ambient animation runs in reduced/low-performance/battery modes; a 30-second Edge performance trace has no long task over 100 ms caused by ambience.

### P1-03 — Several real touch targets are below 48 px

- Route/state: global header, Weather search/manage, Settings.
- Evidence: header weather target 182.9 × 45 px; Weather search close button 48 × 27 px; saved-location controls are 42 px by CSS; coffee numeric inputs are 46 px high. [Weather search](assets/samsung-tablet/weather-search-osk-flow.png). Settings exposes native 22 × 22 px checkboxes, although their enclosing label improves part of the hit area.
- Issue: the visual target and sometimes the actual control are below the repository's 48 × 48 rule.
- Why Samsung touch matters: misses occur near destructive “Удалить” and close/reorder controls, especially without hover feedback.
- Fix: make every visible action box at least 48 × 48; make the full notification row toggleable; use 56 px for destructive/primary pairs and maintain 12 px separation.
- Acceptance: automated DOM test fails any visible `button`, link, input or select below 48 px unless an explicitly tested `<label>` supplies an equivalent 48 px hit region; all Weather management actions pass touch `.tap()` tests.

### P1-04 — Required typing unnecessarily summons the Windows OSK

- Route/state: Weather add/rename; Settings coffee timing; production AVALAR strong confirmation; future planning create/edit flows.
- Evidence: Weather search is a text searchbox; saved locations contain editable text inputs; coffee timing uses `type=number`; strong production confirmation requires exact English phrases such as `DEPLOY MAIN`. [Settings screenshot](assets/samsung-tablet/settings-night.png), [Weather search](assets/samsung-tablet/weather-search-osk-flow.png).
- Issue: common numeric changes and high-risk confirmation are keyboard-shaped. The exact-case production phrase is particularly hostile on a Russian touch kiosk.
- Why Samsung touch matters: OSK covers a large fraction of 720 px, shifts the focused control and makes exact Latin uppercase entry error-prone.
- Fix: coffee timing gets `−` / value / `+` steppers plus common presets; planning fields use microphone for title only and touch pickers for structure; Weather keeps search as a rare fallback but adds recent/favourite suggestions and voice. Replace typed destructive phrase with full-access PIN plus a second explicit target-specific hold-to-confirm (1.2–1.5 s); retain keyboard phrase only as optional emergency fallback if security policy requires it.
- Acceptance: coffee settings, planning create/edit and production confirmation can all be completed with touch only and never focus a text input; invoking Weather search is the only deliberate OSK path and closing it restores scroll position.

### P1-05 — Shutdown still uses a native browser confirmation

- Route/state: Settings → runtime shutdown.
- Evidence: `apps/dashboard/src/RuntimeControls.tsx` calls `window.confirm`, while the product already has `ActionConfirmationProvider`.
- Issue: a browser-owned dialog has inconsistent styling, limited touch semantics and cannot participate in focus, telemetry or collision rules.
- Why Samsung touch matters: native kiosk prompts can appear outside the app's designed flow and rely on generic button labels.
- Fix: register `system.runtime.shutdown` in `actionConfirmationCatalog`, include current revision/target, and use the same touch confirmation system.
- Acceptance: an e2e test replaces `window.confirm/prompt/alert` with throwing stubs and completes/cancels shutdown solely through the custom dialog; cancel performs no POST.

### P1-06 — Fixed notices can occupy the same bottom-right pixels

- Route/state: AVALAR action, connectivity recovery, coffee action and temporary full access.
- Evidence: `.action-notice` and `.temporary-access-badge` all use fixed `right: 18–24px; bottom: 18–24px`; z-indexes are 90, 60 and 20 depending on provider. AVALAR and connectivity providers can render separate notices.
- Issue: concurrent status surfaces overlap rather than queue/stack; a higher z-index hides the lower state.
- Why Samsung touch matters: a hidden “Завершить полный доступ” control or delivery failure is materially worse on a kiosk with no notification center fallback.
- Fix: one global notice stack/region owned by the shell, safe-area aware, max three items, deduplicated by correlation ID; temporary access becomes a persistent header chip or the first stack item.
- Acceptance: fixture test renders temporary access + connectivity progress + AVALAR result simultaneously; bounding boxes do not intersect and no item covers navigation/actions at 1280 × 720.

### P1-07 — Operational text is too small at arm's length

- Route/state: Services and Weather details.
- Evidence: Services produced 83 visible text nodes below 12 px; environment/source/freshness labels are commonly 9–10 px. Weather produced 76. [Services screenshot](assets/samsung-tablet/services-degraded.png).
- Issue: useful operational distinctions are visually subordinate to empty space and large headings.
- Why Samsung touch matters: 9–10 px CSS text at 150% scaling remains hard to scan from normal tablet distance.
- Fix: minimum 12 px for essential metadata, 13–14 px for statuses/actions; abbreviate or progressively disclose latency/source rather than shrinking it.
- Acceptance: no status, due time, freshness, failure reason or action label computes below 12 px; 200% browser zoom does not clip Russian copy.

### P1-08 — Calendar, Tasks, Backups, Apps and System are navigation-complete but product-empty

- Route/state: the five named routes.
- Evidence: all are routed to `PlaceholderPage`; screenshots exist in the asset directory and tests only verify the shell.
- Issue: the navigation advertises operational surfaces that cannot yet monitor or act. Calendar and Tasks are in scope for the two implementation plans; the other three remain separate product gaps.
- Why Samsung touch matters: users spend taps and context switches reaching a dead end.
- Fix: implement Calendar/Tasks through the planning contracts below. Until Backups/Apps/System are implemented, show useful read-only summaries or label them “Скоро” in navigation; do not present a dead end as a working section.
- Acceptance: Calendar and Tasks have real loading/empty/stale/offline/error fixtures; unimplemented sections are explicitly marked before navigation.

### P2-01 — Mixed Russian/English copy weakens scan consistency

- Route/state: Settings, Backups, Services.
- Evidence: `Backups`, `Production credentials`, `Reduced motion`, `Low performance`, `Battery saving`, `Control plane` coexist with Russian product copy.
- Fix: localize user-facing copy; retain English only for immutable product/provider names and technical details in System.
- Acceptance: snapshot/lint test checks the known UI dictionary; no untranslated mode labels remain.

### P2-02 — The header's settings shortcut is visually ambiguous

- Route/state: all routes.
- Evidence: the 48 px settings shortcut displays only “А”; its meaning is discoverable only through accessibility label/hover.
- Fix: use the established settings glyph plus concise accessible label; do not add another text-heavy header control.
- Acceptance: five touch-test participants or an icon comprehension review identifies it without hover; target remains 48 px.

### P2-03 — Fixture defaults hide important action states

- Route/state: local Services audit.
- Evidence: without production-only action configuration, access/AVALAR/connectivity availability return 404 and fixtures show only `Подробнее`; tests inject mocks. `npm run check` on the existing Python 3.9 venv initially failed collection due the missing backport noted above.
- Fix: provide a supported audit fixture profile for access/actions/connectivity and make the declared Python floor truthful (either require ≥3.10 or include/test the backport).
- Acceptance: a clean `npm run setup && npm run check && npm run test:e2e` exercises PIN, simple/strong confirmation, connectivity progress and notices without hand-written route mocks.

## Required state matrix for implementation

Each planning domain must have deterministic fixtures for: loading; empty; current; due soon/today; overdue; completed/cancelled; stale cache; provider degraded; offline with cache; offline without cache; mutation pending; optimistic conflict; validation ambiguity; delivery retrying; terminal delivery failure. Day/night and full/reduced/low-performance/battery modes run at 1280 × 720 with touch. Screenshots are acceptance artifacts, but DOM assertions—not pixel appearance alone—gate hit targets, overflow, collisions and viewport intersection.

## Recommended order

1. Fix shared touch primitives, notice stacking and native confirmation before adding planning UI.
2. Rebalance Overview and Weather at 1280 × 720.
3. Add read-only planning monitoring.
4. Add touch CRUD and microphone title entry only after backend foundation is independently proven.

## Repository validation during the audit

- `npm run build`: passed.
- ESLint, TypeScript typecheck and 21 dashboard unit tests: passed; ESLint reported the seven existing Fast Refresh warnings.
- `npm run check`: stopped in Panel Agent tests with 17 failures/45 passes because Python 3.9 constructs `asyncio.Lock()` after the suite has no current event loop. This is a source/runtime baseline defect; documentation changes do not execute in the suite.
- `npm run test:e2e` on a clean fixture server: 15 passed/7 failed. The failures expose the unsupported fixture profile recorded in P2-03 (access, AVALAR and connectivity action endpoints unavailable), one PIN request interception mismatch, and an outdated expectation that the coffee asset fallback is visible. The audit Playwright run used explicit mocks/fixture flags to inspect those states; the standard suite needs a deterministic all-capabilities audit profile before it can be a release gate.

No production source, Home Assistant configuration, AliceTG_Bot file or Samsung setting was changed by this audit.
