$ErrorActionPreference = "Stop"

function Read-CompanionFile {
    param([Parameter(Mandatory)][string]$Name)
    return Get-Content -LiteralPath (Join-Path $PSScriptRoot $Name) -Raw
}

$installer = Read-CompanionFile "install-rog-g703-companion.ps1"
$configWriter = Read-CompanionFile "rog-g703-companion-config.ps1"
$companion = Read-CompanionFile "rog_g703_companion.py"

foreach ($required in @(
    'Write-CompanionConfig',
    '[System.IO.File]::WriteAllText',
    '[System.Text.UTF8Encoding]::new($false)',
    'Protect-Path',
    '"/inheritance:r"',
    '"*S-1-5-18:(F)"'
)) {
    if (-not $configWriter.Contains($required)) {
        throw "ROG G703 config writer contract is missing: $required"
    }
}

foreach ($required in @(
    'rog-g703-companion-config.ps1',
    'Write-CompanionConfig',
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

function Assert-ProtectedCompanionPath {
    param([Parameter(Mandatory)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "Companion path ACL inheritance was not disabled: $Path"
    }
    $rules = $acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    )
    $allowedFullControlSids = @(
        $rules |
            Where-Object {
                $_.AccessControlType -eq "Allow" -and
                ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)
            } |
            ForEach-Object { $_.IdentityReference.Value }
    )
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($requiredSid in @($currentUserSid, "S-1-5-18")) {
        if ($requiredSid -notin $allowedFullControlSids) {
            throw "Required SID is missing FullControl on companion path $Path`: $requiredSid"
        }
    }
}

$testRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem-rog-g703-companion-{0}" -f [guid]::NewGuid())
$testConfigPath = Join-Path $testRoot "companion.json"
$testSecretPath = Join-Path $testRoot "companion.secret"
$testCompanionPath = Join-Path $testRoot "rog_g703_companion.py"
$testSourcePath = Join-Path $PSScriptRoot "rog_g703_companion.py"
$testSecret = "test-secret-" + ("x" * 37)
$pythonCommand = Get-Command "python.exe" -ErrorAction Stop
$pythonValidationPath = [IO.Path]::GetTempFileName()
$testPython = [pscustomobject]@{
    Path = $pythonCommand.Source
    PrefixArguments = @()
}

try {
    . (Join-Path $PSScriptRoot "rog-g703-companion-config.ps1")
    Write-CompanionConfig `
        -InstallRoot $testRoot `
        -ConfigPath $testConfigPath `
        -SecretPath $testSecretPath `
        -CompanionPath $testCompanionPath `
        -SourcePath $testSourcePath `
        -ListenAddress "0.0.0.0" `
        -Port 8769 `
        -Python $testPython `
        -Secret $testSecret

    $configBytes = [IO.File]::ReadAllBytes($testConfigPath)
    if ($configBytes.Length -ge 3 -and
        $configBytes[0] -eq 0xEF -and
        $configBytes[1] -eq 0xBB -and
        $configBytes[2] -eq 0xBF) {
        throw "Generated companion.json contains a UTF-8 BOM."
    }
    if ([IO.File]::ReadAllText($testSecretPath, [Text.Encoding]::ASCII) -ne $testSecret) {
        throw "Generated companion secret was not preserved as expected."
    }

    $configuration = [IO.File]::ReadAllText($testConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $expectedConfiguration = [ordered]@{
        schemaVersion = 1
        listenAddress = "0.0.0.0"
        port = 8769
        secretFile = $testSecretPath
        python = $testPython.Path
    }
    foreach ($expected in $expectedConfiguration.GetEnumerator()) {
        if ($configuration.($expected.Key) -ne $expected.Value) {
            throw "Generated companion.json field is incorrect: $($expected.Key)"
        }
    }

    $pythonValidation = @'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
raw = config_path.read_bytes()
bom = bytes((0xEF, 0xBB, 0xBF))
if raw.startswith(bom):
    raise SystemExit("Generated companion.json contains a UTF-8 BOM")
with config_path.open("r", encoding="utf-8") as handle:
    config = json.load(handle)
expected = {
    "schemaVersion": 1,
    "listenAddress": "0.0.0.0",
    "port": 8769,
    "secretFile": sys.argv[2],
    "python": sys.argv[3],
}
if config != expected:
    raise SystemExit(f"Unexpected companion.json fields: {config!r}")
'@
    [IO.File]::WriteAllText($pythonValidationPath, $pythonValidation, [Text.Encoding]::ASCII)
    & $pythonCommand.Source $pythonValidationPath $testConfigPath $testSecretPath $testPython.Path
    if ($LASTEXITCODE -ne 0) {
        throw "Python utf-8 companion.json validation failed."
    }

    foreach ($protectedPath in @(
        $testRoot,
        $testConfigPath,
        $testSecretPath,
        $testCompanionPath
    )) {
        Assert-ProtectedCompanionPath -Path $protectedPath
    }
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pythonValidationPath -Force -ErrorAction SilentlyContinue
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
    '"/health"',
    '"/hibernate"',
    '"/sleep"',
    "Authorization",
    "compare_digest",
    "shutdown.exe",
    '"/h"',
    "SetSuspendState",
    "MAX_REQUEST_BODY_BYTES",
    "schedule_hibernate",
    "schedule_sleep",
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

Write-Host "Validated fixed ROG G703 companion routes, protected bootstrap, LAN firewall scope and distinct Sleep/S4 executor contracts."
