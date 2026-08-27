# B4 Phase 1 — reminder mutations

This change adds the Control Center side of the reminder mutation contract:

- create;
- edit;
- explicit complete;
- explicit cancel.

Physical reminder deletion is intentionally not exposed. The canonical B4
contract defines cancellation as the lifecycle tombstone, and AliceTG_Bot does
not expose a reminder-delete operation.

## Authority and dependency

AliceTG_Bot SQLite remains the only Planning source of truth. Control Center
holds only bounded read projections and transient UI state. This PR consumes
the existing AliceTG_Bot A4 routes from `docs/PLANNING_API_A4.md` and
`docs/PLANNING_V1_CONTRACT.md`; no AliceTG_Bot code or PR is required for this
phase.

The Panel Agent uses fixed internal paths and forwards the canonical object
response. The browser can call only the same-origin, action-specific routes:

| Operation | Control Center route | Canonical operation |
| --- | --- | --- |
| create | `POST /api/v1/planning/reminders` | `POST /internal/planning/v1/reminders` |
| edit | `PATCH /api/v1/planning/reminders/{id}` | `PATCH /internal/planning/v1/reminders/{id}` |
| complete | `POST /api/v1/planning/reminders/{id}/complete` | `POST /internal/planning/v1/reminders/{id}/complete` |
| cancel | `POST /api/v1/planning/reminders/{id}/cancel` | `POST /internal/planning/v1/reminders/{id}/cancel` |

There is no generic action endpoint, provider URL, action ID, shell, proxy, or
browser secret. The Panel Agent authenticates the fixed upstream transport.

## Safety rules

Both gates must permit a writer before any control is rendered:

1. `VITE_PLANNING_REMINDER_MUTATIONS_ENABLED=true`;
2. the server/deployment reminder writer gate is enabled; it is exposed to the
   browser as `planning.reminderMutationsEnabled`;
3. the current canonical Planning status advertises the specific reminder
   capability (`create`, `update`, `complete`, or `cancel`).

The feature gate is false by default. Stale, degraded, or unavailable
canonical status suppresses controls. Delete/archive, voice, and provider-sync
remain false. Cancellation is the canonical logical tombstone; there is no
physical reminder-delete route.

Every mutation carries an idempotency key. Edit and lifecycle actions carry
both `If-Match` and the expected object version. The Panel Agent enforces
strict request bodies, fixed UUID targets, authentication, and deterministic
conflict/error mapping.

The browser does not optimistically declare success. A timeout or transport
failure becomes `uncertain`; it is reconciled by bounded canonical readback.
If readback finds the object, the canonical object replaces local state but the
NoticeCenter still reports a warning, not success. A confirmed mutation uses
the returned canonical object as the new selected state.

Delivery remains independent from lifecycle. In particular,
`status=due` with `delivery_state=delivered` remains active until the user
explicitly completes or cancels it.

## Save surfaces

Create uses the existing Sheet, NoticeCenter, and OSK-compatible surface. Free
text is sent to the canonical parser preview and rendered as a human
restatement with visible ambiguities and proposals. Save stays disabled until
the preview is a high-confidence, unambiguous reminder proposal. Vague time
expressions such as `вечером` are not silently interpreted.

Edit is initialized from the canonical reminder object and supports text,
details, and explicit date/time/timezone fields. `Перенести` uses the same
versioned edit route but presents only the scheduling fields. Explicit local
wall-clock values are converted to UTC only when the timezone resolves to one
unambiguous instant.

Tasks, calendar mutations, iCloud/CalDAV, TickTick, and snooze presets are
outside this phase. Manually selected persistent Full Access follows #82:
allowed reminder actions do not open a second confirmation modal; Interaction
Lock remains an independent mutation guard.
