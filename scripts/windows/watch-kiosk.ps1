$ErrorActionPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "kiosk-presence.ps1")

$paths = Get-ArtemRuntimePaths
$closeRequest = Join-Path $paths.RuntimeRoot "kiosk-close-request.json"
$startupDeadline = (Get-Date).AddSeconds(20)
$seenVisibleKiosk = $false

while ((Get-Date) -lt $startupDeadline) {
    if (Test-ArtemKioskVisible -Paths $paths) {
        $seenVisibleKiosk = $true
        break
    }
    Start-Sleep -Milliseconds 250
}

if (-not $seenVisibleKiosk) {
    # Do not leave stale background processes from the dedicated profile around;
    # they must never become a future false "already open" signal.
    Stop-ArtemKiosk -Paths $paths
    exit 0
}

while ($true) {
    if ((Test-Path -LiteralPath $closeRequest) -or (Test-Path -LiteralPath $paths.ManualStop)) {
        Remove-Item -LiteralPath $closeRequest -Force -ErrorAction SilentlyContinue
        Stop-ArtemKiosk -Paths $paths
        exit 0
    }

    if (-not (Test-ArtemKioskVisible -Paths $paths)) {
        Stop-ArtemKiosk -Paths $paths
        exit 0
    }

    Start-Sleep -Milliseconds 250
}
