$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$desktop = [Environment]::GetFolderPath("Desktop")
$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) {
    throw "Unable to resolve the current user's Documents folder"
}
New-Item -ItemType Directory -Force -Path $documents | Out-Null

# Keep the desktop clean. Only remove legacy/generated .cmd helpers; owner-created
# .lnk shortcuts are deliberately left untouched.
$desktopGenerated = @(
    "Start Control Center.cmd",
    "Open Control Center.cmd",
    "Update Control Center.cmd",
    "Stop Control Center.cmd",
    "Control Center Status.cmd",
    "Set Control Center PIN.cmd",
    "Repair Home Connection.cmd",
    "Start Control Center Connectivity.cmd",
    "Stop Control Center Connectivity.cmd",
    "Control Center Connectivity Status.cmd",
    "Configure Home Production.cmd",
    "Start Control Center Test.cmd",
    "Stop Control Center Test.cmd"
)
foreach ($name in $desktopGenerated) {
    Remove-Item -LiteralPath (Join-Path $desktop $name) -Force -ErrorAction SilentlyContinue
}

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
"@ | Set-Content -LiteralPath (Join-Path $documents "Open Control Center.cmd") -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.UpdateScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $documents "Update Control Center.cmd") -Encoding ASCII

@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StopScript)"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $documents "Stop Control Center.cmd") -Encoding ASCII

$connectivityConfig = Join-Path $paths.RuntimeRoot "connectivity.json"
$connectivityTask = Get-ScheduledTask -TaskName "Artem Control Center Connectivity" -ErrorAction SilentlyContinue
$repairHelper = Join-Path $documents "Repair Home Connection.cmd"
if ((Test-Path -LiteralPath $connectivityConfig) -and $null -ne $connectivityTask) {
    $restartConnectivity = Join-Path $PSScriptRoot "restart-connectivity-tunnel.ps1"
    @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$restartConnectivity"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath $repairHelper -Encoding ASCII
}
else {
    Remove-Item -LiteralPath $repairHelper -Force -ErrorAction SilentlyContinue
}

Write-Host "Documents helpers synchronized: $documents"
Write-Host "  Open Control Center.cmd"
Write-Host "  Update Control Center.cmd"
Write-Host "  Stop Control Center.cmd"
if (Test-Path -LiteralPath $repairHelper) {
    Write-Host "  Repair Home Connection.cmd"
}
