# Official References

External capabilities must be revalidated against current official documentation during implementation.

## Home Assistant

- REST API: https://developers.home-assistant.io/docs/api/rest/
- WebSocket API: https://developers.home-assistant.io/docs/api/websocket/
- Backup integration: https://www.home-assistant.io/integrations/backup/
- General backup and restore tasks: https://www.home-assistant.io/common-tasks/general/
- Supervisor backup endpoints: https://developers.home-assistant.io/docs/api/supervisor/endpoints/

Implementation note:

Home Assistant officially supports creating/restoring backups and migration to other hardware. This is used for the proposed warm-standby process. The active-primary/edge/warm-standby policy itself is an Artem Control Center architecture decision, not a claim of built-in Home Assistant clustering.

## TickTick

- API support entry: https://help.ticktick.com/articles/7055781495671095296
- Open API documentation: https://developer.ticktick.com/docs#/openapi
- Official downloads, including Linux: https://ticktick.com/download
- Calendar subscriptions: https://help.ticktick.com/articles/7055781614550253568
- TickTick feeds in third-party calendars: https://help.ticktick.com/articles/7055781574649839616

Implementation note:

The official API and Linux client exist, but exact write/read coverage required by Control Center must be tested. The system must not assume that all TickTick application features are exposed through the Open API.

## Apple Calendar / iCloud

- iCloud Calendar overview: https://support.apple.com/guide/icloud/what-you-can-do-with-icloud-and-calendar-mm15eb200ab4/icloud
- Calendar accounts and CalDAV on iPhone: https://support.apple.com/guide/iphone/change-calendar-settings-iphc37be2016/ios

Implementation note:

“Calendar on iPhone” may aggregate iCloud, Google, Exchange and CalDAV accounts. The project must identify the authoritative account before choosing a write integration.
