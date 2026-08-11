# Terra execution order

Date: 2026-08-11

Binding inputs: issue #61, `HA_PERSONAL_ASSISTANT_PLAN.md`, `CONTROL_CENTER_PLANNING_PLAN.md`, `SAMSUNG_TABLET_UX_AUDIT.md`

This is an execution queue, not a menu. Complete Plan 1 and its independent gate before any Samsung planning feature. Each phase is one small PR unless explicitly split by repository. Do not mix opportunistic refactors, dependency upgrades or visual redesign into these PRs.

## Global rules for every phase

- Preserve dirty/local work; never reset, clean, force checkout, discard or rewrite history.
- Read each repository's `AGENTS.md` before editing. HA and the bot are read-only during this planning task; their later implementation uses their own branches/PRs.
- Add secrets only through the existing deployment secret path; never fixtures, frontend state, SQLite, git or logs.
- Use UUIDv4 internal IDs, UTC RFC 3339 timestamps plus IANA timezone, object versions, idempotency keys and audit correlation IDs exactly as specified.
- All API models reject unknown fields. No generic HA service/entity, shell, URL, host or path execution endpoint may be introduced.
- Russian date parsing is deterministic; uncertain writes stop for confirmation.
- TickTick and calendar work cannot leapfrog their explicit stop points.
- Every rollout is canary/feature-flagged and has an independent rollback. Never down-migrate away user data to roll back code.

## Plan 1 — HA / Alice / AliceTG_Bot foundation

### A0 — Reconcile the bot branch and freeze contracts

**Goal:** produce a clean implementation base and approve the fixed domain/API contracts without changing behavior.

**Repository:** `decorum-guy/AliceTG_Bot`; documentation reference from `decorum-guy/artem-control-center` issue #61.

**Prerequisites:** fetch both repositories; confirm the bot's current `feat/control-center-ha-timing` is still clean and determine why it is three commits behind `origin/main`.

**Likely files/modules:** bot `AGENTS.md`, `README.md`, `docs/`, `app/config.py`, `app/main.py`, `app/web/internal_routes.py`, reminder modules and tests; no HA edit yet.

**Schemas/contracts:** copy the versioned Planning v1 object/envelope examples from the HA plan into bot docs/tests. Lock enum values, timestamp rules, UUIDv4, version and error envelope.

**Migrations:** none.

**Implementation steps:**

1. Compare feature branch to `origin/main`; merge or rebase only according to repository policy and without discarding work.
2. Resolve conflicts explicitly and run the full existing suite.
3. Add contract fixtures/docs only; no endpoints or runtime wiring.
4. Record supported Python/runtime/database volume path.

**Tests:** current bot unit/integration/lint suite; static JSON-schema/fixture validation if the repo already has that mechanism.

**Local verification:** fresh environment starts the unchanged bot; current reminder and coffee/HA integrations still pass.

**Integration verification:** none beyond current health smoke tests.

**Acceptance criteria:** clean current branch; zero behavior change; Planning v1 contract is reviewable and agrees with issue #61.

**Rollout:** no deployment.

**Rollback:** revert documentation/fixture commit.

**Dependency:** first phase.

**USER DECISION / STOP:** stop if branch changes conflict semantically with main; request a maintainer choice rather than choosing which behavior to discard.

**Security:** verify examples contain no real internal secret, Telegram ID, transcript or personal title.

### A1 — SQLite schema, repositories and audit core (FIRST IMPLEMENTATION BATCH)

**Goal:** add the durable Planning storage layer with no network endpoints, scheduling or UI.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A0; confirmed persistent `/app/data` path and Python SQLite support.

**Likely files/modules:** new `app/planning/` package (`models.py`, `db.py`, `migrations.py`, `repositories.py`, `audit.py`); `app/config.py`; new `tests/planning/`; deployment volume docs.

**Schemas/contracts:** tables for `schema_migrations`, `reminders`, `tasks`, `projects`, `calendar_events`, `idempotency_keys`, `outbox`, `delivery_attempts`, `audit_events`, `provider_mappings`, `sync_cursors`, `sync_conflicts`. Use constraints for enums, mutually exclusive all-day/timed fields and unique provider mappings.

**Migrations:** `001_planning_core.sql`, forward-only and transactional; include indexes for due reminder/outbox leases, task views, event ranges, idempotency expiry and mappings.

