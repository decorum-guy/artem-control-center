# Home Assistant coffee contract

This review bundle mirrors the authorized local change in
`HomeAssistant_Server_Config/config`. Home Assistant is not a Git repository,
so the package is carried here for review and repeatable deployment. No secret
files, `.storage`, database, logs, tokens or private URLs are included.

## Contract

Home Assistant is the canonical authority for the physical device state,
availability, confirmed activation time, timing policy and command execution.
Telegram remains a user interface for changing the two timing helpers.

The package adds:

- `input_number.coffee_warmup_minutes` (initial value: 13);
- `input_number.coffee_long_running_minutes` (initial value: 60);
- `input_datetime.coffee_last_turned_on`;
- normalized running, long-running and ready-at template entities;
- stable scripts for coffee on/off and kettle boil/stop.

The activation automation has an exact `off` to `on` state trigger. An `on` to
`on` update, reconnect, duplicate command or Home Assistant startup therefore
does not replace the confirmed activation time.

The long-running entity means “works too long”. It is not an overheat or
temperature signal.

## Later deployment

1. Configure SSH aliases or direct `HA_READ_REMOTE`/`HA_WRITE_REMOTE` values as
   documented in `DEPLOYMENT.md`.
2. Run the existing portable `ha-push.sh plan` and review the remote diff.
3. Run `ha-push.sh apply` only in an approved maintenance task. It creates a
   remote backup, uploads the allow-listed configuration and runs HA
   `check_config`; it does not restart automatically.
4. Review the new helper values before any restart.
5. During an approved maintenance window, restart Home Assistant once.
6. Confirm every ID in `entity-manifest.json` exists.
7. Change one timing helper in a test window and verify the bot reads it.
8. Test device commands only with explicit production authorization.

This session did not reload or restart Home Assistant and did not call any
device service.

## Verification

Local validation checks YAML parsing with Home Assistant include tags,
manifest/entity naming, exact activation trigger semantics and script targets.
A real `hass --script check_config` remains a deployment gate because the local
workspace does not contain a Home Assistant runtime.
