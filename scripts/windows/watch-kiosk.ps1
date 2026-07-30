$ErrorActionPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$startupDeadline = (Get-Date).AddSeconds(20)
$seenKiosk = $false

while ((Get-Date) -lt $startupDeadline) {
    if (Test-ArtemKioskRunning -Paths $paths) {
        $seenKiosk = $true
        break
    }
    Start-Sleep -Milliseconds 250
}

if (-not $seenKiosk) {
    exit 0
}

while ($true) {
    if (Test-Path -LiteralPath $paths.ManualStop) {
        Stop-ArtemKiosk -Paths $paths
        exit 0
    }

    if (-not (Test-ArtemKioskRunning -Paths $paths)) {
        exit 0
    }

    Start-Sleep -Milliseconds 250
}
