# Portrait operating mode (#322)

Status: implemented for browser review; physical Samsung acceptance is pending.
Base: `e210afcf6dd22d175aee4648c29d618ff744db8e` (origin/main inspected before branching).
Branch: `agent/portrait-9-16`. No production settings, infrastructure or device state changed.

## Discovery and responsive policy

The previous width-only 12/8/4 projection did not make portrait complete. At
720×1280 the shell required horizontal navigation/header scrolling; widgets
whose minimum logical width exceeded four columns displayed unsupported-profile
fallbacks. Home's narrow stacked coffee artwork occupied nearly an entire screen.
The original desktop rail, typography, tokens, confirmations and device action
contracts are retained.

Portrait follows the **CSS layout viewport** `(max-aspect-ratio: 1/1)`, including
square transition windows. No hardware pixels, device names, DPR or orientation
API determine the mode. CSS and React share the same media query. Visual keyboard
insets continue through the existing `useVisualViewport` / Sheet implementation.
There are no writes, reloads or route changes on resize/rotation.

In portrait the shell has a compact two-row header and a 48px “Разделы” control.
The existing Sheet provides a focus-trapped navigation drawer containing all 12
routes (including Apps and Backups). Its route buttons are at least 56px tall.
Escape restores focus; rotating an open navigation sheet to landscape closes it
and focuses the active desktop navigation link (or the current route surface for
routes without a desktop rail link). Route content is the primary
vertical scrolling surface; the header stays outside that surface. Sheets retain
an independently scrollable body and visible header/footer for keyboard use.

Overview uses four physical columns below 900px of measured **workspace** width,
eight above. On four columns cards occupy the full width; on eight columns small
logical variants (width <=4) can share a row. Placement follows canonical y/x/id
order, never backfills earlier gaps, skips hidden items and retains the selected
variant. Card height grows from its registered logical size and intrinsic content;
there is no whole-page scale-to-fit. All 11 registered widget types remain visible,
including ROG/health widgets with minimum widths >4. The three existing structural
slots (weather alert, calendar agenda, task list) retain the same prepared-state
renderers as landscape; this change does not introduce new providers for them.
Malformed/unknown records
still have an observable fallback. Home stacks full-width device cards with bounded
coffee artwork. Calendar month and selected-day panes stack in portrait at every
width, including larger/scaled viewports; System zones stack as well.

## Independent persistence and rollback

The existing landscape `GET/PATCH /api/v1/overview/layout`, file and
`overview.layout.v2` schema are unchanged. Portrait adds the fixed resource
`GET/PATCH /api/v1/overview/layout/portrait`. Its response and file have an envelope:

```json
{
  "schemaVersion": "overview.portrait.v1",
  "profile": "portrait",
  "layout": { "schemaVersion": "overview.layout.v2", "viewportClass": "landscape-12", "items": [] }
}
```

The abbreviated `layout` above uses the unchanged, strictly validated **logical
12-column canvas**, including existing profile/preset metadata. `viewportClass`
inside it describes that logical coordinate system, not the physical screen.
The outer version/profile identify the independent portrait resource. Patch body
remains `{ "items": [...] }`; server-owned fields cannot be supplied by the browser.

For `PANEL_OVERVIEW_LAYOUT_PATH=/trusted/overview-layout.json`, the portrait file is
`/trusted/overview-layout.portrait.v1.json`. It is a fixed sibling; no arbitrary path
or upstream is accepted. Each resource has its own revision and ETag/If-Match.
Missing portrait state seeds a deep copy of the current landscape with revision 0;
**GET never creates or migrates either file**. Only explicit portrait Save writes
its sibling atomically. Future reads/restarts use that portrait file independently.
A corrupt/unknown-version sibling shows recovery metadata and preserves its bytes
until an explicit valid save. The portrait file is an optional allow-listed source
in Panel Configuration backups.

Rollback to an older release uses the untouched landscape v2 file and ignores the
sibling. Returning to this release restores the portrait layout. There is no
breaking migration, destructive conversion or down-migration step.

