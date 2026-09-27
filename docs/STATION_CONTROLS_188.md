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