**Implementation steps:**

1. Configure database path with a safe persisted default; fail startup if production points at an ephemeral path.
2. Open SQLite with WAL, foreign keys, busy timeout and explicit transaction boundaries.
3. Implement migration lock/version verification and refuse unknown newer schema.
4. Implement typed repositories for all three domains, expected-version updates, tombstones and audit writes in the same transaction.
5. Implement atomic idempotency claim/stored-response primitives and outbox enqueue primitive, but no worker.
6. Add bounded redaction for audit data.

**Tests:** migration from empty DB; repeat migration; concurrent idempotency claim; expected-version conflict; foreign keys/check constraints; date-only vs timed event; tombstone behavior; transaction rollback; newer-schema refusal; WAL reopen.

**Local verification:** run tests against a temporary file DB, close/reopen, integrity check and inspect indexes/query plans for due scans.

**Integration verification:** start the bot with an empty persisted volume and confirm existing functionality is unchanged.

**Acceptance criteria:** repositories survive restart; duplicate keys cannot create duplicate rows; audit and domain mutation commit atomically; no raw transcript/secret is persisted.

**Rollout:** merge but keep Planning feature disabled; no production migration until A2 preflight is ready.

**Rollback:** disable module/use prior image; DB file may remain unused and must not be deleted.

**Dependency:** A0.

**USER DECISION / STOP:** none if the verified data path is persisted; stop if production volume semantics are unknown.

**Security:** permissions on DB/parent directory; parameterised SQL only; no user-controlled table/order clauses; bound text sizes.

### A2 — Legacy reminder import and repository cutover

**Goal:** idempotently import the JSON reminder store and make the repository the single reminder persistence path.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A1; recoverable production backup method proven; representative redacted JSON fixture.

**Likely files/modules:** `app/services/reminder_store.py`, new `app/planning/legacy_import.py`, startup composition in `app/main.py`, migration tests/fixtures and operator docs.

**Schemas/contracts:** full legacy identifier mapping and import audit event; semantic count/hash report.

**Migrations:** data import `002_import_legacy_reminders`, separate from structural 001; import marker and source hash make reruns no-op.

**Implementation steps:** validate all rows before transaction; preserve due/status/source; map legacy IDs to UUIDv4 once; compare count/hash; expose read-only preflight report; cut current handlers to repository; retain untouched JSON for one rollback window; do not dual-write.

**Tests:** empty/corrupt/duplicate JSON; all legacy statuses; timezone-naive rejection policy; rerun idempotence; partial failure rollback; deterministic mapping retention.

**Local verification:** import a copied fixture twice, compare semantic export and restart.

**Integration verification:** staging copy of production data, operator review of counts/due times before enabling.

**Acceptance criteria:** no reminder lost/duplicated; existing Telegram list/cancel/create still works; restart reads SQLite only after successful marker.

**Rollout:** backup → preflight → maintenance window → transactional import → smoke test → enable repository.

**Rollback:** return to prior image and untouched JSON during the agreed window; export post-cutover SQLite data before any rollback.

**Dependency:** A1.

**USER DECISION / STOP:** operator approves preflight discrepancies; zero tolerance for unexplained count/time differences.

**Security:** backup and reports redact reminder bodies unless operator explicitly inspects locally.

### A3 — Durable scheduler and Telegram delivery outbox

**Goal:** replace `asyncio.sleep` scheduling and fix the all-channels-failed/no-retry defect.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A2.

**Likely files/modules:** `app/workflows/reminders.py`, new `app/planning/scheduler.py`, `delivery.py`; Telegram/iPhone transport adapters; lifecycle in `app/main.py`; tests with fake clock/transports.

**Schemas/contracts:** lease owner/expiry, per-channel delivery attempt, next attempt, provider receipt/error class, overall delivery state.

**Migrations:** `003_delivery_policy` only if A1 cannot include the final columns/indexes.

**Implementation steps:** poll every 5–10 seconds; atomically lease rows; reclaim expired leases; enqueue delivery in the same reminder transaction; require Telegram success for issue #61; implement jittered 30s/2m/10m/30m/2h/6h/12h retries capped at eight/24h; preserve per-channel outcomes; terminal incident + manual retry; cancellation/completion suppresses pending jobs.

