# Application-level kiosk presence for Samsung/Edge kiosk mode.
# Process ownership and the dashboard heartbeat are intentionally separate signals.

$script:ArtemKioskPresenceMaxAgeSeconds = 5
$script:ArtemKioskWatcherMaxAgeMinutes = 15

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

function Test-ArtemKioskWatcherOwned {
    param([Parameter(Mandatory)]$Paths)
    $payload = Get-ArtemJsonPayload -Path (Get-ArtemKioskWatcherOwnerPath -Paths $Paths)
    if (
        $null -eq $payload -or
        $payload.schemaVersion -ne 1 -or
        [string]$payload.watcherId -notmatch '^[0-9a-f]{32}$'
    ) {
        return $false
    }
    try {
        $claimed = [DateTimeOffset]::Parse([string]$payload.claimedAt).ToUniversalTime()
        $age = [DateTimeOffset]::UtcNow - $claimed
        return $age.TotalSeconds -ge 0 -and $age.TotalMinutes -le $script:ArtemKioskWatcherMaxAgeMinutes
    }
    catch {
        return $false
    }
}

# Status is deliberately a small state contract rather than a single narrow
# boolean. A transient process/heartbeat observation gap is reported as degraded
# or unconfirmed while the owned runtime evidence remains visible to the owner.
function Get-ArtemKioskStatus {
    param(
        [Parameter(Mandatory)]$Paths,
        [bool]$RuntimeReady = $false
    )
    $processOwned = Test-ArtemKioskRunning -Paths $Paths
    $presenceRecent = Test-ArtemKioskPresenceRecent -Paths $Paths
    $watcherOwned = Test-ArtemKioskWatcherOwned -Paths $Paths
    $presenceFile = Test-Path -LiteralPath (Get-ArtemKioskPresencePath -Paths $Paths)

    $status = if ($processOwned -and $presenceRecent) {
        "running"
    }
    elseif ($processOwned -or $watcherOwned) {
        "degraded"
    }
    elseif ($presenceRecent -or ($presenceFile -and $RuntimeReady)) {
        "unconfirmed"
    }
    else {
        "stopped"
    }

    return [pscustomobject]@{
        Status = $status
        # An unconfirmed state is deliberately null rather than a misleading
        # boolean. Running/degraded retain positive owned evidence; stopped is
        # reserved for the absence of every kiosk signal.
        Open = if ($status -eq "running" -or $status -eq "degraded") { $true } elseif ($status -eq "stopped") { $false } else { $null }
        ProcessOwned = $processOwned
        PresenceRecent = $presenceRecent
        WatcherOwned = $watcherOwned
    }
}

# Visibility is a conjunction: the rendered page is actively reporting that the
# document is visible, and the dedicated Control Center Edge profile exists. This
# prevents an ordinary browser tab from impersonating the kiosk without using
# deprecated desktop-window probing.
function Test-ArtemKioskVisible {
    param([Parameter(Mandatory)]$Paths)
    return (
        (Test-ArtemKioskRunning -Paths $Paths) -and
        (Test-ArtemKioskPresenceRecent -Paths $Paths)
    )
}

# Kiosk watcher lifecycle. A single failed presence probe must never close a
# physically valid kiosk, and neither may sustained absence: heartbeats are 1s
# against a 5s max age and CIM process snapshots can be transient. After presence
# loss the watcher stays alive non-destructively so it keeps honoring explicit
# stop requests and can resume normal monitoring if presence recovers.
#
# Single-owner/supersession: every confirmed watcher claims kiosk-watcher-owner.json
# atomically (last writer wins). When a later Open relaunches the kiosk, its new
# watcher claim makes every previous watcher exit non-destructively on its next
# poll, so degraded/healthy watchers can never accumulate. An abnormally dead
# watcher never blocks the next one because claiming is an unconditional overwrite.
function Get-ArtemKioskWatcherOwnerPath {
    param([Parameter(Mandatory)]$Paths)
    return Join-Path $Paths.RuntimeRoot "kiosk-watcher-owner.json"
}

function Set-ArtemKioskWatcherOwner {
    param([Parameter(Mandatory)]$Paths)
    $watcherId = [guid]::NewGuid().ToString("N")
    # A claim only ever happens after a confirmed kiosk wrote heartbeats into
    # RuntimeRoot, so the directory already exists here.
    $ownerPath = Get-ArtemKioskWatcherOwnerPath -Paths $Paths
    $temporary = "$ownerPath.tmp"
    [ordered]@{
        schemaVersion = 1
        watcherId = $watcherId
        claimedAt = [DateTimeOffset]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding ASCII
    Move-Item -LiteralPath $temporary -Destination $ownerPath -Force
    return $watcherId
}

# Only a well-formed foreign claim supersedes us. Missing/garbage payloads fail
# open toward staying alive rather than self-superseding on transient reads.
function Test-ArtemKioskWatcherSuperseded {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$WatcherId
    )
    try {
        $payload = Get-ArtemJsonPayload -Path (Get-ArtemKioskWatcherOwnerPath -Paths $Paths)
    }
    catch {
        return $false
    }
    if ($null -eq $payload -or $payload.schemaVersion -ne 1) { return $false }
    $currentOwner = [string]$payload.watcherId
    return ($currentOwner -match '^[0-9a-f]{32}$' -and $currentOwner -ne $WatcherId)
}

function Invoke-ArtemKioskWatcherLoop {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$StartupTimeoutSeconds = 20,
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

    # Claiming happens only after startup is confirmed, so the previous owner
    # keeps handling explicit stops until this watcher can actually serve them.
    $watcherId = Set-ArtemKioskWatcherOwner -Paths $Paths

    while ($true) {
        if (Test-ArtemKioskWatcherSuperseded -Paths $Paths -WatcherId $watcherId) {
            # A newer confirmed watcher owns the lifecycle now (fresh Open relaunch).
            # Exit without touching Edge; never destroy what we no longer own.
            return [pscustomobject]@{ Outcome = "superseded" }
        }

        # Explicit stop requests stay prompt and destructive no matter how long
        # advisory presence has been missing; panel-agent relies on this for
        # robust dedicated-profile/tree cleanup around hide and shutdown.
        if (Test-Path -LiteralPath $closeRequestPath) {
            Remove-Item -LiteralPath $closeRequestPath -Force -ErrorAction SilentlyContinue
            Stop-ArtemKiosk -Paths $Paths
            return [pscustomobject]@{ Outcome = "explicit-stop"; Source = "close-request" }
        }
        if (Test-Path -LiteralPath $Paths.ManualStop) {
            Stop-ArtemKiosk -Paths $Paths
            return [pscustomobject]@{ Outcome = "explicit-stop"; Source = "manual-stop" }
        }

        # Advisory visibility is observed but never acted on destructively, so a
        # stalled or recovered heartbeat cannot itself terminate the watcher.
        Test-ArtemKioskVisible -Paths $Paths | Out-Null

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
