$ErrorActionPreference = "Stop"

function Read-CompanionFile {
    param([Parameter(Mandatory)][string]$Name)
    return Get-Content -LiteralPath (Join-Path $PSScriptRoot $Name) -Raw
}

$installer = Read-CompanionFile "install-rog-g703-companion.ps1"
$companion = Read-CompanionFile "rog_g703_companion.py"

foreach ($required in @(
    'ValidateSet("install", "status", "restart", "uninstall")',
    "New-ScheduledTaskTrigger -AtStartup",
    "New-ScheduledTaskPrincipal",
    '-UserId "SYSTEM"',
    "New-NetFirewallRule",
    "-RemoteAddress `$FirewallRemoteAddress",
    "Remove-NetFirewallRule",
    "Stop-ScheduledTask",
    "Start-ScheduledTask",
    "companion.secret",
    "RandomNumberGenerator",
    "Python 3.10 or newer",
    '"status" { Invoke-Status }',
    '"restart" { Invoke-Restart }',
    '"uninstall" { Invoke-Uninstall }'
)) {
    if ($installer -notlike "*$required*") {
        throw "ROG G703 bootstrap contract is missing: $required"
    }
}

if ($installer -like "*Restart-ScheduledTask*") {
    throw "ROG G703 bootstrap uses unsupported Restart-ScheduledTask."
}

$restartStart = $installer.IndexOf("function Invoke-Restart")
$restartEnd = $installer.IndexOf("function Invoke-Uninstall", $restartStart)
if ($restartStart -lt 0 -or $restartEnd -le $restartStart) {
    throw "ROG G703 bootstrap restart function is missing or malformed."
}
$restartBlock = $installer.Substring($restartStart, $restartEnd - $restartStart)
$stopIndex = $restartBlock.IndexOf("Stop-ScheduledTask")
$startIndex = $restartBlock.IndexOf("Start-ScheduledTask")
if ($stopIndex -lt 0 -or $startIndex -lt 0 -or $stopIndex -ge $startIndex) {
    throw "ROG G703 bootstrap restart must stop before starting the scheduled task."
}
if ($restartBlock -notlike "*Get-ScheduledTask*") {
    throw "ROG G703 bootstrap restart must inspect the scheduled task state."
}
if ($restartBlock -notlike "*Start-Sleep -Milliseconds 250*") {
    throw "ROG G703 bootstrap restart must use a bounded stopped-state wait."
}

foreach ($required in @(
    'parsed.path != "/health"',
    'parsed.path != "/hibernate"',
    "Authorization",
    "compare_digest",
    "shutdown.exe",
    '"/h"',
    "MAX_REQUEST_BODY_BYTES",
    "schedule_hibernate",
    "serve_forever"
)) {
    if ($companion -notlike "*$required*") {
        throw "ROG G703 companion contract is missing: $required"
    }
}

foreach ($forbidden in @(
    "/exec",
    "/command",
    "/powershell",
    "/shell",
    "/run",
    "/process",
    "/url",
    "/proxy",
    "shutdown.exe /s",
    "shutdown.exe /r",
    "shutdown.exe /l"
)) {
    if ($companion -like "*$forbidden*") {
        throw "ROG G703 companion contains a forbidden surface or operation: $forbidden"
    }
}

Write-Host "Validated fixed ROG G703 companion routes, protected bootstrap, LAN firewall scope and S4-only executor contract."
