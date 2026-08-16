# ISSUE #82 — Full Access and touch input lock audit

This change is based on `85a30112c55e506b335af7ea563e1e0d180b132e` and is
implemented on `agent/v2-full-access-touch-lock`.

## Decision and trust boundary

The Panel Agent is the source of truth for both authorization and the
confirmation ceremony. `GET /api/v1/access` now returns:

```json
{
  "confirmationPolicy": {
    "actionConfirmationRequired": false,
    "mode": "manual_persistent_full"
  }
}
```

The policy is derived from persisted state, never from a browser-controlled
profile flag:

| `baseProfile` | `effectiveProfile` | `temporaryFull` | UI/phrase ceremony |
| --- | --- | --- | --- |
| `standard` | `standard` | `false` | required |
| `standard` | `full` | `true` | required |
| `full` | `full` | `false` | waived |

The waiver only removes the redundant confirmation ceremony. Capability
authorization, server-side gates, integration availability, cooldowns,
revision checks, fixed operation mapping, and execution verification remain
active. The browser reads the explicit `confirmationPolicy` field and fails
closed when it is absent. It does not infer policy from `baseProfile` or
`effectiveProfile`, and it never fabricates `RESTART MAIN` or `DEPLOY MAIN`.
Every registered confirmation call performs a fresh `GET /api/v1/access` via
the AccessProvider before considering the waiver, even when the normal header
or Settings cache is populated. A failed or unavailable refresh falls back to
the existing confirmation ceremony and cannot waive it.

For AVALAR Main restart/deploy, Panel Agent applies the same server-owned
policy before checking the strong phrase. Temporary Full therefore still
requires the phrase; manually persisted Full does not. No external technical
protocol required an additional phrase or confirmation field: the downstream
fixed SSH runner receives only the already-authorized operation.

## Mutation surface audit

Every browser mutation path is protected by the shared
`useInteractionLock().guardMutation()` boundary. Confirmation-required paths
also pass through `ActionConfirmationProvider`, which applies the server
policy centrally.

| Surface | Mutations | Access capability / server gate | UI confirmation | Interaction-lock gate |
| --- | --- | --- | --- | --- |
| Home Assistant coffee | on/off; timing; notification settings | `home.coffee.control`, `home.coffee.settings.*`; existing coffee gates | existing coffee-on confirmation; no new ceremony in manual Full | `App.tsx`, `CoffeeSettings.tsx` |
| Planning reminders | create, edit, complete, cancel | `planning.reminders.*` plus B4 writer gates | complete/cancel catalog entries | `PlanningRoutes.tsx` immediately before each request |
| Planning tasks | create, edit, complete, archive | `planning.tasks.*` plus B4 writer gates | complete/archive catalog entries | `PlanningRoutes.tsx` immediately before each request |
| Planning calendar | create, edit, delete | `planning.calendar.*` plus B4 writer gate | delete catalog entry | `PlanningRoutes.tsx` immediately before each request |
| AVALAR | Stage/Main smoke, restart, deploy | action capability, action availability, integration and per-action gates | Stage restart/deploy simple; Main restart/deploy strong; manual Full bypasses only this ceremony | `AvalarActions.tsx` before availability and immediately before POST |
| ASUS ROG G703 | hibernate, wake | server action availability and existing runtime gate | hibernate catalog entry | `RogG703Controller.tsx` |
| System runtime | hide and shutdown | kiosk-control intent and runtime availability | shutdown catalog entry | `RuntimeControls.tsx` |
| Connectivity | restart | connectivity availability and action gate | existing no-catalog behavior | `ConnectivityActions.tsx` |
| Weather | add, rename, delete, set default, reorder | existing weather writer API/gates | existing no-catalog behavior | `Weather.tsx` provider, before each write |
| Overview editor | save layout | `PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED` and API validation | existing no-catalog behavior | `OverviewPage.tsx` before PATCH |
| Access policy | temporary unlock, profile change, clear temporary Full | PIN and Panel Agent policy API | PIN prompt | `AccessControls.tsx` |
| Fixture registry | add fixture service | development fixture route only | none | `App.tsx` |

The kettle action remains a registered confirmation catalog item but has no
current dashboard mutation caller. Planning parse and weather preview are
POST requests that only parse/preview user input; they do not persist or
execute a device/system mutation and remain available while locked. All
status, availability, snapshot, SSE, health, and navigation/read calls remain
available while locked.

## Interaction lock

The lock is intentionally separate from authorization and is not persisted.
It has one provider, one hold state, and one mutation guard:

- opt-in `VITE_TOUCH_INPUT_LOCK_ENABLED`, default `false`;
- when enabled, the production-style build starts locked unless
  `VITE_TOUCH_INPUT_LOCK_START_LOCKED=false` is explicitly supplied;
- a primary pointer or Space/Enter keyboard hold toggles the state after
  exactly 1000 ms;
- a short tap, a second pointer, pointer cancellation, blur, or a different
  key release cannot toggle it;
- visible progress, `Удерживайте…` / `Почти готово…`, lock status, keyboard
  semantics, focus styling, and reduced-motion-safe feedback are provided;
- under `prefers-reduced-motion: reduce`, the 1000 ms timer remains precise but
  the continuously changing fill is hidden; the static rail and stepped text
  are the visible cue;
- lock/unlock uses the same control and gesture;
- the overlay is a visual affordance only so reads and navigation remain
  inspectable; `guardMutation()` is the actual no-mutation boundary.

There is no reliable browser-visible kiosk signal in the current runtime, so
the rollout uses an explicit build flag rather than guessing from user agent,
viewport, or fullscreen state. This PR leaves production rollout off.

## Verification

- `apps/panel-agent/tests/test_access_policy.py` covers Standard, temporary
  Full, persisted manual Full, and fail-closed recovery.
- `apps/panel-agent/tests/test_avalar_actions.py` covers temporary Full phrase
  enforcement and manual Full Main restart without a phrase.
- `apps/dashboard/src/interactionLockGesture.test.ts` covers the 1000 ms
  threshold, short tap cancellation, same-owner release, and keyboard holds.
- `tests/e2e/v2-full-access-touch-lock.spec.ts` covers Standard modal behavior,
  manual Full immediate simple/strong actions, zero POSTs while locked,
  navigation while locked, keyboard unlock, reduced motion, and review
  screenshots.

The focused browser job runs only with the opt-in lock flag and uploads
`v2-full-access-touch-lock-review-${GITHUB_SHA}` screenshots. It is wired into
CI, but this change does not enable the lock in production.