**Tests:** crash before/after send boundary, lease expiry, duplicate worker, Telegram timeout/429/permanent block, partial channel success, cancellation race, clock jump, overdue startup, manual retry idempotence.

**Local verification:** fake-clock suite plus real bot restart against a test DB; no wait-based flaky tests.

**Integration verification:** staging Telegram chat with forced failures and restart; compare delivery attempt audit.

**Acceptance criteria:** outage never loses the job; status remains retrying/failed; two workers do not intentionally send twice; restart resumes due work.

**Rollout:** enable for one test reminder class, monitor heartbeat/oldest-outbox/duplicates, then switch all reminders.

**Rollback:** disable new worker and return old scheduler only while retaining/importing new due rows; never run both workers concurrently.

**Dependency:** A2.

**USER DECISION / STOP:** confirm required channels if Telegram is not always mandatory; default is Telegram required.

**Security:** error bodies/provider receipts are redacted; manual retry is admin-only and rate-limited.

### A4 — Planning v1 API and audience-scoped authentication

**Goal:** expose only the fixed domain API to HA and future Panel Agent.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A1–A3.

**Likely files/modules:** `app/web/internal_routes.py`, new `app/planning/api.py`, `schemas.py`, auth/config/middleware, API tests.

**Schemas/contracts:** exact endpoints/error/list metadata in HA plan; `Idempotency-Key`, expected `version`, actor/surface, `sourceStatus/lastSyncedAt/staleAfter`.

**Migrations:** none expected.

**Implementation steps:** create separate `ha` and `panel-agent` audiences; strict validation/limits; map HTTP methods to repository commands; persist mutation response under idempotency key atomically; implement bounded range/filter/pagination; health endpoint without personal content; correlation IDs and safe logs.

**Tests:** contract fixtures; unknown/additional fields; malformed times/timezones; stale version 409; duplicate mutation returns identical response; auth/audience separation; rate/size limits; path traversal and injected HA/service/shell/URL fields rejected.

**Local verification:** run API with temporary DB and scripted requests; inspect logs for redaction.

**Integration verification:** HA/Panel test clients can call only their permitted operations; expired/wrong secret fails closed.

**Acceptance criteria:** no generic proxy/execution primitive; every mutation is idempotent/audited/versioned; status exposes no titles/tokens.

**Rollout:** deploy endpoints disabled from external routing; create/rotate audience secrets; health first, then consumers.

**Rollback:** remove routing/disable feature flag; storage and scheduler continue.

**Dependency:** A3.

**USER DECISION / STOP:** none; operator supplies secret deployment method without committing values.

**Security:** constant-time secret checks, private bind/reverse proxy, no query-string credentials, bounded pagination and timeouts.

### A5 — Deterministic Russian parser and Alice conversation adapter

**Goal:** create/query the three domains through “Домашний помощник” without silent ambiguity.

**Repositories:** bot first; then the HA configuration repository/location in a separate reviewed change.

**Prerequisites:** A4; verified backup/change/reload procedure for HA; current `yandex_dialogs` fixture envelope.

**Likely files/modules:** bot `app/services/reminder_parser.py` refactored into `app/planning/parser/`; `app/planning/alice.py`; HA `automations.yaml` and `rest_command`/secrets configuration around current `tg_alice_reminder_create`.

**Schemas/contracts:** parse candidate/ambiguity result and synchronous `/alice/interpret` response; Yandex session/application/user/message envelope.

**Migrations:** optional short-lived pending confirmations table only if verified multi-turn sessions work; otherwise none.

**Implementation steps:** implement required Russian grammar with explicit reference time/timezone; domain/operation classifier; query speech limits; idempotency key derivation from Yandex IDs with HMAC fallback; build HA call to one fixed endpoint; emit `yandex_intent_response`; preserve station playback only as documented fallback; no object save on uncertainty.

**Tests:** table-driven phrases from issue #61 plus paraphrases, `полтора`, date rollover/year, weekdays, all-day, 60-minute default, ambiguous `вечером/следующей неделе/с пяти`, DST invalid time, duplicate Yandex event, prompt injection containing service/entity/command/path.

**Local verification:** synthetic Yandex event fixture produces speech and database result; ambiguous fixtures produce no rows.

**Integration verification:** published “Домашний помощник” test creates exactly one reminder; asks all three query examples; response comes through YandexDialogs in time.

