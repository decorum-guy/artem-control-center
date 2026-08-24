# Production feature-gate inventory

Base audited: `2b18ea4d5c9736d7dad77ac8d00ec6a4893655d9`.

The frontend still keeps explicit environment seams so tests and fixture
profiles can exercise both sides of a rollout. Normal Windows install/update
uses only the source-controlled `accepted-v2` profile through
`npm run build:production`; the Samsung does not maintain frontend `VITE_*`
values.

## A — accepted V2 production functionality

These build flags are forced to `"true"` by
`scripts/production-build-profile.mjs`:

| Flag | Product surface |
| --- | --- |
| `VITE_V2_VISUAL_SHELL` | V2 shell and grouped Planning navigation |
| `VITE_OVERVIEW_V2_ENABLED` | V2 Overview |
| `VITE_OVERVIEW_EDITOR_ENABLED` | Overview `Настроить`, persistence and appearance UI; server writes remain policy-gated |
| `VITE_PLANNING_OVERVIEW_ENABLED` | Planning Overview card |
| `VITE_PLANNING_TASKS_ROUTE_ENABLED` | Tasks route |
| `VITE_PLANNING_CALENDAR_ROUTE_ENABLED` | Calendar route |
| `VITE_PLANNING_REMINDERS_ROUTE_ENABLED` | Reminders route |
| `VITE_PLANNING_REMINDER_MUTATIONS_ENABLED` | B4 reminder mutation controls; server capability/access policy still applies |
| `VITE_PLANNING_TASK_MUTATIONS_ENABLED` | B4 task mutation controls; server capability/access policy still applies |
| `VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED` | B4 local-only calendar mutation controls; `localOnlyMutable` and server policy still apply |
| `VITE_TOUCH_INPUT_LOCK_ENABLED` | #82 touch/keyboard interaction lock |
| `VITE_TOUCH_INPUT_LOCK_START_LOCKED` | Reviewed kiosk start state: locked, with the existing one-second hold-to-unlock gesture |

The accepted Weather, Home, Services, System, Settings, ROG and Coffee/HA
surfaces do not have frontend V2 rollout flags beyond the shell/route flags
above. Their provider availability and writes remain Panel Agent runtime
configuration and access policy.

## B — unfinished future functionality

- TickTick has no provider gate and no external provider implementation in the
  production profile. The rollout does not add or fabricate one.
- Apps and Backups remain placeholder routes and are deliberately absent from
  the V2 primary/secondary navigation arrays.
- Future Planning mutation capability slots and synthetic review routes remain
  source-controlled registry/test surfaces, not production navigation.
- AVALAR deploy/restart, ROG hardware actions, Coffee/HA writes, Planning
  upstream enablement, and Overview persistence are not independently
  authorized by the frontend profile; their runtime policy remains separately
  configurable.

## C — fixture/dev/test-only gates

- `import.meta.env.DEV` / `import.meta.env.PROD` control fixture scenarios,
  development query parameters, the widget gallery, dev notices and fixture
  fault injection. The gallery renders a production-disabled message and is
  not a product route in production.
- `VITE_*` values supplied directly by Playwright/CI are test seams. The
  `B2_PLANNING_*` and `B3_PLANNING_*` names are test aliases only; they are
  translated into the real Vite flags by `playwright.config.ts`.
- `PANEL_FIXTURE_WRITES_ENABLED`, `PANEL_AGENT_RELOAD`, fixture scenarios,
  `PANEL_PLANNING_FIXTURE_SCENARIO`, and test artifact directory variables are
  fixture/test controls. Production runtime keeps fixture writes disabled.
- `CI`, `V2_*_ARTIFACT_DIR`, `B*_ARTIFACT_DIR`, `PR9_ARTIFACT_DIR`,
  `TOUCH_LOCK_ARTIFACT_DIR`, `ARTEM_REVIEW_URL` and the iCloud Phase B artifact
  variable only affect test/review execution or artifact placement.

## D — safety/runtime policy that remains configurable

The following are intentionally not converted into build-time product flags:

- `PANEL_AGENT_MODE`, `PANEL_WRITES_ENABLED`,
  `PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED`, and the three Coffee write gates;
- `PANEL_PLANNING_ENABLED` and the three server-side Planning mutation gates,
  plus Planning credentials, cache, freshness, timeout, polling and timezone
  settings;
- access-policy path/audit path/temporary-duration settings and the persisted
  Panel Agent access profile;
- Home Assistant and Alice URLs/tokens/freshness/cache settings;
- AVALAR URLs, SSH/action enablement, action-specific enablement, timeouts and
  output limits;
- ROG enablement, companion URL/secret, hardware identity and cooldown/polling
  limits;
- runtime supervision (`LOCALAPPDATA`, dashboard dist, command path), SSE,
  HTTP, weather and integration refresh/timeout/backoff limits.

These controls remain server-authoritative. A frontend build exposing a
mutation surface never grants capability, bypasses confirmation, changes
access mode, removes the touch-lock guard, or permits writes to imported
external calendar events. Native B4 local mutations remain available when the
server reports the required capability and the event is local-only, even when
an imported iCloud source is current, stale or in error.
