$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$desktop = [Environment]::GetFolderPath("Desktop")

$obsolete = @(
    "Start Control Center.cmd",
    "Control Center Status.cmd",
    "Set Control Center PIN.cmd",
    "Start Control Center Connectivity.cmd",
    "Stop Control Center Connectivity.cmd",
    "Control Center Connectivity Status.cmd",
    "Configure Home Production.cmd",
    "Start Control Center Test.cmd",
    "Stop Control Center Test.cmd"
)
foreach ($name in $obsolete) {
    Remove-Item -LiteralPath (Join-Path $desktop $name) -Force -ErrorAction SilentlyContinue
}

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.OpenKioskScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $desktop "Open Control Center.cmd") -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.UpdateScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $desktop "Update Control Center.cmd") -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StopScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $desktop "Stop Control Center.cmd") -Encoding ASCII

$connectivityConfig = Join-Path $paths.RuntimeRoot "connectivity.json"
$connectivityTask = Get-ScheduledTask -TaskName "Artem Control Center Connectivity" -ErrorAction SilentlyContinue
$repairShortcut = Join-Path $desktop "Repair Home Connection.cmd"
if ((Test-Path -LiteralPath $connectivityConfig) -and $null -ne $connectivityTask) {
    $restartConnectivity = Join-Path $PSScriptRoot "restart-connectivity-tunnel.ps1"
    @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$restartConnectivity"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath $repairShortcut -Encoding ASCII
}
else {
    Remove-Item -LiteralPath $repairShortcut -Force -ErrorAction SilentlyContinue
}

Write-Host "Desktop helpers synchronized."
Write-Host "  Open Control Center.cmd"
Write-Host "  Update Control Center.cmd"
Write-Host "  Stop Control Center.cmd"
if (Test-Path -LiteralPath $repairShortcut) {
    Write-Host "  Repair Home Connection.cmd"
}