**Acceptance criteria:** custom skill semantics are documented; native Alice reminders are never claimed/imported; response under 1.5s internal target; uncertain parse never writes.

**Rollout:** bot endpoint first; HA automation disabled test path; limited live skill test; enable replacement while monitoring correlation IDs.

**Rollback:** restore prior HA automation and disable new Alice command handling; bot data remains intact.

**Dependency:** A4.

**USER DECISION / STOP:** user chooses meaning of “вечером”; without it parser always asks. Stop multi-turn editing/cancel if session continuity cannot be reliably verified.

**Security:** fixed endpoint only, HMAC secret outside git, transcript length/redaction, no arbitrary tool execution.

### A6 — Telegram monitoring and safe actions

**Goal:** make reminders actually arrive and expose pending/task/event queries with useful safe actions.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A3–A5.

**Likely files/modules:** `app/handlers/reminders.py`, `app/keyboards/reminders.py`, `app/messages/reminders.py`; new task/calendar handlers/keyboards/messages; shared callback token service.

**Schemas/contracts:** compact view models; short-lived opaque callback token containing action/object/version server-side.

**Migrations:** callback token table only if persistence across restart is required; otherwise signed expiring token with nonce/replay record.

**Implementation steps:** list pending/due/failed reminders; cancel/complete/snooze; task today/overdue/upcoming + complete; event today/tomorrow/upcoming; reuse parser for optional creation only after tests; reauthorize every callback; human relative + exact due time.

**Tests:** allowed/admin IDs, unauthorised callback, expired/replayed token, stale version, long Russian title, pagination, callback data length, failure/retry status.

**Local verification:** mocked Telegram update/callback suite.

**Integration verification:** private staging chat performs actions and observes the same canonical state via API.

**Acceptance criteria:** no callback contains arbitrary command/title; permission/version checked at action time; reminder delivery and list states agree.

**Rollout:** admin-only pilot, then existing allowed users.

**Rollback:** unregister new commands/keyboards; scheduler/delivery continues.

**Dependency:** A5.

**USER DECISION / STOP:** Telegram event/task creation may remain off if conversational confirmation is awkward; monitoring is required.

**Security:** existing allowlists remain authoritative; rate-limit callbacks and redact notes from default notifications.

### A7 — Task and calendar-event service foundations

**Goal:** complete domain commands/queries independent of external providers or Samsung.

**Repository:** `decorum-guy/AliceTG_Bot`.

**Prerequisites:** A4–A6; domain schema from A1.

**Likely files/modules:** `app/planning/tasks.py`, `events.py`, `projects.py`, API schemas/routes and tests.

**Schemas/contracts:** task date-only semantics/priority/project/status; timed vs all-day event and exclusive end date; `sync_state=local_only` until provider exists.

**Migrations:** seed default local project only if product requires one; avoid silently creating provider calendars.

**Implementation steps:** implement commands/views; consistent archive/tombstone; query today/overdue/upcoming with Europe/Moscow and caller timezone; 60-minute event default with confirmation; provider-neutral capability metadata; local-only speech/labels.

**Tests:** midnight/year/DST rollover; date-only task; all-day event spanning days; overlapping events; project deletion policy; archive/tombstone; provider capability denial.

**Local verification:** CLI/test API creates/edits/completes/deletes and restarts.

**Integration verification:** Alice and Telegram queries return consistent ordering/counts.

**Acceptance criteria:** three domains stay distinct; event writes cannot imply external sync; due/today queries are deterministic.

**Rollout:** enable queries first, local mutations behind separate flags.

**Rollback:** disable task/event mutations; retain records for later re-enable/export.

**Dependency:** A6.

**USER DECISION / STOP:** no provider write; calendar choice remains unresolved.

**Security:** bounded notes/location, safe Unicode, object-level authorization/version checks.

### A8 — Backup, observability and independent Plan 1 gate

**Goal:** prove the foundation can run and recover without Control Center.

**Repository:** `decorum-guy/AliceTG_Bot`, plus operational backup documentation/config.

**Prerequisites:** A1–A7.

**Likely files/modules:** backup scripts/service, `app/planning/health.py`, deployment/operations docs, restore tests.

**Schemas/contracts:** health fields only: schema, scheduler heartbeat, oldest due age, failed count, provider status/last sync, DB integrity.

**Migrations:** none.

