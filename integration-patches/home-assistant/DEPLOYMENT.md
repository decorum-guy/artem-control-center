# Portable Home Assistant configuration workflow

The existing `ha-push.sh` now resolves its own directory and accepts either SSH
aliases or direct `user@host` targets:

```bash
export HA_READ_REMOTE=user@home-assistant-host
export HA_WRITE_REMOTE=root@home-assistant-host
export HA_REMOTE_ROOT=/home/codex/homeassistant
```

Requirements are Bash, OpenSSH, `rsync`, `diff` and `mktemp`. The script never
edits `~/.ssh/config`; key distribution and host verification remain normal
OpenSSH setup outside this repository.

```bash
./ha-push.sh plan       # default; read-only diff and rsync dry-run
./ha-push.sh status     # read-only docker compose status
./ha-push.sh apply      # YES → backup → upload → check_config; no restart
./ha-push.sh restart    # explicit legacy restart/action menu
```

After an approved HA restart creates the helpers, initialize them explicitly:

```bash
python scripts/migrate_coffee_timing_to_ha.py status
python scripts/migrate_coffee_timing_to_ha.py dry-run
python scripts/migrate_coffee_timing_to_ha.py apply  # separately approved
```

`apply` verifies both timing values before setting
`input_boolean.coffee_timing_initialized`. It is never part of bot/HA startup.
Do not initialize by editing `.storage` or by adding YAML `initial` values.

This change did not run any remote mode, HA reload/restart or device action.
