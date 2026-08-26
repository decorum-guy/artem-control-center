param(
    [switch]$AssumeRuntimeReady
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "kiosk-presence.ps1")

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths

if (Test-ArtemSoftwareUpdateActive -Paths $paths) {
    throw "Control Center software update is in progress"
}

if (-not $AssumeRuntimeReady -and -not (Test-ArtemPanelReady -Paths $paths)) {
    & $paths.StartScript -NoKiosk
}

if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 30)) {
    throw "Artem Control Center is not ready"
}

Ensure-ArtemKioskVisible -Paths $paths -TimeoutSeconds 20 | Out-Null
Write-Host "Control Center kiosk presence confirmed."