**Implementation steps:** online SQLite backup/checkpoint; encrypted manifest; isolated restore verifier; exclude tokens/audio; expose content-free status; alerts for scheduler heartbeat, stuck outbox and terminal delivery; execute all eight Plan 1 proof scenarios from the HA plan.

**Tests:** backup under writes, corrupt backup, restore/migration/count/foreign-key checks, resumed due job without duplicate, status redaction.

**Local verification:** restore to temporary directory and start a worker against it.

**Integration verification:** controlled staging restart/outage/duplicate Alice event; Telegram and API agree.

**Acceptance criteria:** all Plan 1 proofs pass; restore is documented/measured; no Samsung dependency.

**Rollout:** staged production deploy with health soak; retain prior image and legacy file through rollback window.

**Rollback:** prior image/config plus documented export/reconciliation of any new records.

**Dependency:** A7; blocks all B phases except B0 shared UX fixes.

**USER DECISION / STOP:** operator signs off restore and production health before panel integration.

**Security:** least-readable backup permissions, encryption/key separation, restore logs contain no personal contents.

## Plan 2 — Artem Control Center integration

### B0 — Shared Samsung touch and notice prerequisites

**Goal:** remove known UX hazards before adding planning density.

**Repository:** `decorum-guy/artem-control-center`.

**Prerequisites:** UX audit; no Plan 1 dependency.

**Likely files/modules:** `apps/dashboard/src/RuntimeControls.tsx`, action confirmation catalog/provider, shell/header/theme CSS, Weather/Settings controls, global notices and Playwright fixtures.

**Schemas/contracts:** global notice `{id, correlationId, severity, title, detail, action?, expiresAt?}`; confirmation action catalog entry for runtime shutdown.

**Migrations:** none.

**Implementation steps:** replace `window.confirm`; create one noncolliding notice stack; make targets ≥48 px; touch steppers for frequent numbers; localise mode copy; rebalance Overview/Weather to the 1280×720 acceptance measurements.

**Tests:** browser prompts throw; triple-notice bounding boxes; target/text-size scanner; day/night and four motion modes; Russian wrapping; no document overflow.

**Local verification:** `npm run check`, e2e at 1280×720/DSF1.5/touch; inspect selected screenshots.

**Integration verification:** read-only Samsung canary verifies touch/scroll and full/reduced/low/battery modes.

**Acceptance criteria:** audit P1-01 through P1-07 shared issues are closed or explicitly split with passing gate; current capabilities unchanged.

**Rollout:** UI-only canary then normal production.

**Rollback:** prior dashboard bundle; no data migration.

**Dependency:** none; complete before B2.

**USER DECISION / STOP:** security owner approves PIN + hold replacement before removing strong typed fallback.

**Security:** destructive actions stay in access/confirmation catalog; no route-local bypass.

### B1 — Planning contracts, Panel Agent adapter and SSE projection

**Goal:** ingest bounded read-only Planning data through existing snapshot/SSE.

**Repository:** `decorum-guy/artem-control-center`.

**Prerequisites:** A8; Planning v1 fixture; audience secret deployment path.

**Likely files/modules:** neighbouring clients/models under `apps/panel_agent/`; snapshot assembler/cache/health/routes; dashboard snapshot types; fixtures/tests.

**Schemas/contracts:** versioned bounded `planning` block and narrow same-origin read endpoints from the Control Center plan.

**Migrations:** none; last-good cache uses existing safe cache mechanism or an explicitly bounded new file.

**Implementation steps:** strict client models/timeouts; startup + jittered poll; canonical hash/no-op suppression; snapshot status/timestamps/capabilities; last-good cache; SSE revision on semantic change; read-only endpoints; feature flag/navigation hidden.

**Tests:** contract fixture parity; timeout/malformed/newer schema; unchanged poll no revision; restart cache stale; no secret serialization; bounded list/range.

**Local verification:** fixture Planning server; disconnect/reconnect while watching revisions.

**Integration verification:** production-like bot staging, compare counts/IDs/timestamps; no writes.

**Acceptance criteria:** one browser SSE stream only; stale/offline truthful; no token reaches UI.

**Rollout:** adapter/status only, hidden from users, observe poll load/errors.

**Rollback:** disable adapter flag; shell remains current.

**Dependency:** A8.

**USER DECISION / STOP:** none if audience secret is supplied through existing secret channel.

