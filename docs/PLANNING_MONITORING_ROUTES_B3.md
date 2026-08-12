# Planning monitoring routes — B3

B3 adds read-only monitoring surfaces for Tasks, Calendar, and Reminders on top of the merged B1 Panel Agent adapter and B2 Overview card. It does not add a mutation proxy, parser flow, provider sync, or a new navigation rail item.

## Rollout gates

The routes are independently rollbackable and all default to disabled:

```text
VITE_PLANNING_TASKS_ROUTE_ENABLED=false
VITE_PLANNING_CALENDAR_ROUTE_ENABLED=false
VITE_PLANNING_REMINDERS_ROUTE_ENABLED=false
```

With a flag off, `/tasks` or `/calendar` keeps the existing placeholder. `/reminders` redirects to Overview and is not exposed. B2 remains controlled independently by `VITE_PLANNING_OVERVIEW_ENABLED`.

Tasks and Calendar retain their permanent rail entries. Reminders is an internal monitor route only: it is reached from the B2 reminder row or the Tasks secondary affordance, and never becomes a primary or secondary rail item.

## Read architecture and truthfulness

The global Dashboard snapshot remains a bounded Overview summary. Full route pages use a small frontend client in `apps/dashboard/src/planningReadClient.ts` and fixed same-origin GET paths:

```text
GET /api/v1/planning/tasks?view=...&projectId=...&limit=...&offset=...
GET /api/v1/planning/events?from=...&to=...&limit=...&offset=...
GET /api/v1/planning/projects?limit=...&offset=...
GET /api/v1/planning/reminders/view?view=...&limit=...&offset=...
```

The client has no arbitrary URL, method, header, browser secret, generic proxy, or response-body logging. Query changes abort the prior request, and late responses are ignored. Every response is checked against the exact `planning.panel.v1` list envelope and the browser-safe item projection. Limits are bounded to 100; the UI uses pages of 20.

The derived reminder view is the narrowest Panel Agent extension needed for truthful monitor semantics. It composes fixed GET reads of the existing reminder route, scans at most one bounded upstream page (never more than 100 items per lifecycle read), de-duplicates by canonical ID, and returns stable pagination metadata. It does not change AliceTG_Bot and has no write route.

Route reads are authoritative for the displayed page. A `503 planning_read_unavailable` is not converted into an empty page. If a last-good global Planning snapshot exists, the route may show a clearly labelled `Последние данные · краткий снимок`; it disables route pagination and project filtering because the snapshot is incomplete. Without that bounded snapshot, the route shows an unavailable/error state with Retry. Empty is reserved for a successful, valid response with zero matching items.

One shared route health component presents `current`, `degraded`, `stale`, `offline`, and `unavailable`. Relative labels advance only for current data. Stale/offline preview semantics use the canonical generated/synced timestamp and are not made to look live.

## Tasks

`/tasks` has three segments mapped directly to B1 views: `Сегодня` → `today`, `Просрочено` → `overdue`, and `Скоро` → `upcoming`. Rows show title, due semantics, priority, project/source labels, and open a reusable read-only detail sheet.

Date-only tasks preserve the contract shape `dueDate != null`, `dueTime = null`, `timezone = null`; the UI shows a calendar date and never invents `00:00`, midnight, or UTC. Timed tasks show their supplied IANA timezone. Priority is rendered from the contract (`high`, `normal`, `low`, `none`) rather than inferred from title text.

The `Проект` touch sheet reads `/projects` with the same bounded pagination and offers `Все проекты`, loaded projects, selection state, and close. The selected project is sent as `projectId` on task reads. A missing/tombstoned project is rendered as `Проект недоступен`, never as an invented name. There is no permanent project sidebar.

## Calendar

`/calendar` has `Сегодня` and `Повестка`. Today requests one explicit local day; Agenda requests a bounded seven-day local-date window with Previous/Next navigation. Ranges are converted by the generic IANA-aware helper in `calendarRange.ts`: local midnight → UTC for both boundaries. The implementation does not use browser timezone, local `Date` midnight, UTC+3 arithmetic, or a fixed 24-hour assumption. Moscow and Berlin 23-hour/25-hour DST days are covered by unit tests.

