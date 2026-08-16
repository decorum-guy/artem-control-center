# B4 Phase 3 — local-only Calendar event mutations

Control Center B4.3 exposes local event CRUD through the existing AliceTG Bot
Planning contract. AliceTG Bot SQLite remains the canonical source of truth;
this surface does not write iCloud, CalDAV, Google, Exchange, TickTick, or any
other provider.

The browser uses only these same-origin routes:

| Operation | Control Center route | Alice route |
| --- | --- | --- |
| read by ID | `GET /api/v1/planning/events/{id}` | `GET /internal/planning/v1/events/{id}` |
| create | `POST /api/v1/planning/events` | `POST /internal/planning/v1/events` |
| edit | `PATCH /api/v1/planning/events/{id}` | `PATCH /internal/planning/v1/events/{id}` |
| logical delete | `DELETE /api/v1/planning/events/{id}` | `DELETE /internal/planning/v1/events/{id}` |

Create accepts only canonical event fields and Alice creates it as
`sync_state=local_only` with no provider ownership. Edit and delete require
the canonical object to satisfy all three conditions:

```text
sync_state == "local_only"
provider_id is null
provider_calendar_id is null
```

Panel Agent derives `localOnlyMutable` server-side and does not relay raw
provider IDs. Provider events remain truthful, readable, and visibly
read-only. Logical delete returns the canonical tombstone; it never removes a
database row or performs provider work.

Every create carries `Idempotency-Key`. Edit and delete carry both
`Idempotency-Key` and `If-Match`. For a new mutation, local-only ownership is
verified after idempotency claim/new determination and before any domain write.
If that precondition rejects, the transaction rolls back the tentative claim
as well as the rejected mutation, leaving no event, audit, idempotency, outbox,
or provider changes.

Exact stored replays remain governed by the A4 idempotency contract. A replay
of the same authenticated audience, key, and request hash returns the exact
historical response and does not execute a second domain mutation or re-check
current ownership. A new key is a new logical mutation and must inspect the
current canonical local-only predicate.

The Calendar composer uses the canonical parser preview. Explicit timed ranges
and supported all-day ranges can be saved when unambiguous. A start-only
timed event's proposed +60 minute end is displayed with Alice's sole
`end_time` proposal ambiguity and requires an explicit “Принять 60 минут”
acknowledgement. Any additional ambiguity, including `date`, keeps Save
disabled. Vague time such as `вечером` also remains blocked. Recurrence and
provider sync remain disabled.
