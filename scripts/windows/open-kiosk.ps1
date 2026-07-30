param(
    [switch]$AssumeRuntimeReady
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
$closeRequest = Join-Path $paths.RuntimeRoot "kiosk-close-request.json"
Remove-Item -LiteralPath $closeRequest -Force -ErrorAction SilentlyContinue

function Start-ArtemKioskWatcher {
    $watchArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($paths.KioskWatchScript)`""
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList $watchArguments `
        -WindowStyle Hidden | Out-Null
}

if (-not $AssumeRuntimeReady -and -not (Test-ArtemPanelReady -Paths $paths)) {
    & $paths.StartScript -NoKiosk
}

if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 30)) {
    throw "Artem Control Center is not ready"
}

if (Test-ArtemKioskRunning -Paths $paths) {
    Start-ArtemKioskWatcher
    Write-Host "Control Center kiosk is already open. Watcher attached."
    exit 0
}

$edge = Get-ArtemEdgeExecutable
$arguments = @(
    "--kiosk",
    $paths.PanelUrl,
    "--edge-kiosk-type=fullscreen",
    "--no-first-run",
    "--kiosk-idle-timeout-minutes=0",
    "--user-data-dir=$($paths.EdgeProfile)",
    "--disable-features=msEdgeVisualSearch"
)

Start-Process `
    -FilePath $edge `
    -ArgumentList $arguments `
    -WindowStyle Maximized | Out-Null

Start-ArtemKioskWatcher
Write-Host "Control Center kiosk opened."