**Security:** fixed base URL/config, SSRF-safe; audience separation, response size/range caps.

### B2 — Overview monitoring card

**Goal:** surface the most relevant reminder/task/event without overloading Overview.

**Repository:** `decorum-guy/artem-control-center`.

**Prerequisites:** B0–B1.

**Likely files/modules:** Overview route/widgets, widget registry, snapshot selectors, CSS and fixtures/Playwright.

**Schemas/contracts:** read-only summary selector: next reminder, overdue task count/top task, next event, combined source status.

**Migrations:** none.

**Implementation steps:** create one compact `Дела` card; reduce coffee footprint; limit one row/domain; exact time in accessible details; link rows; combined degraded chip; avoid live countdown over stale data.

**Tests:** empty/healthy/due/overdue/stale/offline/long Russian text; viewport intersections; widget registry/access; no duplicate after SSE.

**Local verification:** canonical screenshots/DOM measurements for all modes.

**Integration verification:** read-only Samsung data compared with Telegram/API.

**Acceptance criteria:** header + heading + coffee state/action + all three signals visible without scroll at 1280×720.

**Rollout:** feature flag for Overview card; read-only.

**Rollback:** disable card and restore previous layout bundle.

**Dependency:** B1 and B0.

**USER DECISION / STOP:** none; do not add new nav item here.

**Security:** summaries respect existing route/access policy and avoid notes/private details.

### B3 — Reminder, Tasks and Calendar monitoring routes

**Goal:** replace Calendar/Tasks placeholders and provide a full reminder monitor.

**Repository:** `decorum-guy/artem-control-center`.

**Prerequisites:** B2.

**Likely files/modules:** `apps/dashboard/src/App.tsx`, new route/components/selectors, widget registry/nav metadata, fixtures/e2e.

**Schemas/contracts:** paginated/range reads; status/capability/provider metadata.

**Migrations:** none.

**Implementation steps:** Tasks segmented today/overdue/upcoming; Calendar today/agenda with all-day separation; Reminder soon/missed/delivery view via Overview/full-screen surface; project/provider filter sheets; explicit stale/offline/failure states.

**Tests:** complete state matrix, pagination, overlaps, timezone/date-only/all-day, long copy, scrolling, focus/tap, status sizes and hit targets.

**Local verification:** fixture gallery and Playwright at canonical viewport/modes.

**Integration verification:** read-only real data cross-checked with bot API/Telegram.

**Acceptance criteria:** no placeholder for Tasks/Calendar; each domain visibly distinct; all required monitoring states accessible touch-only.

**Rollout:** separate read-only flags by domain.

**Rollback:** flags restore prior placeholder/navigation state; adapter remains healthy.

**Dependency:** B2.

**USER DECISION / STOP:** decide permanent Reminder rail item only after usage; default is no new rail item.

**Security:** range limits, safe text rendering, no source secrets/provider raw payloads.

### B4 — Touch CRUD, parsing confirmation and mutation proxy

**Goal:** create/edit/complete/cancel/archive all domains through safe touch flows.

**Repository:** `decorum-guy/artem-control-center`.

**Prerequisites:** B3 and stable A8 mutation API.

**Likely files/modules:** Panel Agent planning mutation routes/client; dashboard sheets/pickers; access catalog; confirmation provider; notice stack; mutation fixtures/e2e.

**Schemas/contracts:** exact mutation/idempotency/version/parse candidate envelopes; no generic proxy.

**Migrations:** none.

**Implementation steps:** implement Agent allowlist mapping; touch date/time/all-day/priority/project controls; optional text fallback; parser preview/restatement; disable Save on ambiguity; canonical response replaces local state; complete/snooze/cancel/archive confirmations and undo where valid; conflict resolver.

**Tests:** replay/idempotency, stale version, timeout/no false success, all ambiguity cases, permission levels, destructive spacing, OSK-safe viewport, prompt stubs throw, fuzz arbitrary service/entity/shell/path/URL.

**Local verification:** complete every common flow with Playwright `.tap()` and no keyboard.

**Integration verification:** staging creates through Samsung; same IDs/state seen by Alice/Telegram and after restart.

**Acceptance criteria:** normal CRUD needs no keyboard; uncertain parse cannot save; offline initially disables mutations; every result is audited/canonical.

