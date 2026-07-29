# Coffee runtime baseline

Sanitized read-only snapshot captured on 2026-07-29 before deploying the
canonical Home Assistant package or the new AliceTG Bot build. No HA service
call, migration, reload, restart or device command was performed.

## Observed runtime

- Home Assistant entity: `switch.kofemashina`.
- HA state: `on`.
- HA `last_changed`: `2026-07-29T12:58:19.043352+00:00`.
- HA `last_updated`: `2026-07-29T12:58:19.043352+00:00`.
- Most recent recorder transition `off → on`:
  `2026-07-29T12:58:19.043352+00:00`.
- Bot `coffee_on_since`: `2026-07-29T12:58:19.043352+00:00`.
- HA and bot activation timestamps match exactly for this activation.

The first immutable database read omitted the active SQLite WAL and returned
an older `off` row. The baseline above comes from a read-only SQLite connection
that includes the existing WAL; it is the current recorder result.

## Effective timing and alerts

- Warm-up duration: `900` seconds (15 minutes).
- Long-running warning threshold: `3600` seconds (60 minutes).
- Warm-up deadline: `2026-07-29T13:13:19.043352+00:00`.
- Long-running warning deadline: `2026-07-29T13:58:19.043352+00:00`.
- At capture time both alert classes were enabled and neither was recorded as
  delivered.

A passive read-only check after the warm-up deadline found the iPhone warm-up
delivery flag set to `true`; the Telegram warm-up flag remained `false`.
Long-running delivery flags remained `false`. This confirms that the warm-up
deadline fired on at least one configured channel without waiting for or
triggering the 60-minute warning.

A subsequent sanitized notification-policy read confirmed how that cycle was
configured:

- warm-up Telegram channel: disabled; delivered: no;
- warm-up iPhone channel: enabled; delivered: yes.

Sanitized scheduler-log counts for the deadline showed zero Telegram attempts,
one mobile attempt, one mobile success, one completed all-effective-channels
delivery and no retry. Raw logs, identifiers, target names and message content
were not copied.

The coffee machine was already off during that subsequent read, so the bot had
reset the current-cycle receipts to `false` as designed. The delivery result
above is the post-deadline snapshot captured while documenting this activation,
not the later post-cycle reset. Full storage, routing and ownership findings are
in [`../NOTIFICATION_ARCHITECTURE.md`](../NOTIFICATION_ARCHITECTURE.md).

The 60-minute value is not warm-up duration and is not a physical overheat
signal. It means only “работает слишком долго”.

Active task status is derived from the bot's sanitized persisted scheduler
state and deadlines. The current production build has no protected diagnostic
endpoint that enumerates in-memory asyncio task objects, so exact task object
identity is not asserted.

## Safety and scope

Only the target HA entity history and allow-listed coffee scheduler fields were
read through `ha-vps`. Tokens, Telegram identifiers, message text, webhooks and
unrelated HA state were not emitted. The prepared HA patch and bot migration
were not applied.