Portrait Save requires the global write gate, existing Overview narrow/effective
capability gate, `overview.layout.edit` at Standard/Full, and the UI touch lock.
Read Only remains available. New capability metadata is served by the existing
access policy. Device/Planning/Todoist permissions and confirmations are unchanged.

## Editor and rotation

Portrait dragging reorders visible cards vertically; the move menu supplies the
same Up/Down operation for keyboard users. Resize opens the registered-size menu,
which changes only the portrait draft. Picker, remove, appearance, reset, cancel
and explicit Save remain available. Touch handles are 48px and stay within the
card. Rotation/resize/pointer cancellation cancels an in-flight drag without
committing it.

While an edit/save/uncertain result is active, the **profile destination is pinned**
to the profile where editing began. Rotation reflows the view, retains the draft
and selection, and displays the profile label. Finish/cancel before switching to
the other profile. A pending Save stays disabled and is never resent on rotation.
Existing uncertain-write readback and conflict behavior remain in effect.

## Browser evidence and validation

`tests/e2e/portrait-322.spec.ts` covers 720×1280, 768×1366, 1080×1920,
540×960 (scaled CSS viewport) and canonical 1280×720; all 12 routes, nav/focus,
critical target geometry, all supported widget variants, editor persistence and
profile isolation, repeated rotation with a task draft/pending command, and
visual-viewport keyboard simulation. API calls are local fixtures/mocks; no real
Todoist, HA, Planning or other production mutations are used.

Before screenshots were captured from the base on all 11 key routes at 720×1280
and 1280×720. After screenshots cover those and Apps plus the additional sizes.
CI uploads `portrait-322-<sha>` browser evidence. The delivery archive additionally
contains the local before/after captures. Dynamic clock/fixture freshness can vary;
geometry and the production browser gates are the regression assertions, rather
than pixel equality against time-sensitive screenshots.

Run the portrait CI profile with V2 shell/Overview/editor enabled, all B2/B3
Planning route flags enabled, Calendar mutation build flag enabled, and touch lock
enabled but initially unlocked (see `.github/workflows/ci.yml`). Run `npm run check`
and the existing feature-specific browser gates with their documented CI flags.

## Physical Samsung acceptance (owner; issue stays open)

Read-only attempt `ssh -o BatchMode=yes -o ConnectTimeout=5 control-panel-pc hostname`
failed because the alias did not resolve in this environment. No physical viewport
or display scale has been claimed, and Windows orientation has not been changed.

1. After review/merge, update using the existing Settings → System update flow or
   the documented Windows updater; record the installed commit. Keep the previous
   known-good version for the standard rollback. No new production env setting is
   required for portrait; Overview editor still needs its existing write gates.
2. Record Windows display scale, Edge/Chromium kiosk mode, `innerWidth`, `innerHeight`,
   `visualViewport.width/height` and DPR (these diagnostics contain no secrets).
   Rotate through Windows locally with the owner's approval; record actual CSS
   dimensions, including taskbar/kiosk effects.
3. Visit all 12 routes in both themes. Verify nav, header/access/lock, notices,
   diagnostics/logs, PIN and confirmation dialogs, and all actions remain readable
   and reachable with vertical scrolling, without sideways panning.
4. Check coffee, kettle Stop, Station/music, AC/selectors and lighting. Use fixture
   mode for action rehearsal; any real device operation needs the owner's normal
   deliberate confirmation. Offline/stale/unavailable states must remain truthful.
5. In portrait, reorder, resize, hide/add and change widget appearance; Save, restart
   in portrait and verify persistence. Rotate back: saved landscape positions and
   sizes must remain unchanged. Rotate repeatedly with a draft and during a pending
   request: no duplicate command, lost field, or bypassed disabled control.
6. Calendar: select month/day, expand day, create/edit a local test event deliberately
   if desired; Tasks/Reminders: filters, lists, forms, pagination. Open the Windows
   touch keyboard, scroll long dialogs and reach Cancel/Save; test physical drag,
   resize menu, 48px taps, Tab/Escape and reduced motion.
7. Leave the panel in the owner's chosen orientation and restart the kiosk. Record
   pass/fail, viewport, commit and any defect before closing #322. Browser automation
   is not physical Windows/Samsung acceptance.
