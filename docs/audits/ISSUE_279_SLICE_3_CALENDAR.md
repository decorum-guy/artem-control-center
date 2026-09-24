# Issue #279 Slice 3 — Calendar visual and touch editor

## Base and boundary

- Base: `fcad736d41ffb5cb0a11ae6851d51225fdfde231` (clean `main`; post-merge Actions run `36041890688` passed before implementation).
- This slice changes the Dashboard Calendar UI and its tests. The existing Panel Agent LOCAL-ONLY calendar mutation route remains the only writable route. External iCloud events remain read-only. It does not change AliceTG_Bot, introduce provider endpoints, or perform CalDAV writes.
- Source of truth: issues #279 and #105 (including the latest Slice 3 coordination comment), #112, #116, #80, and the merged Slice 1/2 audits.

## Current implementation confirmed

- Calendar create/edit used a phrase textarea, `previewPlanningEvent()`, preview, `eventMutationBodyFromPreview()`, then `mutatePlanningEvent()`. This works, but made parsing the primary touch workflow.
- The event contract and current Panel Agent create/patch implementation safely accept `title`, `notes`, `location`, temporal fields, and `timezone`. Local edits use `If-Match` and a canonical object response. Source events are read-only.
- Agenda rows had a prominent 4px source-color border while month cells already showed calendar-color indicators. The all-day band had warning-like styling. The shared `Sheet` supported a sticky footer, but `PlanningSheet` did not expose it.

## UI and editor architecture

- Full month and selected-day agenda remain side by side at 1280×720. A six-week month uses 66px cells; header spacing is reduced and the agenda scrolls independently when needed. A five-week month uses its own compact height. The all-day band is a calm temporal section, separate from warning styling.
- Overview/Planning calendar rows always keep the existing `.planning-row__source-marker` 4px vertical bar. Calendar marker preference never reaches that component. On the Calendar page only, selected-day agenda rows use the persisted Panel-owned `eventMarkerStyle` choice: `dots` (default) renders one 9px identity dot, while `bars` renders a restrained 3px left border. Month-cell indicators remain their existing small dots. The former `VITE_CALENDAR_EVENT_COLOR_DOTS_ENABLED` flag is not part of the product decision path.
- `CalendarMutationSheet` is the primary structured create/edit form: destination, title, all-day, dates, start/end time, duration presets, location, notes, validation, and sticky Save/Cancel footer. The existing phrase parser is preserved behind the secondary **Ввести фразой** disclosure and transfers a confirmed candidate into the structured fields.
- `CalendarEditorDestination` is a UI-internal typed model (`id`, `label`, `color`, `writable`, `providerKind`). Today the route passes only its real writable LOCAL-ONLY destination. A later #105 integration can pass actual writable provider calendars into the same selector/form. The route still guards submission to the current local destination until its backend contract changes.
- `CalendarTimePicker` has separate 24-hour and 00–59 minute columns. The selected value is centered between adjacent tap targets; wheel/trackpad and keyboard arrows/Page/Home/End work. Quick minute buttons offer :00/:15/:30/:45 without restricting exact minutes. Presets are 15/30/60/120 minutes. A preset recomputes end from start; manual end changes clear the preset.
- Create defaults to the selected Calendar day. Edit prefills title, notes, location, all-day state, dates, and times from the current object. All-day editing shows the inclusive last day and emits the contract's exclusive `end_date_exclusive`; timed UTC fields are null. Timed editing emits UTC start/end and null date fields. Conversion uses the existing explicit timezone conversion in `reminderUtcFromLocal`, with the reverse `localDateTimeForUtc`; ambiguous/nonexistent local times are rejected. No browser-local `new Date("YYYY-MM-DDTHH:mm")` conversion is used.
- Detail leads with title/date/time/location/notes. Calendar/provider/sync/freshness/timezone/overlap remain below. Existing event interaction is event-row click → detail sheet → **Изменить** → prefilled structured editor. External events say **Только просмотр**. Detail Edit/Delete and editor Cancel/Save use the real `Sheet` footer. The existing overlay handles focus trap, inert background, focus restore, backdrop, and visual viewport.
- Settings → Календари now exposes a compact **Маркеры событий** selector (**Точки** / **Полоски**) above source refresh and per-calendar colors. It persists in the existing `calendar-display-colors.json` document through the bounded `PATCH /api/v1/settings/calendar/event-marker-style` route. Both color and style updates use the same revision-checked atomic store and preserve the other setting.
- Existing conflict/uncertain mutation semantics are retained. Conflict keeps the editor open, disables another save, and offers explicit readback; there is no automatic retry. Canonical successful objects reconcile the list/detail. Delete keeps its confirmation flow.

## Verification

- Unit coverage includes timezone conversion, edit prefill, all-day exclusive end, duration across midnight, parser transfer, and DST gap rejection.
- The Slice 3 browser gate checks 1280×720 DPR 1.5 geometry, six-week month, scroll, colored calendars, all-day, long Russian title, compact overlap/status column, stale source, dots and bars on the same selected day, Settings marker selector, day/night sheets, read-only external detail, touch tap/wheel/keyboard, preset/manual override, reduced motion, backdrop and narrow viewport footer reachability. Overview regression coverage asserts the marker remains a 4px vertical bar under both Calendar preference modes.
- Browser mutation coverage performs LOCAL-ONLY create, edit, delete, and reload/readback with canonical API envelopes and `If-Match`; it asserts external events never receive mutation requests. This is a controlled Panel Agent API fixture, alongside the existing B4/backend contract gates, not a claim of live iCloud writing.
- CI uploads `issue-279-calendar-review-${{ github.sha }}` containing day/night Calendar dots and bars, selected-day comparisons, compact overlap, Settings selector, mutable detail, and clicked-row → Edit screenshots. Screenshots are review artifacts; geometry and state assertions are automated.
- Local gates passed: `npm run lint` (0 errors, 46 pre-existing Fast Refresh warnings), `npm run typecheck`, `npm run test:unit` (444), `npm run build`, and Panel Agent `test_planning_b43.py` (5). The B3 Planning route suite passed 11 tests; B4 Calendar writer passed 10 (2 conditional skips), Planning foundation passed 3, and the iCloud/month/Calendar Settings/shell/overlay group passed 27 (1 conditional skip). The Slice 3 enabled-dot gate passed 3 (1 conditional skip), and the disabled-dot gate passed 1.
- A physical Samsung review remains useful for judging the dot treatment and native date-input appearance. Automated checks cover the viewport geometry and mutation state, not human visual approval.

## Out of scope

Settings Slice 4, #278, Weather assets, Coffee changes, provider mutation APIs, Panel Agent provider proxy, AliceTG_Bot PR #34, Apple credentials/accounts, and real iCloud writes.
