# Application-level kiosk presence for Samsung/Edge kiosk mode.
# MainWindowHandle is not a reliable signal on the production machine: a physically
# visible fullscreen Edge kiosk reports HWND 0 for every msedge.exe process.

$script:ArtemKioskPresenceMaxAgeSeconds = 5

function Get-ArtemKioskPresencePath {
    param([Parameter(Mandatory)]$Paths)
    return Join-Path $Paths.RuntimeRoot "kiosk-presence.json"
}

function Test-ArtemKioskPresenceRecent {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$MaxAgeSeconds = $script:ArtemKioskPresenceMaxAgeSeconds
    )

    $presencePath = Get-ArtemKioskPresencePath -Paths $Paths
    $payload = Get-ArtemJsonPayload -Path $presencePath
    if ($null -eq $payload -or $payload.schemaVersion -ne 1) { return $false }
    if ([string]$payload.pageId -notmatch '^[0-9a-f]{24}$') { return $false }
    try {
        $observed = [DateTimeOffset]::Parse([string]$payload.observedAt).ToUniversalTime()
        $age = [DateTimeOffset]::UtcNow - $observed
        return $age.TotalSeconds -ge 0 -and $age.TotalSeconds -le $MaxAgeSeconds
    }
    catch {
        return $false
    }
}

# Visibility is a conjunction: the rendered page is actively reporting that the
# document is visible, and the dedicated Control Center Edge profile exists. This
# prevents an ordinary browser tab from impersonating the kiosk while avoiding HWND.
function Test-ArtemKioskVisible {
    param([Parameter(Mandatory)]$Paths)
    return (
        (Test-ArtemKioskRunning -Paths $Paths) -and
        (Test-ArtemKioskPresenceRecent -Paths $Paths)
    )
}

function Ensure-ArtemKioskVisible {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 20
    )

    if (Test-ArtemKioskVisible -Paths $Paths) {
        Start-ArtemKioskWatcher -Paths $Paths
        return $true
    }

    # A stale heartbeat must never let an old page satisfy a fresh launch.
    Remove-Item -LiteralPath (Get-ArtemKioskPresencePath -Paths $Paths) -Force -ErrorAction SilentlyContinue

    # Edge may keep the dedicated profile alive after the kiosk page disappears.
    # Cleanup remains process/profile based because that is exactly what it is good at.
    if (Test-ArtemKioskRunning -Paths $Paths) {
        $cleanupDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $cleanupDeadline -and (Test-ArtemKioskRunning -Paths $Paths)) {
            Stop-ArtemKiosk -Paths $Paths
            Start-Sleep -Milliseconds 200
        }
        if (Test-ArtemKioskRunning -Paths $Paths) {
            throw "Panel Edge background processes did not close"
        }
    }

    Remove-Item `
        -LiteralPath (Join-Path $Paths.RuntimeRoot "kiosk-close-request.json") `
        -Force `
        -ErrorAction SilentlyContinue

    $edge = Get-ArtemEdgeExecutable
    $edgeArguments = @(
        "--kiosk",
        $Paths.PanelUrl,
        "--edge-kiosk-type=fullscreen",
        "--user-data-dir=$($Paths.EdgeProfile)",
        "--no-first-run",
        "--disable-session-crashed-bubble",
        "--disable-features=msEdgeSidebarV2"
    )
    Start-Process `
        -FilePath $edge `
        -ArgumentList $edgeArguments `
        -WindowStyle Maximized | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ArtemKioskVisible -Paths $Paths) {
            Start-ArtemKioskWatcher -Paths $Paths
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    # During the new updater transaction kiosk restoration is post-update recovery,
    # not software acceptance. Do not roll back a validated healthy runtime because
    # the UI heartbeat did not arrive; leave the profile for subsequent Open recovery.
    if (Test-ArtemSoftwareUpdateActive -Paths $Paths) {
        Write-Warning "Control Center runtime is healthy, but kiosk presence was not confirmed after update"
        return $false
    }

    Stop-ArtemKiosk -Paths $Paths
    throw "Control Center kiosk presence was not confirmed"
}
