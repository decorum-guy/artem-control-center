# ASUS ROG G703GI power control

This feature adds three fixed controls for the ASUS ROG G703GI Windows laptop:

- **Включить** — sends a Wake-on-LAN magic packet and waits for the selected ASUS backend to become reachable.
- **Сон** — asks the selected backend to enter Windows Sleep/suspend, then waits for that same backend to become unreachable.
- **Гибернация** — asks the selected backend to enter Windows S4 hibernation, then waits for that same backend to become unreachable.

The integration is disabled by default. It is deliberately a fixed device integration: the browser can select only the registered target and action IDs. It cannot provide a MAC address, host, URL, command, PowerShell text, or credentials.

## Architecture and status semantics

The control path is:

\`\`\`text
Control Center browser
  -> Panel Agent fixed action route
     -> fixed WOL sender (Wake only)
     -> exactly one selected power backend: HTTP companion or pinned SSH helper
\`\`\`

The WOL sender uses the backend-configured Ethernet MAC, a configured broadcast address/interface, UDP port 9, and a bounded burst of at most three canonical magic packets. A successful UDP send is not treated as proof that the ASUS is online. After Wake, successful `health` from the selected backend is authoritative, including while Windows is at its lock screen; no interactive-user or unlock condition is part of this state machine.

`PANEL_ROG_G703_TRANSPORT` selects exactly one backend. It defaults to `http` for backwards compatibility. There is no HTTP→SSH or SSH→HTTP fallback, racing health probe, or “either backend” online rule. The selected backend owns health, Sleep, and Hibernate together.

The companion exposes only these routes:

| Method | Route | Purpose |
| --- | --- | --- |
| \`GET\` | \`/health\` | Authenticated liveness check |
| \`POST\` | \`/hibernate\` | Authenticated fixed Windows S4 operation |
| \`POST\` | \`/sleep\` | Authenticated fixed Windows Sleep/suspend operation |

Both power endpoints accept no request body. Each returns an accepted response, flushes it, and then schedules its own fixed executor. \`/hibernate\` invokes the fixed equivalent of \`shutdown.exe /h\`; \`/sleep\` invokes \`SetSuspendState(FALSE, TRUE, FALSE)\`, which requests Windows Sleep/suspend rather than hibernation. Neither operation provides shutdown, restart, logoff, shell, command, URL, proxy, or arbitrary process operations.

The UI reports only \`Online\`, \`Offline\`, \`Waking\`, \`Sleeping\`, \`Hibernating\`, or \`Unavailable\`. Offline does not distinguish Sleep from Hibernate. Normal Shutdown/S5 is not presented by this integration.

## Configuration

Set these values in the Panel Agent runtime environment on the control machine after the ASUS companion is installed. Keep the local runtime file outside git.

\`\`\`dotenv
PANEL_ROG_G703_ENABLED=true
PANEL_ROG_G703_TARGET_ID=rog_g703gi
PANEL_ROG_G703_TRANSPORT=http
PANEL_ROG_G703_MAC=AA:BB:CC:DD:EE:FF
PANEL_ROG_G703_BROADCAST_ADDRESS=255.255.255.255
PANEL_ROG_G703_BROADCAST_INTERFACE=192.168.1.10
PANEL_ROG_G703_COMPANION_BASE_URL=http://192.168.1.25:8769
PANEL_ROG_G703_COMPANION_SECRET=<value-read-from-the-ASUS-secret-file>
PANEL_ROG_G703_WOL_REPEATS=3
PANEL_ROG_G703_WOL_COOLDOWN_SECONDS=5
PANEL_ROG_G703_SLEEP_COOLDOWN_SECONDS=10
PANEL_ROG_G703_HIBERNATE_COOLDOWN_SECONDS=10
PANEL_ROG_G703_HEALTH_TIMEOUT_SECONDS=60
PANEL_ROG_G703_SLEEP_TIMEOUT_SECONDS=45
PANEL_ROG_G703_HIBERNATE_TIMEOUT_SECONDS=45
\`\`\`

The MAC, companion address, and secret above are placeholders only. Do not commit real values. Startup validation rejects an invalid MAC, non-fixed target ID, unsafe broadcast/interface values, an origin containing credentials/query/fragment, or a secret shorter than 32 characters.

The existing global `PANEL_WRITES_ENABLED` gate and Panel Agent access profile still apply. Sleep and Hibernate use the same `standard` risk/access class. Keep that gate off during setup and enable it only when the broader write policy is intentionally enabled; the ROG feature does not bypass it.

The Panel Agent sends one fixed \`Authorization: Bearer ...\` header to the fixed origin and fixed routes. It does not follow redirects, accepts only bounded responses, and never logs the secret. The default transport is HTTP on the trusted home LAN; HTTP is not encrypted and must not be exposed to the public internet. The bootstrap firewall rule is LAN-scoped and can be narrowed to an explicit IPv4/CIDR.

The HTTP companion URL and secret are required only when \`PANEL_ROG_G703_TRANSPORT=http\` (the default). SSH settings are ignored in HTTP mode.

## Opt-in pinned SSH backend

SSH is a server-owned opt-in backend for reachability after Windows resume. Before selecting it, install the repository-owned fixed helper on the ASUS. The browser never receives or sends SSH host, user, port, key, known-hosts path, helper path, PowerShell, command, or arbitrary action data.

On the Panel Agent host, use a dedicated key and a dedicated pinned \`known_hosts\` file. These placeholders are required only for SSH mode:

\`\`\`dotenv
PANEL_ROG_G703_TRANSPORT=ssh
PANEL_ROG_G703_SSH_HOST=rog-g703gi.local
PANEL_ROG_G703_SSH_USER=artem-control
PANEL_ROG_G703_SSH_PORT=22
PANEL_ROG_G703_SSH_IDENTITY_FILE=C:\\ProgramData\\ArtemControlCenter\\keys\\rog-g703-ssh
PANEL_ROG_G703_SSH_KNOWN_HOSTS_FILE=C:\\ProgramData\\ArtemControlCenter\\keys\\rog-g703-known_hosts
PANEL_ROG_G703_SSH_CONNECT_TIMEOUT_SECONDS=3
PANEL_ROG_G703_SSH_COMMAND_TIMEOUT_SECONDS=10
PANEL_ROG_G703_SSH_OUTPUT_LIMIT_BYTES=4096
\`\`\`

Startup accepts only \`http\` or \`ssh\`. SSH host must be a hostname or literal address, and SSH user is a narrow Windows/OpenSSH-compatible identifier; whitespace, \`@\`, control characters, and shell syntax are rejected. Port must be 1–65535. \`PANEL_ROG_G703_SSH_CONNECT_TIMEOUT_SECONDS\` is an integer bounded to 1–10 seconds (default 3), so OpenSSH always receives an integer \`ConnectTimeout\`. The identity and dedicated \`known_hosts\` paths are server-only values and are checked again at runtime: a missing file fails closed without exposing the path.

The SSH client is argv-based (never a local shell) and uses \`BatchMode=yes\`, \`IdentitiesOnly=yes\`, \`StrictHostKeyChecking=yes\`, \`UserKnownHostsFile=<dedicated path>\`, \`GlobalKnownHostsFile=<platform null device>\`, \`ConnectionAttempts=1\`, \`NumberOfPasswordPrompts=0\`, \`PasswordAuthentication=no\`, \`KbdInteractiveAuthentication=no\`, the configured identity file, port, and bounded connect timeout. Setting \`GlobalKnownHostsFile\` to the platform null device prevents global host keys from widening or replacing the dedicated pinning policy. It invokes only this fixed remote helper plus one operation:

\`\`\`text
C:/ProgramData/ArtemControlCenter/RogG703Ssh/rog-g703-ssh-helper.ps1 health|sleep|hibernate
\`\`\`

The helper accepts exactly \`health\`, \`sleep\`, and \`hibernate\`. \`health\` writes exactly \`{"schemaVersion":1,"ok":true,"status":"online"}\`. Sleep and Hibernate start a fixed delayed local transition, emit and flush exactly \`{"schemaVersion":1,"accepted":true,"operation":"sleep|hibernate"}\`, and exit before power loss. Sleep uses \`SetSuspendState(FALSE, TRUE, FALSE)\`; Hibernate invokes \`shutdown.exe /h\`. It has no generic shell, scriptblock, command, or trailing operation arguments.

Install the helper locally on the ASUS from this checkout in an elevated PowerShell window; this does not change sshd, the firewall, credentials, or a live connection:

\`\`\`powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-ssh-helper.ps1 -Action install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-ssh-helper.ps1 -Action status
\`\`\`

It copies the helper only to \`C:\\ProgramData\\ArtemControlCenter\\RogG703Ssh\\rog-g703-ssh-helper.ps1\` and applies an ACL with administrator/SYSTEM modification rights and ordinary-user read/execute access. Physical key provisioning, host-key capture/pinning, and updating protected Panel Agent runtime configuration are deliberate post-merge owner actions; this repository change does not execute them.

### Owner-authorized SSH physical acceptance

HTTP remains the default backend. SSH is opt-in and must be configured only during an owner-authorized physical setup window:

1. Install the fixed SSH helper locally on the ASUS first; do not remove or alter the HTTP companion merely to use SSH.
2. Verify the owner's existing SSH access and account details before editing Panel Agent runtime settings. This slice does not configure sshd, its firewall, or an account.
3. Provision a dedicated Panel-Agent-side key and a separate pinned \`known_hosts\` file. Keep real host, user, key, and file paths in protected runtime configuration only—never in browser state, chat, source, or documentation examples.
4. Prove one direct fixed-helper \`health\` invocation over SSH using that pinned configuration before setting \`PANEL_ROG_G703_TRANSPORT=ssh\`.
5. Change the protected Panel Agent runtime settings and restart/reload it only through the established production mechanism during that authorized setup.
6. Accept the physical cycle: Online → Sleep → Offline → Wake → Windows lock screen → automatically Online without unlock; then Online → Hibernate → Offline → Wake → lock screen → automatically Online without unlock.

There is no automatic HTTP fallback in SSH mode. Selecting SSH does not require installing or deleting the old HTTP companion; exactly one selected backend remains authoritative.

## FIRST MANUAL ASUS INSTALL

This first install does not require Mac-to-ASUS SSH. Perform it locally on the ASUS in an **elevated PowerShell** window.

Prerequisite: Python 3.10 or newer must already be installed on the ASUS and available as \`python.exe\` or \`py.exe -3\`. The bootstrap uses only the Python standard library and does not download a runtime, third-party service wrapper, or unsigned binary.

From the checked-out repository on the ASUS:

\`\`\`powershell
git fetch origin
git switch main
git pull --ff-only origin main

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action install -ListenAddress 0.0.0.0 -Port 8769 -FirewallRemoteAddress LocalSubnet -FirewallProfile Private
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action status
\`\`\`

The install command is idempotent. It copies the companion to \`%ProgramData%\\ArtemControlCenter\\RogG703Companion\`, generates a 48-byte random secret on first install, protects the secret/configuration with restrictive ACLs, registers the deterministic startup task to run as \`SYSTEM\`, creates the narrowly scoped Windows Firewall rule, starts the task, and performs a local authenticated health check.

The generated secret is not printed. When it is time to configure Panel Agent locally, an administrator can read it on the ASUS with:

\`\`\`powershell
Get-Content -Raw "$env:ProgramData\\ArtemControlCenter\\RogG703Companion\\companion.secret"
\`\`\`

Copy that value only into the protected Panel Agent runtime configuration on the control machine. Never paste it into source control, browser state, issue comments, or chat.

## Companion maintenance commands

Run these commands in an elevated PowerShell window from the repository checkout. \`install\` is both install and update: after pulling a newer branch revision, it preserves the existing secret while replacing the companion and re-registering the task/rule.

\`\`\`powershell
# Status and authenticated local health
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action status

# Update files/configuration and restart the startup task
git pull --ff-only origin main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action install -ListenAddress 0.0.0.0 -Port 8769 -FirewallRemoteAddress LocalSubnet -FirewallProfile Private

# Restart only, then verify local health
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action status

# Remove only this feature's task, firewall rule, and dedicated runtime directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action uninstall
\`\`\`

Uninstall does not remove unrelated project data or other Windows services. It removes the task named \`Artem Control Center ROG G703 Companion\`, the matching deterministic firewall rule, and the dedicated companion directory.

## Notices and confirmation

Wake uses the existing action/access model without a destructive confirmation. Sleep and Hibernate reuse the existing \`ActionConfirmationProvider\` with target-specific text:

> Перевести ASUS ROG G703GI в гибернацию?

> Перевести ASUS ROG G703GI в сон?

The existing global NoticeCenter reports the bounded transition, for example \`Пакет пробуждения отправлен\`, \`ASUS появился в сети\`, \`ASUS переходит в сон\`, \`ASUS переходит в гибернацию\`, \`ASUS больше не отвечает — переход подтверждён\`, or a failure/timeout. There is no second toast system and no native \`window.confirm\` prompt.

## Physical ASUS acceptance checklist

Physical acceptance is intentionally deferred to the user:

1. Install the bootstrap on the ASUS.
2. Verify local companion health.
3. Verify Panel Agent reports Online.
4. Trigger Hibernate.
5. Verify the ASUS actually enters Windows S4.
6. Wait until the UI reports Offline.
7. Trigger Wake.
8. Verify the ASUS resumes from S4.
9. Verify the UI reports Online.
10. Repeat the Hibernate/Wake cycle twice.
11. Verify that no S5 Shutdown path is presented.

Physical ASUS acceptance is pending.
