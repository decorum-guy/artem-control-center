[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ControlHost,
  [Parameter(Mandatory = $true)][string]$ControlUser,
  [Parameter(Mandatory = $true)][string]$AdminHost,
  [Parameter(Mandatory = $true)][string]$AdminUser,
  [Parameter(Mandatory = $true)][string]$KnownHostsPath,
  [string]$KeyRoot = "$env:LOCALAPPDATA\ArtemControlCenter\ssh"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $KeyRoot | Out-Null
foreach ($name in @('artem-home-control', 'artem-home-admin')) {
  $key = Join-Path $KeyRoot $name
  if (-not (Test-Path -LiteralPath $key)) {
    & ssh-keygen.exe -t ed25519 -f $key -N '' -C "Artem Control Center $name" | Out-Null
  }
  & icacls.exe $key /inheritance:r /grant:r "$env:USERNAME:(R,W)" 'SYSTEM:(F)' | Out-Null
}
if (-not (Test-Path -LiteralPath $KnownHostsPath)) {
  throw 'Create a pinned known_hosts file from an owner-verified server fingerprint before using these aliases.'
}
$config = @"
Host artem-home-control
  HostName $ControlHost
  User $ControlUser
  IdentityFile $KeyRoot\artem-home-control
  UserKnownHostsFile $KnownHostsPath
  GlobalKnownHostsFile NUL
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no

Host artem-home-admin
  HostName $AdminHost
  User $AdminUser
  IdentityFile $KeyRoot\artem-home-admin
  UserKnownHostsFile $KnownHostsPath
  GlobalKnownHostsFile NUL
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
"@
$configPath = Join-Path $KeyRoot 'config'
Set-Content -LiteralPath $configPath -Value $config -NoNewline
& icacls.exe $configPath /inheritance:r /grant:r "$env:USERNAME:(R,W)" 'SYSTEM:(F)' | Out-Null
Write-Output "Created separate product-control and operator keys under $KeyRoot. Install only artem-home-control.pub for the restricted forced command (restrict,command=\"/usr/local/lib/artem-control-center/home-maintenance\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding); artem-home-admin.pub is owner/operator-only. Never put the admin key in Panel Agent runtime.env."
