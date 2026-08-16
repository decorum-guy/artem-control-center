# Planning iCloud Calendar Phase B

Phase B projects the read-only iCloud contract owned by Alice Phase A into
Control Center. The trust boundary is deliberately one-way:

```text
iCloud / CalDAV -> Alice provider adapter + SQLite cache
                 -> planning.v1 sources
                 -> Panel Agent strict projection
                 -> planning.panel.v1
                 -> Calendar V2 browser
```

Panel Agent is not an iCloud provider or a second calendar cache. It performs
strict parsing, joins event calendar identity by canonical IDs, and emits only
browser-safe source metadata.

## Rolling contract

Alice responses may be deployed before or after this Control Center change.
The upstream models in `apps/panel-agent/src/panel_agent/planning.py` accept
both:

- old list/object/status responses with no `sources` field; and
- the merged Alice additive `sources` extension.

The extension is typed as bounded `UpstreamPlanningSource` and
`UpstreamSourceCalendar` models. Unknown fields, unsupported providers,
non-UTC timestamps, invalid colors, oversized source/calendar lists, and
unsanitized error codes fail closed. The same optional field is accepted on
list, object/readback, status, reminder mutation, task mutation, and event
mutation envelopes. Old Alice therefore continues to provide the existing
native Planning behavior and does not manufacture an iCloud source.

The Panel Agent cache has a narrow, explicit read migration for the former
native `local_only` provider status. It does not accept arbitrary legacy
objects or weaken the cache envelope validator.

## Browser-safe source and calendar identity

The existing `providerStatuses` foundation is now provider-neutral. Its
browser-safe source fields are `id`, `kind`, `provider`, `label`, `status`,
`configured`, `lastSyncedAt`, `observedAt`, and bounded calendar entries with
`id`, `label`, optional validated color, `enabled`, status, and timestamps.

Native Planning retains the stable source ID `native-planning`. External
source IDs are deterministic SHA-256 derivations over a namespaced provider
and Alice account identity. Browser calendar IDs are similarly derived from
the safe source ID and the canonical upstream calendar ID. Python's
randomized `hash()` and display labels are not used.

For imported events, the adapter joins
`event.provider_calendar_id` to `sources[].calendars[].calendarId`. It never
matches by calendar name, title, or time. A missing join fails closed with a
sanitized identity error. Native events retain the existing Local Planning /
Локальный identity. Same-name iCloud calendars receive distinct deterministic
short suffixes based on their browser-safe IDs, so neither duplicate labels
nor absent colors collapse two calendars.

Upstream account IDs, raw provider calendar IDs, resource references, hrefs,
CalDAV URLs, credentials, error details, correlation IDs, and transport
metadata are dropped before `planning.panel.v1`. They are not persisted in
browser state or localStorage and cannot become `CalendarEvent.source_ref`.

## Freshness and failure behavior

The global Planning `sourceStatus` remains the canonical Planning API health
and mutation gate. It is not recomputed from the worst external provider.
Per-source statuses are `current`, `stale`, `error`, `not_configured`, and
`disabled`.

Thus native Planning can remain `current` and writable while iCloud is
`stale` or `error`. A cached iCloud event remains visible with a compact
`Сохранённая копия` cue and its last successful update. An error without a
successful cache does not turn the Calendar route into a global outage;
native events remain readable. Disabled and not-configured states are shown
quietly in the source strip rather than as a route failure.

The generic Planning projection cache may retain a complete normalized
projection for transport fallback. Its source status is transitioned
conservatively on failure; it never invents a current iCloud status.

## Read-only and mutation boundary

Phase B consumes only:

- `GET /api/v1/planning/events`;
- `GET /api/v1/planning/events/{id}`; and
- the existing `GET /api/v1/planning/status` path where applicable.

There is no iCloud route, provider action, proxy, browser-selected href, or
external write capability. Imported events remain `localOnlyMutable = false`
and their detail sheet has no Edit/Delete actions. Native local-only events
retain the existing B4.3 Create/Edit/Delete guards, including access policy,
interaction lock, capability, canonical source status, If-Match, and
idempotency checks. An iCloud outage therefore cannot disable native local
Calendar mutation.

## UI scope

Calendar keeps the existing Today/Agenda, day navigation, all-day band,
timed rows, overlap indicator, detail Sheet, and OSK-safe mutation Sheet.
Phase B adds only:

- a compact source/freshness strip near route metadata;
- safe provider/calendar labels on event rows and details;
- a concise stale cue on cached external rows; and
- source status and last successful sync in external details.

Source status is not treated as a temporal conflict. Overlap remains based on
event time ranges, including exclusive-end all-day semantics. Calendar names,
titles, notes, and locations remain literal React text; no HTML interpretation
is introduced.

## Real-runtime boundary

This phase uses deterministic Panel Agent/browser fixtures only. It does not
request or store an Apple ID, app-specific password, CalDAV URL, or any other
runtime secret, and CI never contacts iCloud. Real-runtime activation is a
later owner-directed step that places secrets in Alice's server environment,
outside the browser and outside this pull request.
