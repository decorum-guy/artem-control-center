# AVALAR Samsung SSH identities

AVALAR monitoring and infrastructure actions use two independent ed25519 key
pairs. The Mac administration identity is never copied to the Samsung.

Run `scripts/windows/install-avalar-identities.ps1` on the panel account. It
creates:

```text
%USERPROFILE%\.ssh\artem_control_center_avalar_status
%USERPROFILE%\.ssh\artem_control_center_avalar_status.pub
%USERPROFILE%\.ssh\artem_control_center_avalar_actions
%USERPROFILE%\.ssh\artem_control_center_avalar_actions.pub
```

It also installs two marked SSH aliases:

```text
avalar-status
avalar-control
```

Both aliases use `BatchMode`, `IdentitiesOnly`, no TTY and the same authoritative
REG.RU host/account. They differ only by identity file.

Only the public halves are copied into the protected runtime exchange files:

```text
%LOCALAPPDATA%\ArtemControlCenter\avalar-status-public-key.txt
%LOCALAPPDATA%\ArtemControlCenter\avalar-action-public-key.txt
```

The server installs each public key through its separate restricted installer:

```bash
~/.avalar-control-center/bin/install-control-center-key.sh status
~/.avalar-control-center/bin/install-control-center-key.sh actions
```

The status identity can request only status/details. The action identity can
request only fixed smoke/restart/deploy operations. Neither identity receives a
shell, PTY, forwarding, agent or X11 access.

Panel Agent stores only alias names in `runtime.env`:

```text
PANEL_AVALAR_SSH_HOST=avalar-status
PANEL_AVALAR_ACTION_SSH_HOST=avalar-control
PANEL_AVALAR_SSH_STATUS_COMMAND=control-center
PANEL_AVALAR_ACTION_COMMAND=control-center
```

Private key paths and key material are never placed in `runtime.env`, the
browser, logs or Git.

The deployment order is:

1. deploy the reviewed adapter to Stage;
2. rerun the stable host installer;
3. generate both Samsung identities;
4. pipe each public key to its matching server installer;
5. verify Stage details through `avalar-status`;
6. verify Stage smoke through `avalar-control`;
7. run `configure-avalar-integration.ps1 -EnableStageMutations`;
8. hardware-test PIN elevation, restart and deploy on Stage;
9. promote the reviewed Stage code to Main;
10. enable Main restart only after production health acceptance;
11. keep Main deploy independently disabled until its explicit acceptance.

Deleting or rotating one identity does not affect the other. Remove the marked
status or action block from REG.RU `authorized_keys`, delete the matching local
key pair and rerun the two installers.
