# Private Home Assistant and AliceTG production connectivity

Artem Control Center keeps the AliceTG Bot internal API private. The Samsung
never connects to `/internal/*` through Caddy or a public domain. It uses a
dedicated SSH key and two loopback-only local forwards:

```text
Samsung 127.0.0.1:18123 -> SSH -> VPS 127.0.0.1:18123 -> Home Assistant :8123
Samsung 127.0.0.1:18088 -> SSH -> VPS 127.0.0.1:18088 -> AliceTG Bot :8088
```

The VPS ports must be published only on `127.0.0.1`. They must not bind to
`0.0.0.0`, a public interface or Caddy. The tunnel key is independent from the
Mac administration key and has no shell, PTY, agent forwarding, X11 forwarding
or access to arbitrary destinations.

## Windows runtime

`install-connectivity-tunnel.ps1` creates:

- `%USERPROFILE%\.ssh\artem_control_center_tunnel`;
- an idempotent marked block in `%USERPROFILE%\.ssh\config`;
- `%LOCALAPPDATA%\ArtemControlCenter\connectivity.json`;
- `%LOCALAPPDATA%\ArtemControlCenter\connectivity-state.json`;
- Scheduled Task `Artem Control Center Connectivity`;
- desktop Start, Stop, Status and Configure helpers.

The task runs after interactive logon and supervises one owned `ssh.exe -N -T`
process. It probes both local ports every five seconds, restarts after a broken
forward with bounded backoff and exits non-zero after ten failed attempts in ten
minutes so Task Scheduler can recover it. Stop operations use the PIDs recorded
in `connectivity-state.json`; they never kill every SSH or PowerShell process.

The installer initially writes a manual-stop marker. This prevents a retry loop
before the generated public key is installed on the VPS. After server setup,
start the tunnel through `Start Control Center Connectivity.cmd` or
`start-connectivity-tunnel.ps1`.

## Production integration configuration

`configure-home-production.ps1` prompts securely for three values:

- a dedicated Home Assistant long-lived token;
- AliceTG Bot `CONTROL_CENTER_API_TOKEN`;
- AliceTG Bot `INTERNAL_WEBHOOK_SECRET` for sanitized health details.

The values are never printed. They are stored only in protected
`runtime.env`, whose ACL grants Full Control to the panel account and SYSTEM.
The script first verifies:

1. Home Assistant authentication through the private tunnel;
2. AliceTG process and readiness health;
3. authenticated AliceTG health details;
4. authenticated canonical coffee timing API.

It then switches Panel Agent to `production` with all mutation gates disabled,
restarts it and waits for a live Home Assistant REST snapshot, an authenticated
Home Assistant WebSocket subscription and healthy AliceTG monitoring. Only
after those checks pass does it enable coffee mutation transport gates. Access
profiles and PIN authorization still apply at the Panel Agent boundary.

A backup of `runtime.env` is restored automatically when verification fails.
AVALAR and unrelated settings are preserved.

## Fail-closed behavior

- `fixtures` never represents a physical command in the Windows production
  runtime;
- an unavailable tunnel leaves integrations degraded/offline and actions
  disabled;
- an Alice response alone never confirms a coffee action: Panel Agent performs
  a fresh Home Assistant read after the bot reports success;
- cached or stale Home Assistant state cannot enable a new coffee action;
- no generic HA proxy, shell command or user-supplied entity/service is exposed.

## Status and logs

Use:

```powershell
.\scripts\windows\status-connectivity.ps1 -Json
.\scripts\windows\status-production.ps1 -Json
```

The unified production status includes tunnel process ownership, local port
readiness, Home Assistant WebSocket state, AliceTG health and AVALAR Main/Stage
health. It never returns tokens.

Logs are written under:

```text
%LOCALAPPDATA%\ArtemControlCenter\logs
```

SSH stdout/stderr logs contain only connection diagnostics. Runtime environment
values are never copied into logs.

## Rollback

1. Run `Stop Control Center Connectivity.cmd` to create a persistent manual-stop
   marker and stop only the owned tunnel processes.
2. Restore a previous protected `runtime.env` or run the production configurator
   again after fixing the VPS.
3. Start the panel normally. Incomplete production settings remain fail-closed.

Do not delete the dedicated private key during routine rollback. Rotate it by
removing the marked authorized-key entry on the VPS, deleting the local key pair
and rerunning the connectivity installer.
