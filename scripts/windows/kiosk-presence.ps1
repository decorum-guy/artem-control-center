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

# A single failed presence probe must never close a physically valid kiosk:
# heartbeats are 1s against a 5s max age and CIM process snapshots can be
# transient, so sustained absence is judged over this bounded grace window.
$script:ArtemKioskWatcherPresenceLossGraceSeconds = 15

function Invoke-ArtemKioskWatcherLoop {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$StartupTimeoutSeconds = 20,
        [int]$PresenceLossGraceSeconds = $script:ArtemKioskWatcherPresenceLossGraceSeconds,
        [int]$PollIntervalMilliseconds = 250,
        [scriptblock]$Clock = { Get-Date }
    )

    $closeRequestPath = Join-Path $Paths.RuntimeRoot "kiosk-close-request.json"

    # Startup confirmation stays strict: the steady-state loop below only runs
    # after a fresh heartbeat has confirmed the kiosk on the dedicated profile.
    $startupDeadline = (& $Clock).AddSeconds($StartupTimeoutSeconds)
    $seenVisibleKiosk = $false
    while ((& $Clock) -lt $startupDeadline) {
        if (Test-ArtemKioskVisible -Paths $Paths) {
            $seenVisibleKiosk = $true
            break
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }

    if (-not $seenVisibleKiosk) {
        # Do not leave stale background processes from the dedicated profile around;
        # they must never become a future false "already open" signal.
        Stop-ArtemKiosk -Paths $Paths
        return [pscustomobject]@{ Outcome = "startup-not-confirmed" }
    }

    $presenceLostSince = $null
    while ($true) {
        # Explicit stop requests stay prompt and destructive.
        if ((Test-Path -LiteralPath $closeRequestPath) -or (Test-Path -LiteralPath $Paths.ManualStop)) {
            Remove-Item -LiteralPath $closeRequestPath -Force -ErrorAction SilentlyContinue
            Stop-ArtemKiosk -Paths $Paths
            return [pscustomobject]@{ Outcome = "explicit-stop"; PresenceLostSince = $presenceLostSince }
        }

        if (Test-ArtemKioskVisible -Paths $Paths) {
            $presenceLostSince = $null
        }
        else {
            $now = & $Clock
            if ($null -eq $presenceLostSince) {
                $presenceLostSince = $now
            }
            elseif (($now - $presenceLostSince).TotalSeconds -ge $PresenceLossGraceSeconds) {
                # Sustained absence still does not prove the kiosk closed; a stale
                # heartbeat next to live panel Edge is exactly what fresh Open owns
                # recovering via stale-heartbeat removal and dedicated-profile cleanup.
                # Exit non-destructively so valid Edge windows can never be killed here.
                return [pscustomobject]@{
                    Outcome = "presence-lost"
                    PresenceLostSince = $presenceLostSince
                    ExitedAt = $now
                }
            }
        }

        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
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
