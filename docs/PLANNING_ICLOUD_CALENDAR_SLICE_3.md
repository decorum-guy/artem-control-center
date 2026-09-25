# Planning iCloud calendar bridge — Slice 3

Slice 3 adds a narrow Panel Agent bridge to the merged AliceTG_Bot provider
mutation routes. It is intentionally additive: older Alice responses without
`mutationCapabilities` or `providerCapabilities` remain valid, while unknown
fields and malformed capability values still fail strict validation.

## Browser-safe read contract

`GET /api/v1/planning/calendar-destinations` projects Alice's destination list
to bounded browser identities. Provider account IDs, raw calendar IDs, ETags,
URLs, and correlation IDs never cross the Panel Agent boundary. The adapter
keeps the reverse mapping only in bounded server memory and returns an empty,
degraded destination list when the additive upstream route is unavailable.

Calendar event projections retain `localOnlyMutable` and add optional
`canEdit`, `canDelete`, and `providerWriteState` fields. Missing capability
metadata is accepted for compatibility; old provider events therefore remain
read-only. Local events keep their existing local-only mutation behavior.

## Fixed provider routes

The upstream client allowlist is limited to:

```text
GET    /internal/planning/v1/calendar-destinations
POST   /internal/planning/v1/provider-events
PATCH  /internal/planning/v1/provider-events/{provider_event_id}
DELETE /internal/planning/v1/provider-events/{provider_event_id}
POST   /internal/planning/v1/provider-calendars
DELETE /internal/planning/v1/provider-calendars/{provider_calendar_id}
```

Panel routes expose the same narrow operations under `/api/v1/planning/` and
accept only hashed browser destination IDs. The adapter resolves those IDs to
Alice's opaque identifiers internally; no generic proxy or raw-ID route exists.
Provider create, update, and delete requests preserve the single-attempt
idempotency behavior. The browser does not replay provider writes. For
provider update/delete, an uncertain result may perform one canonical event
readback; provider create remains explicitly uncertain until a later refresh.

## Gates and UI behavior

Provider writes require all of the following:

1. Planning is enabled.
2. The existing frontend and server calendar mutation gates are enabled.
3. `PANEL_PLANNING_PROVIDER_CALENDAR_MUTATIONS_ENABLED=true`.
4. Alice status is current/healthy and advertises configured provider writes.
5. The selected event or destination capability allows the operation.

The existing calendar editor is reused. Provider event editing keeps the
current calendar fixed and does not offer a move-calendar operation. Read-only
events show the existing read-only footer. No full provider settings or
collection-management UI is part of this slice; the provider calendar routes
are covered for the next narrow consumer.

This slice stops before deployment. Merge, staged enablement, and any provider
credential/configuration changes remain separate operational steps.