**Rollout:** reminders first, then tasks, then local-only events; separate flags.

**Rollback:** disable mutation flags; read monitoring remains; never discard committed objects.

**Dependency:** B3.

**USER DECISION / STOP:** calendar saves are labelled local-only until provider write approval.

**Security:** existing access elevation, object versions, CSRF/same-origin protections, fixed endpoints and schema allowlist.

### B5 — Samsung local voice prototype

**Goal:** validate microphone title entry on actual hardware without making voice mandatory.

**Repository:** `decorum-guy/artem-control-center`; deployment packaging may reference official `whisper.cpp` binaries/models after supply-chain review.

**Prerequisites:** B4; explicit microphone/privacy approval; no concurrent production install during development audit.

**Likely files/modules:** Panel Agent microphone/transcription adapter, process lifecycle/config/health; dashboard press-to-record component; Windows install/service scripts; tests/fixtures.

**Schemas/contracts:** audio upload/stream bound by duration/format; transcript response only; capability and resource health. No audio persistence.

**Migrations:** none.

**Implementation steps:** benchmark base multilingual Q5 on demand, four threads; verify binary/model checksum/license; press-to-record; immediate audio deletion; feed transcript to existing parse preview; measure p50/p95/peak RAM/CPU/temperature/Edge jank; small model only if base accuracy fails and performance passes.

**Tests:** permission denied/no mic/silence/long audio/cancel/concurrent request/process crash; Russian names/noise corpus; audio absence after completion/restart; reduced-motion UI.

**Local verification:** Mac fixture path for UI only; no quality conclusion from Mac performance.

**Integration verification:** real Samsung 5–8s utterance p95 ≤3s, acceptable Russian task-title corpus, no Edge long task >100ms attributable to inference, no persistent audio.

**Acceptance criteria:** transcript + parsed fields always confirmed; touch/text fallback remains; failing performance leaves feature disabled.

**Rollout:** one-device/operator flag; unloaded at idle; monitor resources.

**Rollback:** disable flag/remove service through documented reversible uninstall; basic CRUD unaffected.

**Dependency:** B4.

**USER DECISION / STOP:** approve local audio processing/no-retention policy; choose opt-in cloud fallback only if local pilot fails.

**Security:** microphone indicator, duration/size/type limits, local bind, checksum-pinned artifacts, no arbitrary model/path argument from browser.

### B6 — TickTick OAuth and bounded bidirectional polling pilot

**Goal:** verify today's official API in the real account before enabling eventual two-way task sync.

**Repository:** bot for adapter/store/outbox; Control Center only for status/conflict UI in a later/split PR.

**Prerequisites:** A8; B3; user-created TickTick developer app; reviewed OAuth redirect/secret storage; official API still matches research.

**Likely files/modules:** bot `app/planning/providers/ticktick.py`, OAuth routes/config, mappings/cursors/conflicts/outbox, adapter tests; Panel status/conflict components.

**Schemas/contracts:** provider capabilities, mappings, last-common hashes/etag, tombstones, conflict records; no webhook promise.

**Migrations:** provider token metadata reference (not token value), mapping/hash/tombstone/index adjustments as needed.

**Implementation steps:** prove auth-code exchange and token lifetime/reauthorization; read projects/tasks; conservative polling and explicit refresh; export one test task; update/complete/delete both directions; no-op last-exported hash suppression; concurrent edit conflict; outage/outbox/recovery; measure undocumented limits and back off.

**Tests:** recorded official fixtures, token expiry, pagination, date/timezone/priority/project mapping, direct remote edit, loops, deletes/completion, duplicate, 401/429/5xx, conflict.

**Local verification:** sandbox/test project only; never private API or local storage scraping.

**Integration verification:** real dedicated TickTick test list across Alice/Samsung/TickTick with IDs/audit compared.

**Acceptance criteria:** documented eventual consistency; no loops/duplicate resurrection; local tasks work offline; status/conflicts visible; OAuth renewal behavior understood.

**Rollout:** single test project → opt-in project allowlist → gradual polling; never all projects by default.

**Rollback:** stop polling/export; retain mappings/outbox/conflicts and local authority; revoke token if requested.

**Dependency:** A8 and B3; can occur after B4 but is not required for local CRUD.

**USER DECISION / STOP:** stop if developer registration, reliable authorization renewal or acceptable polling cannot be proven. User approves conflict policy; default is manual resolution.

