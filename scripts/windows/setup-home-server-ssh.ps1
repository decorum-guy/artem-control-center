[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ControlHost,
  [Parameter(Mandatory = $true)][string]$AdminHost,
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
  IdentityFile $KeyRoot\artem-home-control
  UserKnownHostsFile $KnownHostsPath
  GlobalKnownHostsFile NUL
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes

Host artem-home-admin
  HostName $AdminHost
  IdentityFile $KeyRoot\artem-home-admin
  UserKnownHostsFile $KnownHostsPath
  GlobalKnownHostsFile NUL
  IdentitiesOnly yes
  StrictHostKeyChecking yes
"@
$configPath = Join-Path $KeyRoot 'config'
Set-Content -LiteralPath $configPath -Value $config -NoNewline
& icacls.exe $configPath /inheritance:r /grant:r "$env:USERNAME:(R,W)" 'SYSTEM:(F)' | Out-Null
Write-Output "Created aliases and public keys under $KeyRoot. Install only the .pub control key with the server forced command; keep the admin key separate."
