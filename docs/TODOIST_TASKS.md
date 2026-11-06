# Todoist Tasks — issue #321

Todoist is an opt-in authoritative source for `/tasks`. It has its own typed
Panel Agent adapter, resource IDs and API; it never enters Planning UUID models.
Calendar, Reminders and the Overview `Дела` slice continue using Planning.
The Todoist source is shown explicitly on the Tasks page. No public endpoint,
VPS relay, Caddy change or AliceTG_Bot configuration is required.

## Discovery and topology

- Fetched `origin/main`: `2e2b663174680ab6f7441f651b6b4af9a8f401ad`.
- Working tree was clean; implementation branch: `agent/todoist-tasks-integration`.
- Read root AGENTS.md, README, design direction, Windows runtime documentation,
  Planning adapter/API/settings/access middleware, route config/registry/read
  client, PlanningRoutes, App and Shell. The Tasks navigation entry already
  exists independently of the legacy Vite route flag. Only App's Tasks renderer
  needs a runtime source boundary; the large PlanningRoutes stays unchanged.
- `ssh -o BatchMode=yes -o ConnectTimeout=5 control-panel-pc hostname` failed
  because the hostname could not be resolved in the implementation environment.
  Samsung DNS/TLS/Todoist connectivity and its actual process configuration
  therefore remain **unverified**. No conclusion about Samsung network blocking
  can be drawn from this failure. No relay was introduced.
- Documented production process: `production-runtime.mjs` starts localhost
  Uvicorn/Panel Agent on `127.0.0.1:8787`; protected configuration is
  `%LOCALAPPDATA%\ArtemControlCenter\runtime.env` (see
  [Windows runtime](WINDOWS_PRODUCTION_RUNTIME.md)). This was established from
  repository documentation, not inspection of the physical machine.

## Official API evidence