**Security:** OAuth state/PKCE if supported, encrypted secret storage, minimum scopes `tasks:read tasks:write`, redirect allowlist, token redaction.

### B7 — Calendar provider read-only adapter, then separately approved writes

**Goal:** connect the actual authoritative calendar without assuming Google/iCloud.

**Repository:** bot provider adapter; Control Center provider status/calendar selection UI.

**Prerequisites:** A7; B3; user chooses provider/account/destination; credentials supplied securely.

**Likely files/modules:** `app/planning/providers/calendar/` interface + chosen adapter; mapping/cursor tests; Calendar route details/status.

**Schemas/contracts:** capability discovery; list calendars/events/range/cursor; provider/calendar IDs; all-day exclusive end; optional create/update/delete only after separate gate.

**Migrations:** provider mapping/cursor fields specific to verified API only.

**Implementation steps:** build provider-neutral contract tests; read-only ingest one chosen calendar; timezone/all-day/recurrence round-trip fixtures; cache/status; reconcile local-only events explicitly; review destructive/update behavior; open a separate write PR only after approval.

**Tests:** pagination/delta if available, full sync, DST, all-day, recurrence preservation, moved/deleted event, outage/rate limit, multiple calendars.

**Local verification:** recorded sanitized fixtures.

**Integration verification:** real read-only upcoming agenda cross-checked against provider UI; write test event only after separate approval in a dedicated test calendar.

**Acceptance criteria:** authoritative identity is visible; read data is accurate; unsupported capabilities disabled; no fake sync.

**Rollout:** one read-only calendar; then allowlist; writes separately flagged per operation/calendar.

**Rollback:** disable adapter/use cached stale data; never delete provider events during rollback.

**Dependency:** A7/B3; write work after explicit approval.

**USER DECISION / STOP:** provider, account, destination calendar and write authorization are unresolved and mandatory.

**Security:** least scopes, encrypted tokens, callback/redirect validation, provider data minimisation, delete never inferred from transient missing page.

### B8 — Production hardening and completion gate

**Goal:** prove the whole system remains observable, recoverable and touch-natural under failure.

**Repositories:** both code repositories plus reviewed HA configuration/deployment docs; separate PRs if changes differ.

**Prerequisites:** B0–B7 as enabled; unresolved provider features may remain disabled.

**Likely files/modules:** full tests, fixtures, Windows production scripts, Panel Agent health, operations/runbooks, backup/restore and feature flags.

**Schemas/contracts:** compatibility/version matrix and rollout flags; no new domain semantics.

**Migrations:** only verified forward migrations from preceding phases.

**Implementation steps:** execute state matrix; network/HA/bot/provider outages; restart/reboot; backup restore; telemetry/redaction review; real Samsung resource/viewport trace; accessibility/touch-only pass; document operator response and rollback by flag.

**Tests:** full bot and Control Center suites; Playwright canonical matrix; contract compatibility; security negative tests; soak and restart/retry scenarios.

**Local verification:** clean setups on supported runtimes. Fix the current Python 3.9 `eval-type-backport`/declared-floor mismatch before calling setup reproducible.

**Integration verification:** staged real Samsung + live HA/custom skill + private Telegram; TickTick/calendar only if their gates passed.

**Acceptance criteria:** all issue #61 create/read/action paths work for the enabled capabilities; no P0/P1 audit item remains; disabled provider capability is honestly represented; rollback rehearsed.

**Rollout:** read-only → reminders → tasks → local calendar → optional voice/provider flags, with health soak between steps.

**Rollback:** flag/domain-specific; prior images/config retained; database/provider mutations reconciled rather than erased.

**Dependency:** final phase.

**USER DECISION / STOP:** operator approves production write enablement after canary evidence.

**Security:** final threat review covers transcript injection, SSRF, path/command injection, secret/log leakage, callback replay, CSRF, provider scopes and backup access.

## First implementation batch sizing

The first coding batch is **A1 only**. It is a bounded but correctness-sensitive backend PR: approximately 8–15 new/touched files, one SQLite schema/migration, repositories and focused tests. It needs medium context and significant test iteration around transactions, constraints, idempotency and restart/reopen behavior. It must not include import, scheduler, API, HA or UI work; keeping those out is the primary cost-control boundary.
