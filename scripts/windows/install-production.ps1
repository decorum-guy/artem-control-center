param(
    [ValidateSet("fixtures", "read_only", "integration_test", "production")]
    [string]$PanelMode = "fixtures",
    [switch]$SkipStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath

$legacyStop = Join-Path $paths.RuntimeRoot "Stop-Fixture-Kiosk.ps1"
if (Test-Path -LiteralPath $legacyStop) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $legacyStop
    Start-Sleep -Seconds 1
}

Stop-ArtemRuntime -Paths $paths -Manual $false
Set-Location -LiteralPath $paths.RepoRoot
 $revision = Get-ArtemCheckoutRevision -Paths $paths
 $previousRuntimeVenv = $env:PANEL_RUNTIME_VENV
 try {
    $env:PANEL_RUNTIME_VENV = Get-ArtemRuntimeVenvPath -Paths $paths -Revision $revision
    Invoke-CheckedCommand `
        -FilePath "npm.cmd" `
        -Arguments @("run", "setup") `
        -Description "project setup"
 }
 finally {
    if ($null -eq $previousRuntimeVenv) { Remove-Item Env:PANEL_RUNTIME_VENV -ErrorAction SilentlyContinue }
    else { $env:PANEL_RUNTIME_VENV = $previousRuntimeVenv }
 }
Invoke-CheckedCommand `
    -FilePath "npm.cmd" `
    -Arguments @("run", "build:production") `
    -Description "accepted V2 production dashboard build"

if (-not (Test-Path -LiteralPath $paths.RuntimeEnv)) {
    $configuration = @"
# Artem Control Center runtime configuration.
# This file is local to the Samsung and is never committed to Git.
PANEL_AGENT_MODE=$PanelMode
PANEL_WRITES_ENABLED=false
PANEL_COFFEE_TIMING_WRITES_ENABLED=false
PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=false
PANEL_COFFEE_ACTIONS_ENABLED=false

# AVALAR public monitoring can be enabled without credentials.
PANEL_AVALAR_MAIN_URL=https://avalar.pro
PANEL_AVALAR_STAGE_URL=https://stage.avalar.pro
PANEL_AVALAR_SSH_ENABLED=false
PANEL_AVALAR_SSH_HOST=avalar-status
PANEL_AVALAR_SSH_STATUS_COMMAND=control-center

# Every mutation remains disabled until the restricted host executor is installed.
PANEL_AVALAR_ACTIONS_ENABLED=false
PANEL_AVALAR_ACTION_SSH_HOST=avalar-control
PANEL_AVALAR_ACTION_COMMAND=control-center
PANEL_AVALAR_SMOKE_ENABLED=false
PANEL_AVALAR_STAGE_RESTART_ENABLED=false
PANEL_AVALAR_MAIN_RESTART_ENABLED=false
PANEL_AVALAR_STAGE_DEPLOY_ENABLED=false
PANEL_AVALAR_MAIN_DEPLOY_ENABLED=false
"@
    Set-Content -LiteralPath $paths.RuntimeEnv -Value $configuration -Encoding UTF8
    Write-Host "Created safe runtime configuration: $($paths.RuntimeEnv)"
}
else {
    Write-Host "Existing runtime configuration preserved: $($paths.RuntimeEnv)"
}

$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$aclArguments = @(
    $paths.RuntimeEnv,
    "/inheritance:r",
    "/grant:r",
    "*${currentUserSid}:(F)",
    "*S-1-5-18:(F)"
)
& icacls.exe @aclArguments | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict runtime.env ACL"
}
Write-Host "Protected runtime configuration for the panel account and SYSTEM."

& (Join-Path $PSScriptRoot "configure-edge-kiosk.ps1")

$taskName = "Artem Control Center Runtime"
$userId = $currentUserSid
$taskArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($paths.StartScript)`" -AutoStart"
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $taskArguments `
    -WorkingDirectory $paths.RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) {
    throw "Unable to resolve the current user's Documents folder"
}
New-Item -ItemType Directory -Force -Path $documents | Out-Null

# Installation owns the helper .cmd files, but not any owner-created .lnk shortcuts.
# Remove legacy/generated desktop CMD files so future installs keep the desktop clean.
$desktopGenerated = @(
    "Start Control Center.cmd",
    "Open Control Center.cmd",
    "Update Control Center.cmd",
    "Stop Control Center.cmd",
    "Control Center Status.cmd",
    "Set Control Center PIN.cmd",
    "Repair Home Connection.cmd",
    "Start Control Center Test.cmd",
    "Stop Control Center Test.cmd"
)
foreach ($name in $desktopGenerated) {
    Remove-Item -LiteralPath (Join-Path $desktop $name) -Force -ErrorAction SilentlyContinue
}

$startShortcut = Join-Path $documents "Start Control Center.cmd"
$openShortcut = Join-Path $documents "Open Control Center.cmd"
$stopShortcut = Join-Path $documents "Stop Control Center.cmd"
$updateShortcut = Join-Path $documents "Update Control Center.cmd"
$statusShortcut = Join-Path $documents "Control Center Status.cmd"
$pinShortcut = Join-Path $documents "Set Control Center PIN.cmd"
$statusScript = Join-Path $PSScriptRoot "status-production.ps1"
$pinScript = Join-Path $PSScriptRoot "set-access-pin.ps1"

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StartScript)"
"@ | Set-Content -LiteralPath $startShortcut -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.OpenKioskScript)"
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo.
  echo Open Control Center failed with exit code %exitCode%.
  pause
)
exit /b %exitCode%
"@ | Set-Content -LiteralPath $openShortcut -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StopScript)"
"@ | Set-Content -LiteralPath $stopShortcut -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.UpdateScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath $updateShortcut -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$statusScript"
pause
"@ | Set-Content -LiteralPath $statusShortcut -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pinScript" -Profile standard
pause
"@ | Set-Content -LiteralPath $pinShortcut -Encoding ASCII

Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue

$currentHead = (& git.exe rev-parse HEAD).Trim()
if ($currentHead) {
    Set-Content -LiteralPath $paths.LastKnownGood -Value $currentHead -Encoding ASCII
}

if (-not $SkipStart) {
    & $paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
        throw "Installed production runtime did not become ready"
    }
}

Write-Host ""
Write-Host "Artem Control Center production runtime installed."
Write-Host "Scheduled task: $taskName"
Write-Host "Runtime config: $($paths.RuntimeEnv)"
Write-Host "Logs: $($paths.Logs)"
Write-Host "Documents helpers: $documents"
Write-Host "  Start Control Center.cmd"
Write-Host "  Open Control Center.cmd"
Write-Host "  Stop Control Center.cmd"
Write-Host "  Update Control Center.cmd"
Write-Host "  Control Center Status.cmd"
Write-Host "  Set Control Center PIN.cmd"