Checked [Todoist API v1](https://developer.todoist.com/api/v1/) on 2026-11-06.
Only `https://api.todoist.com/api/v1/` is used. Requests do not follow redirects.

The REST create/update prose says 1 is highest, but the Sync task property
description explicitly defines 4 as urgent/client p1. The same mapping is
implemented by the official [Doist CLI](https://github.com/Doist/todoist-cli/blob/main/src/lib/task-list.ts)
in `PRIORITY_MAP` / `parsePriority`:

| UI | API |
| --- | --- |
| p1 | 4 |
| p2 | 3 |
| p3 | 2 |
| p4 | 1 |

All four values are tested. No account token or live mutation was used to
establish this mapping. Update is POST, never REST v2/PATCH upstream.
The documented v1 update operation does not accept a project change; moving
uses its own documented POST `/tasks/{id}/move` operation. It is a separate UI
action and cannot be combined with unsaved title/description/date changes.

## Protected configuration

Owner-managed example, **not** a file to commit or copy to frontend settings:

```dotenv
# In the protected Panel Agent runtime.env only; replace locally.
PANEL_TODOIST_API_TOKEN=<personal-token-entered-locally>
# Optional: absent means a nonempty token enables reads. false forces Planning.
PANEL_TODOIST_ENABLED=true
# Start with writes disabled.
PANEL_TODOIST_WRITES_ENABLED=false
PANEL_WRITES_ENABLED=false
```

After review and physical read acceptance, owner may opt into both write gates:

```dotenv
PANEL_TODOIST_WRITES_ENABLED=true
PANEL_WRITES_ENABLED=true
```

The effective profile must also authorize `todoist.tasks.write` (Standard or
Full). Read Only cannot write. Touch lock still blocks UI writes. Token alone
never enables mutations. Explicit Todoist enable with no token shows an
unavailable integration; it does not silently switch providers.

Never use `VITE_*` for this token. The token is excluded from settings repr and
is used only in an upstream server Authorization header. The adapter writes no
task cache, task content, credentials or upstream error bodies to disk/logs.
Existing panel configuration backups must continue excluding runtime secrets.
No production env was read or modified during implementation.

## Local API

All paths below start with `/api/v1/todoist`. Responses have `provider: todoist`,
active source and generation timestamps. Lists have `results`, `nextCursor` and
`lastSyncedAt`. Status includes enabled/configured/effective writes state.
Responses are `Cache-Control: no-store`.

| Local method/path | Fixed upstream method/path |
| --- | --- |
| GET `/status` | No upstream call |
| GET `/tasks?view=all&projectId=…&cursor=…&limit=…` | GET `/tasks`, optional `project_id` |
| GET `/tasks?view=today\|overdue\|upcoming\|undated&projectId=…&cursor=…&limit=…` | GET `/tasks/filter` |
| GET `/projects?cursor=…&limit=…` | GET `/projects` |
| POST `/tasks` | POST `/tasks` |
| POST `/tasks/{id}` | POST `/tasks/{id}` |
| POST `/tasks/{id}/move` | POST `/tasks/{id}/move` |
| POST `/tasks/{id}/close` | POST `/tasks/{id}/close` |

Fixed filter queries: `today`, `overdue`, `due after: today` (all future dates),
`no date`. Browser-supplied filter expressions, paths, hosts, Authorization,
unknown/repeated query parameters and arbitrary JSON fields are rejected.
IDs are bounded alphanumeric provider strings, not UUIDs; temporary IDs and
path/query characters are rejected. Limits: 1–200 rows, cursor 512 characters,
decoded HTTP response 512 KiB, connect 5s, HTTP phase 10s, total request 15s.
There are no automatic HTTP retries, for reads or writes.

Create/update accept `content` (1–500 nonblank characters), `description`
(up to 4000), `priority` (p1–p4), `due` (ISO date, offset-bearing timestamp,
or null). Create optionally accepts `project_id`; move requires `project_id`.
Update rejects `project_id`, preventing an undocumented or partial double write.
Omitted due preserves the provider's timezone, recurrence and floating/timed
semantics. Null removes the date. Explicit date edits replace the schedule;
the sheet warns about recurring tasks. Timed edits carry an explicit UTC offset.
No recurrence authoring, labels, sections, assignments, deadlines, deletion,
completed history or reopen UX is included.

## Pagination, freshness and outcomes

- Tasks load one cursor page at a time with an explicit “Загрузить ещё” control.
  Project filtering for fixed views is applied to each validated provider page,
  preserving its cursor even if the resulting project page is empty. This
  avoids undocumented filter syntax and never labels a partial set complete.
- Projects follow cursors up to 100 pages / 20,000 rows. A bound or cursor loop
  fails visibly, without presenting partial results as the full project list.
- IDs are deduplicated inside pages and across loaded Tasks pages. Exact cursor
  non-advancement is rejected server-side and cursor cycles client-side.
- Freshness belongs to successful reads. The UI retains only in-memory last
  data on refresh failure; it labels that state and blocks writes. After 90s,
  it labels data stale and requires a refresh before writing. A new filter does
  not display the previous filter's data. There is no polling or disk cache.
- Every create/update/move/close sends **one** POST. A shared server lock and
  client pending guard block concurrent double actions. No retry/idempotency
  guarantee is invented. A user choosing to submit again is a new command.
- Accepted writes trigger a fresh list read; success copy describes acceptance
  and reread, not inferred physical completion. Recurring close shows the next
  occurrence returned by Todoist rather than removing the row optimistically.
- Timeouts, transport failures, upstream 5xx and malformed write responses
  yield `outcome_uncertain`. The UI rereads and asks the owner to inspect before
  another submission. A failed reread remains visible. Nothing retries the POST.
- Invalid/revoked token, forbidden access, 429 (bounded Retry-After propagated),
  invalid request, missing object, malformed response and offline are separate
  safe error codes. No upstream response text is exposed. A 429 is not retried
  automatically; the user is told to wait before requesting another read.

## Verification

Automated tests use synthetic objects and mocked HTTP/browser routes, with no
live Todoist mutations. Backend tests exercise cursor pages, empty project
pages, fixed filters, malformed/oversized payloads, dates/recurrence, all priority
values, redirects, status errors, timeout/5xx uncertainty, exact methods, strict
input, all mutation access mappings and gates, lock, redaction and activation.
Component tests cover loading, empty/offline, readonly, sparse edits, duplicate
submit, reread after uncertain close, deduplication and legacy fallback.
Playwright covers 1280×720 day/night geometry, 48px controls, source activation
without legacy Vite Tasks rollout, create/edit/move/close, and failure states.

Commands used for verification (results belong to the PR/head report):

```sh
npm run check
npm run test:e2e
VITE_V2_VISUAL_SHELL=true VITE_TOUCH_INPUT_LOCK_ENABLED=true VITE_TOUCH_INPUT_LOCK_START_LOCKED=false npm run test:e2e -- tests/e2e/todoist-tasks.spec.ts
npm run test:e2e:production
```

CI continues running canonical checks on Linux and Windows and adds a focused
V2 Todoist browser gate on Linux. Browser fixtures never need a token.
The first run exposed runner drift: Ubuntu 26.04 is unsupported by the pinned
Playwright 1.55, and the Windows `py` launcher selected Python 3.15 instead of
setup-python's 3.12, preventing Pillow installation. CI pins Ubuntu 24.04 while
preserving check names, and creates its venv with setup-python's `python` before
the normal setup command. Both Windows Python launcher defaults are pinned to
3.12 in CI so detached venv regression tests use the same interpreter too.
Production setup/runtime behavior is unchanged.
The production browser harness now provisions its own disposable exact-revision
venv, as required by the existing supervisor; it does not modify an installed
runtime or create a production-update staging marker in the developer checkout.

## Physical Samsung acceptance (owner, after PR review)

1. Before changing configuration, run read-only DNS/TCP/HTTPS probes **on the
   Samsung**, for example in PowerShell:

   ```powershell
   Resolve-DnsName api.todoist.com
   Test-NetConnection api.todoist.com -Port 443
   curl.exe --connect-timeout 5 --max-time 10 --output NUL --write-out '%{http_code}' https://api.todoist.com/api/v1/tasks
   ```

   An unauthenticated 401 proves an HTTP response; it does not validate an
   account token. Keep TLS verification enabled. If blocked, record the DNS/TLS
   failure and request a separate topology decision; do not add a VPS relay.
2. Confirm the installed commit against PR head and the localhost runtime/env
   location described above. Owner configures token locally with both gates off.
   Do not include runtime.env, token or personal task text in screenshots/logs.
3. Check Tasks navigation with the old Vite Tasks flag off. Check all five
   views, project names, multiple pages and empty pages; dates, floating/timezone
   display and p1/p4 against the official Todoist app.
4. Check light/night, touch and keyboard focus, native date/time/project
   controls, sheet scrolling/virtual keyboard and 1280×720 overflow. Browser
   emulation cannot establish physical touch/keyboard performance.
5. Disconnect Wi-Fi, refresh and check unavailable/stale copy. Restore it and
   refresh. Verify invalid-token and quota errors without exposing credentials.
6. If owner explicitly enables both gates, use owner-created disposable tasks
   to check create, description/date/priority edits, separate project move and
   close. Check recurring close advances provider occurrence. Switch to Read
   Only/touch lock and verify writes are blocked. Do not automate live writes.
7. Disable Todoist explicitly and check legacy Tasks. Verify Calendar,
   Reminders, Overview, Coffee, Smart Home and Station retain their behavior.
   Rollback is `PANEL_TODOIST_ENABLED=false`; no data migration is required.

No merge, deploy, production restart or production configuration edit is part
of this implementation. Physical acceptance and live read connectivity remain
owner checks.
