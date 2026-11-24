"""Provision a Station credential file on Windows using bounded JSON on stdin."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

from panel_agent.station_credentials import MAX_CREDENTIAL_BYTES, StationCredentials, dpapi
from panel_agent.station_reminders import reminder_session

ACL = r"""
$ErrorActionPreference = 'Stop'
$root = $env:PANEL_CREDENTIAL_STAGING_DIR
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$owners = @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
foreach ($owner in $owners) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $root -AclObject $acl
"""


def provision(target: Path, plaintext: bytes) -> None:
    if target.name == "reminders.dpapi":
        reminder_session(plaintext)
    else:
        StationCredentials.parse(plaintext)
    encrypted = dpapi(plaintext, decrypt=False)
    target.parent.mkdir(exist_ok=True, parents=True)
    env = dict(os.environ, PANEL_CREDENTIAL_STAGING_DIR=str(target.parent))
    subprocess.run(["powershell", "-NonInteractive", "-NoProfile", "-Command", ACL], env=env,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
    temporary = None
    try:
        with NamedTemporaryFile(dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(encrypted)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="An absolute dedicated Station vault directory")
    parser.add_argument("--reminders", action="store_true", help="Protect a separately authorized Calendar Notes session")
    args = parser.parse_args()
    root = args.directory
    if not root.is_absolute() or root.name != "station-credentials":
        parser.error("use an absolute dedicated directory named station-credentials")
    try:
        source = sys.stdin.buffer.read(MAX_CREDENTIAL_BYTES + 1)
        if len(source) > MAX_CREDENTIAL_BYTES:
            raise ValueError
        provision(root / ("reminders.dpapi" if args.reminders else "oauth.dpapi"), source)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Station credential provisioning failed", file=sys.stderr)
        return 1
    print("Station credential protected for the current Windows user")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
