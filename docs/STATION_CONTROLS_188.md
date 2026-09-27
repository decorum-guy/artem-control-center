# Station Mini 2 Control Center surface (#188)

Overview V2 includes a fixed `home.station-mini-2` widget with seven commands:
`media.alice.play`, `media.alice.pause`, `media.alice.volume_down`,
`media.alice.volume_up`, `media.alice.previous`, `media.alice.next`, and
`media.alice.like`. The browser sends only an action ID and UUID to
`POST /api/v1/actions/station`; it never receives Station, Home Assistant,
or Alice credentials or command text.

The Panel Agent requires `PANEL_WRITES_ENABLED=true`,
`PANEL_ALICE_STATION_ACTIONS_ENABLED=true`, Standard or Full access, and the
existing private Alice tunnel settings `PANEL_ALICE_BASE_URL` and
`PANEL_ALICE_CONTROL_CENTER_TOKEN`. The Station gate defaults to `false`.
The existing Alice health integration must be live and healthy. Panel Agent
forwards one fixed action to AliceTG_Bot's private endpoint and does not retry
transport uncertainty. A response confirms dispatch only, not speaker state.

The speaker image slot currently uses a local outline icon. Replace its child
with the owner's transparent PNG after that asset is provided. The glow is
brief interaction feedback and does not represent playback state. Owner-run
hardware acceptance is required after Orchestrator review and deployment.

## Shared music presets

The widget keeps its seven fixed controls and adds one wide `🎵 Музыка` button.
Its custom sheet reads AliceTG_Bot's canonical ordered inventory through Panel
Agent. Rows are at least 48px high. The management sheet shows titles, adds a
preset with title and Alice command, and requires confirmation to delete one.
Successful mutations refresh the inventory immediately; a stale revision
refreshes it with a bounded conflict message. Telegram reads the same list on
its next menu render.

Panel Agent exposes typed inventory, add/delete, and preset execution routes
under `/api/v1/actions/station/presets`. Execution browser JSON contains only
`presetId` and `requestId`; Panel forwards only the ID in the URL and the UUID
in its private request body. A stored command appears solely in the protected
configuration add payload. AliceTG_Bot resolves the ID against its existing
`APP_STATE_PATH` collection and uses its single-attempt Station transport.
There is no generic Alice command execution surface.

Add/delete and execute require writes enabled, the existing Station actions
gate, Standard or Full access, and a live Alice integration. Execution shares
the Station action lock and is never retried on uncertain delivery. Inventory
contains only ID/title plus collection revision and timestamp; it does not
expose stored commands or HA internals. The defaults are `Избранное`,
`Спокойная`, and `Энергичная`; AliceTG_Bot seeds them only when the collection
has never existed. A deleted default or intentionally empty list stays that
way after restart.
