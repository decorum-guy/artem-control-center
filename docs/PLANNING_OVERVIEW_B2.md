# Planning Overview card — B2

B2 adds the first visible Planning surface: one read-only `Дела` card on
`/overview`. It consumes only `snapshot.planning` from the existing
SnapshotCoordinator/SSE flow. It does not call Planning list routes, create a
second event stream, poll from React, or expose Planning write capabilities.

## Rollout gate

The frontend card is gated by:

```text
VITE_PLANNING_OVERVIEW_ENABLED
```

The default is `false`, including production builds. With the flag off,
Overview keeps the pre-B2 `Дальше`/`Задачи` placeholders and service attention
surface. With the flag on, a present `planning.panel.v1` snapshot renders the
card; an absent block renders a truthful unavailable state.

Fixture/e2e runs opt in explicitly. The Playwright command is:

```text
B2_PLANNING_OVERVIEW_ENABLED=true npm run test:e2e -- tests/e2e/b2-planning-overview.spec.ts
```

Its synthetic fixture webserver uses:

```text
VITE_PLANNING_OVERVIEW_ENABLED=true
PANEL_PLANNING_ENABLED=true
PANEL_PLANNING_BASE_URL=http://fixture.test
PANEL_PLANNING_INTERNAL_SECRET=synthetic-internal-secret
PANEL_PLANNING_SECRET=synthetic-panel-agent-secret
```

The Planning credentials above are synthetic fixture values only. No real
Planning credentials or AliceTG_Bot/Home Assistant changes are required.

## Summary rules

- Reminder: select only active `reminders.upcoming` objects (`pending` or
  `due`), never `deliveryFailures`, completed, or cancelled objects. Current
  data shows a bounded local relative label and a visible exact local time;
  stale/offline data show a frozen semantic exact-time label.
- Task: select from `tasks.overdue` by `high`, `normal`, `low`, `none`, then
  canonical due ordering and stable ID. Counts are `0`, `1..19`, or `20+`
  because the global list is capped at 20.
- Calendar: choose from `calendar.today`, falling back to
  `calendar.upcoming`. Timed events show local time; all-day events show
  `Весь день`.

Source health is combined into one card indicator: degraded `Есть проблемы`,
stale `Данные от HH:MM`, and offline `Актуальные данные недоступны` with the
last-good time when available. Only current snapshots receive a local,
presentation-only 30-second relative-label timer. The timer never changes the
dashboard snapshot or its revision and is stopped for stale/offline data.

## Fixture coverage

The deterministic Panel Agent fixture transport includes B2 scenarios for
healthy/current, empty, soon reminders, lifecycle/delivery states, task
priorities, bounded 20-item overdue lists, timed/all-day events, degraded
status, long Russian inert text, and delivered-but-open reminders. The frontend
fixture matrix also covers stale/offline last-good and no-data presentations as
well as a semantic SSE replacement pair.

The existing deferred operational/product items remain deferred, including
`PERIODIC_BACKUP_SCHEDULER_PENDING`,
`STRONG_CONFIRMATION_TOUCH_REPLACEMENT_DECISION_PENDING`,
`SAMSUNG_DEFAULT_PERFORMANCE_TRACE_DEFERRED`,
`SNOOZE_PRESET_PRODUCT_DECISION_PENDING`, and
`TELEGRAM_TASK_EVENT_CREATION_PRODUCT_DECISION_DEFERRED`.
