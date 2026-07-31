param(
    [switch]$ForUpdate
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$paths = Get-ArtemConnectivityPaths
Stop-ArtemConnectivityProcesses -Paths $paths -Manual (-not $ForUpdate)

if ($ForUpdate) {
    Remove-Item -LiteralPath $paths.StopMarker -Force -ErrorAction SilentlyContinue
    Write-Host "Control Center connectivity tunnel stopped for update."
}
else {
    Write-Host "Control Center connectivity tunnel stopped. Autostart is paused until manual start."
}
