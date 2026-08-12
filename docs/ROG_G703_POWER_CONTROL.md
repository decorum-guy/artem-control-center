# ASUS ROG G703GI power control

This feature adds two fixed controls for the ASUS ROG G703GI Windows laptop:

- **Включить** — sends a Wake-on-LAN magic packet and waits for the ASUS companion to become reachable.
- **Гибернация** — asks the companion to enter Windows S4 hibernation, then waits for the companion to become unreachable.

The integration is disabled by default. It is deliberately a fixed device integration: the browser can select only the registered target and action IDs. It cannot provide a MAC address, host, URL, command, PowerShell text, or credentials.

## Architecture and status semantics

The control path is:

\`\`\`text
Control Center browser
  -> Panel Agent fixed action route
     -> fixed WOL sender or fixed authenticated ASUS companion
\`\`\`

The WOL sender uses the backend-configured Ethernet MAC, a configured broadcast address/interface, UDP port 9, and a bounded burst of at most three canonical magic packets. A successful UDP send is not treated as proof that the ASUS is online.

The companion exposes only these routes:

| Method | Route | Purpose |
| --- | --- | --- |
| \`GET\` | \`/health\` | Authenticated liveness check |
| \`POST\` | \`/hibernate\` | Authenticated fixed Windows S4 operation |

\`POST /hibernate\` accepts no request body. It returns an accepted response, flushes it, and then invokes the fixed equivalent of \`shutdown.exe /h\`. It does not provide shutdown, restart, logoff, shell, command, URL, proxy, or arbitrary process operations.

The UI reports only \`Online\`, \`Offline\`, \`Waking\`, \`Hibernating\`, or \`Unavailable\`. Offline does not distinguish Sleep from Hibernate. The intended effective off state for this laptop is Hibernate/S4; normal Shutdown/S5 is not presented by this integration.

## Configuration

Set these values in the Panel Agent runtime environment on the control machine after the ASUS companion is installed. Keep the local runtime file outside git.

\`\`\`dotenv
PANEL_ROG_G703_ENABLED=true
PANEL_ROG_G703_TARGET_ID=rog_g703gi
PANEL_ROG_G703_MAC=AA:BB:CC:DD:EE:FF
PANEL_ROG_G703_BROADCAST_ADDRESS=255.255.255.255
PANEL_ROG_G703_BROADCAST_INTERFACE=192.168.1.10
PANEL_ROG_G703_COMPANION_BASE_URL=http://192.168.1.25:8769
PANEL_ROG_G703_COMPANION_SECRET=<value-read-from-the-ASUS-secret-file>
PANEL_ROG_G703_WOL_REPEATS=3
PANEL_ROG_G703_WOL_COOLDOWN_SECONDS=5
PANEL_ROG_G703_HIBERNATE_COOLDOWN_SECONDS=10
PANEL_ROG_G703_HEALTH_TIMEOUT_SECONDS=60
PANEL_ROG_G703_HIBERNATE_TIMEOUT_SECONDS=45
\`\`\`

The MAC, companion address, and secret above are placeholders only. Do not commit real values. Startup validation rejects an invalid MAC, non-fixed target ID, unsafe broadcast/interface values, an origin containing credentials/query/fragment, or a secret shorter than 32 characters.

The existing global `PANEL_WRITES_ENABLED` gate and Panel Agent access profile still apply. Keep that gate off during setup and enable it only when the broader write policy is intentionally enabled; the ROG feature does not bypass it.

The Panel Agent sends one fixed \`Authorization: Bearer ...\` header to the fixed origin and fixed routes. It does not follow redirects, accepts only bounded responses, and never logs the secret. The default transport is HTTP on the trusted home LAN; HTTP is not encrypted and must not be exposed to the public internet. The bootstrap firewall rule is LAN-scoped and can be narrowed to an explicit IPv4/CIDR.

## FIRST MANUAL ASUS INSTALL

This first install does not require Mac-to-ASUS SSH. Perform it locally on the ASUS in an **elevated PowerShell** window.

Prerequisite: Python 3.10 or newer must already be installed on the ASUS and available as \`python.exe\` or \`py.exe -3\`. The bootstrap uses only the Python standard library and does not download a runtime, third-party service wrapper, or unsigned binary.

From the checked-out repository on the ASUS:

\`\`\`powershell
git fetch origin
git switch feat/rog-g703-power-controls
git pull --ff-only origin feat/rog-g703-power-controls

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
git pull --ff-only origin feat/rog-g703-power-controls
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action install -ListenAddress 0.0.0.0 -Port 8769 -FirewallRemoteAddress LocalSubnet -FirewallProfile Private

# Restart only, then verify local health
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action status

# Remove only this feature's task, firewall rule, and dedicated runtime directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-rog-g703-companion.ps1 -Action uninstall
\`\`\`

Uninstall does not remove unrelated project data or other Windows services. It removes the task named \`Artem Control Center ROG G703 Companion\`, the matching deterministic firewall rule, and the dedicated companion directory.

## Notices and confirmation

Wake uses the existing action/access model without a destructive confirmation. Hibernate reuses the existing \`ActionConfirmationProvider\` with the target-specific text:

> Перевести ASUS ROG G703GI в гибернацию?

The existing global NoticeCenter reports the bounded transition, for example \`Пакет пробуждения отправлен\`, \`ASUS появился в сети\`, \`ASUS переходит в гибернацию\`, \`ASUS больше не отвечает — гибернация подтверждена\`, or a failure/timeout. There is no second toast system and no native \`window.confirm\` prompt.

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