Today keeps the full timed history: past events remain visible but are visually subdued, the running event is distinct, and future events remain normal. All-day items have a separate band. Agenda groups by local calendar date, places all-day items before timed items, sorts timed items chronologically, and uses ID as a stable tie-breaker. Ranges remain within the B1 366-day boundary.

Overlaps are computed only among loaded timed events using half-open intervals `[start, end)`. A boundary where one event ends exactly when another starts is not an overlap. Valid overlaps are marked `Пересекается`; they are not described as provider conflicts. Calendar details show all-day/timed shape, range, IANA timezone, source label, sync state, and the overlap marker. Current B1 data is truthfully shown as `local_only`; no Google/iCloud/Exchange/provider filter is fabricated because the contract does not expose a complete multi-provider result set.

## Reminder monitor

`/reminders` is a monitor-only route with `Скоро`, `Пропущено`, and `Доставка` views. It has no rail entry. Every row shows title, current relative due label when appropriate, exact due time, lifecycle, delivery state, timezone/source, and opens a read-only detail sheet.

The lifecycle and delivery dimensions remain distinct:

- `Скоро`: active `pending`/`due` reminders with a future due time; completed and cancelled items are excluded.
- `Пропущено`: active `pending`/`due` reminders whose due time has passed. This includes queued, retrying, failed, and delivered-but-open reminders.
- `Доставка`: delivery attention only: `queued`, `retrying`, and `failed` due reminders. `delivered` is not a failure and is excluded from this view.

`status=due` plus `deliveryState=delivered` is displayed as `Доставлено · ждёт завершения` with an `Открыто` marker. It remains active until the lifecycle is completed. No Complete, Cancel, Snooze, Retry, Edit, Delete, Add, or archive control is rendered. Stable ordering is due time then ID for lifecycle views; delivery attention prioritizes failed/retrying/queued and then uses due time/ID within the bounded result.

Reminder pagination is finite and explicit. The Panel Agent derived helper requests the relevant fixed lifecycle reads, applies the lifecycle/delivery predicate server-side, de-duplicates, sorts, slices the requested offset/limit, and carries `hasMore` from both the composed result and bounded upstream page metadata. It never scans without a hard page budget and never presents a filtered single snapshot page as complete.

## Shared touch sheets and safety

Tasks, Calendar, and Reminders use the same read-only sheet shell. It provides a 56px close target, focus placement, Escape support, modal semantics, scroll containment, and no keyboard/OSK dependency. Route controls and rows are at least 48px at the canonical 1280×720, DSF 1.5 touch viewport. Reduced, low-performance, and battery-saving modes avoid blur-heavy effects. Long Russian and hostile-looking titles remain inert text; the UI uses normal React text rendering and does not interpret URLs, service names, shell paths, or markup.

## Rollout and rollback

Enable one route at a time in a frontend build after local/CI fixture validation. Roll back a route by setting its flag to `false`; B2 can remain independently enabled. Keep real Planning credentials and production flags off until a separate release decision. No Samsung deployment is part of B3.

B4 owns create, edit, complete, cancel, archive/delete, parser confirmation, mutation proxy, and any future mutation-specific controls. B4 has not been started in this change.

## Deferred decisions preserved

The following execution-plan items remain deferred and are not changed by B3:

- `PERIODIC_BACKUP_SCHEDULER_PENDING`
- `STRONG_CONFIRMATION_TOUCH_REPLACEMENT_DECISION_PENDING`
- `SAMSUNG_DEFAULT_PERFORMANCE_TRACE_DEFERRED`
- `SNOOZE_PRESET_PRODUCT_DECISION_PENDING`
- `TELEGRAM_TASK_EVENT_CREATION_PRODUCT_DECISION_DEFERRED`
