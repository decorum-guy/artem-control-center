# Rollback

Rollback is intentionally a configuration-only maintenance operation:

1. Stop any pending Control Center or bot timing-helper migration.
2. Remove `config/packages/coffee_control_center.yaml`.
3. Remove the `homeassistant.packages` include only when it was added solely for
   this package and no other packages use it.
4. Run Home Assistant Configuration Check.
5. Restart Home Assistant only in an approved maintenance window.
6. Restore the previous `configuration.yaml` backup if validation fails.

Removing the package removes the canonical helper entities and stable scripts.
It does not switch the coffee machine or kettle and it must not be coupled to a
device command.

If only the bot build is rolled back, keep the HA helpers and marker intact.
Do not reset timing values: they are durable user configuration. Before
removing the HA package, export the current non-secret timing values into the
maintenance record so a later reinstall can bootstrap deliberately.
