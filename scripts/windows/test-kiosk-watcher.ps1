# Deterministic kiosk watcher regression. The watcher loop's lifecycle policy is
# exercised through injected probes, a stepped fake clock and scripted ownership
# claims, so no real Edge processes, wall-clock sleeps or flaky timing are involved.
#
# Covered contract:
# - transient OR sustained advisory presence loss never calls Stop-ArtemKiosk;
#   the watcher stays alive to honor later explicit stops and natural recovery;
# - explicit close-request / manual-stop remain prompt and destructive;
# - a newer confirmed watcher supersedes the previous one non-destructively
#   through kiosk-watcher-owner.json, so logical owners never accumulate and an
#   abnormally dead watcher never blocks the next one;
# - strict Open, heartbeat authority, personal-Edge bounding and updater soft
#   acceptance are proven by the sibling kiosk-presence / process-tree suites.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-kiosk-watcher-{0}" -f [guid]::NewGuid())
$paths = [pscustomobject]@{
    RuntimeRoot = $root
    EdgeProfile = Join-Path $root "edge-profile"
    PanelUrl = "http://127.0.0.1:8787/overview"
    ManualStop = Join-Path $root "manual-stop.json"
    KioskWatchScript = Join-Path $PSScriptRoot "watch-kiosk.ps1"
}
$closeRequestPath = Join-Path $paths.RuntimeRoot "kiosk-close-request.json"

function New-FakeClock {
    param([int]$StepMilliseconds = 1000)
    $state = @{ value = [DateTimeOffset]::UtcNow }
    return {
        $current = $state.value.DateTime
        $state.value = $state.value.AddMilliseconds($StepMilliseconds)
        return $current
    }.GetNewClosure()
}

$script:kioskProbeQueue = @()
$script:kioskProbeIndex = 0
$script:kioskProbeWriteCloseAt = -1
$script:kioskProbeWriteManualStopAt = -1
$script:kioskProbeSupersedeAt = -1
$script:kioskForeignOwnerId = ("b" * 32)

function Reset-KioskProbes {
    param(
        [object[]]$Results,
        [int]$WriteCloseRequestAtProbe = -1,
        [int]$WriteManualStopAtProbe = -1,
        [int]$SupersedeAtProbe = -1,
        [string]$ForeignOwnerId = ("b" * 32)
    )
    $script:kioskProbeQueue = @($Results)
    $script:kioskProbeIndex = 0
    $script:kioskProbeWriteCloseAt = $WriteCloseRequestAtProbe
    $script:kioskProbeWriteManualStopAt = $WriteManualStopAtProbe
    $script:kioskProbeSupersedeAt = $SupersedeAtProbe
    $script:kioskForeignOwnerId = $ForeignOwnerId
}

# Visibility probes are scripted: each call consumes the next queued result, then
# repeats the last one, and can emit mid-loop lifecycle events (a close request,
# a manual-stop marker, or another watcher's ownership claim) so every session
# reaches a deterministic terminal outcome.
function Test-ArtemKioskVisible {
    param($Paths)
    $index = $script:kioskProbeIndex
    $result = if ($script:kioskProbeQueue.Count -eq 0) {
        $true
    }
    elseif ($index -lt $script:kioskProbeQueue.Count) {
        $script:kioskProbeQueue[$index]
    }
    else {
        $script:kioskProbeQueue[-1]
    }
    $script:kioskProbeIndex++
    New-Item -ItemType Directory -Force -Path $paths.RuntimeRoot | Out-Null
    if ($index -eq $script:kioskProbeWriteCloseAt) {
        Set-Content -LiteralPath $closeRequestPath -Value "{}" -Encoding ASCII
    }
    if ($index -eq $script:kioskProbeWriteManualStopAt) {
        Set-Content -LiteralPath $paths.ManualStop -Value "{}" -Encoding ASCII
    }
    if ($index -eq $script:kioskProbeSupersedeAt) {
        [ordered]@{
            schemaVersion = 1
            watcherId = $script:kioskForeignOwnerId
            claimedAt = ([DateTimeOffset]::UtcNow.ToString("o"))
        } | ConvertTo-Json | Set-Content `
            -LiteralPath (Get-ArtemKioskWatcherOwnerPath -Paths $paths) `
            -Encoding ASCII
    }
    return [bool]$result
}

$script:kioskStops = New-Object System.Collections.Generic.List[int]
function Stop-ArtemKiosk {
    param($Paths, [object[]]$Processes, [scriptblock]$ProcessStopper)
    $script:kioskStops.Add([int]$script:kioskProbeIndex) | Out-Null
}

function Invoke-WatcherSession {
    Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
}

function Assert-WatcherOutcome {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    if ($null -eq $Result -or $Result.Outcome -ne $Expected) {
        $actual = if ($null -ne $Result) { $Result.Outcome } else { "<none>" }
        throw "$Message. Expected outcome '$Expected' but got '$actual'"
    }
}

try {
    New-Item -ItemType Directory -Force -Path $paths.RuntimeRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $paths.EdgeProfile | Out-Null

    # A. One transient failed visibility probe during a confirmed session must not
    #    destroy the dedicated kiosk; the later explicit stop does the one cleanup.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true, $false, $true) -WriteCloseRequestAtProbe 2
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "A single false presence probe must not end a confirmed kiosk session"
    if ($outcome.Source -ne "close-request") {
        throw "Explicit close request must be reported as the cleanup source"
    }
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -lt 3) {
        throw "Destructive cleanup must happen only for the explicit close, never the transient loss. Stops=[$($script:kioskStops -join ',')]"
    }

    # B. Multiple consecutive false probes inside the presence-loss tolerance
    #    window followed by recovery change nothing destructively.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true, $false, $false, $false, $true) -WriteCloseRequestAtProbe 5
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "Recovered presence absence must keep the watcher non-destructive and alive"
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -ne 6) {
        throw "Presence-loss recovery must clean up only at the later explicit stop. Stops=[$($script:kioskStops -join ',')]"
    }

    # C. Sustained absence far beyond any bounded grace must leave the watcher
    #    alive and non-destructive, ready for a much later close request: exactly
    #    one bounded Stop-ArtemKiosk, strictly after the request appears.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true, $false) -WriteCloseRequestAtProbe 40
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "The watcher must survive sustained heartbeat stall instead of abandoning explicit closes"
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -ne 41) {
        throw "Sustained loss followed by close-request must produce exactly one late destructive cleanup. Stops=[$($script:kioskStops -join ',')]"
    }

    # D. Same as C for the panel-driven hide/shutdown path: manual-stop arriving
    #    after a long stall still performs robust prompt cleanup.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true, $false) -WriteManualStopAtProbe 20
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "manual-stop after sustained loss must remain prompt and destructive"
    if ($outcome.Source -ne "manual-stop") {
        throw "manual-stop must be reported as the cleanup source"
    }
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -ne 21) {
        throw "manual-stop after sustained loss must produce exactly one late destructive cleanup. Stops=[$($script:kioskStops -join ',')]"
    }
    if (-not (Test-Path -LiteralPath $paths.ManualStop)) {
        throw "manual-stop marker must remain owned by its writer"
    }
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue

    # E. Sustained absence beyond the tolerance window that then recovers must
    #    bring the watcher back to normal monitoring rather than ending it.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @(
        $true,
        $false, $false, $false, $false, $false,
        $false, $false, $false, $false, $false,
        $true, $true, $true, $true
    ) -WriteCloseRequestAtProbe 15
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "Natural recovery after sustained loss must resume normal watching"
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -ne 16) {
        throw "Recovered watcher must clean up only when the later explicit stop arrives. Stops=[$($script:kioskStops -join ',')]"
    }
    Remove-Item -LiteralPath $closeRequestPath -Force -ErrorAction SilentlyContinue

    # F./G. A degraded-but-alive watcher exits non-destructively once a newer
    #    confirmed watcher claims ownership, leaving that owner in sole control;
    #    supersession itself must never call Stop-ArtemKiosk.
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true) -SupersedeAtProbe 4 -ForeignOwnerId (("b" * 32))
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "superseded" `
        -Message "A previous watcher must exit once a newer watcher claims ownership"
    if ($script:kioskStops.Count -ne 0) {
        throw "Supersession must never trigger destructive cleanup. Stops=[$($script:kioskStops -join ',')]"
    }
    $ownerPayload = Get-ArtemJsonPayload -Path (Get-ArtemKioskWatcherOwnerPath -Paths $paths)
    if ($ownerPayload.schemaVersion -ne 1 -or [string]$ownerPayload.watcherId -ne ("b" * 32)) {
        throw "Ownership transfer must leave the newest watcher as sole logical owner"
    }

    # H. Ordinary repeated healthy Open cycles must not accumulate logical owners,
    #    and an abnormally dead watcher's stale marker must not block the next one.
    Set-Content -LiteralPath (Get-ArtemKioskWatcherOwnerPath -Paths $paths) `
        -Value "{ ""schemaVersion"": 1, ""watcherId"": ""$(("e" * 32))"" }" -Encoding ASCII
    foreach ($round in 1..2) {
        $sentinelId = if ($round -eq 1) { "c" * 32 } else { "d" * 32 }
        $script:kioskStops.Clear()
        Reset-KioskProbes -Results @($true) -SupersedeAtProbe 6 -ForeignOwnerId $sentinelId
        $outcome = Invoke-WatcherSession
        Assert-WatcherOutcome -Result $outcome -Expected "superseded" `
            -Message "Healthy Open round $round must hand ownership to the newer watcher cleanly"
        if ($script:kioskStops.Count -ne 0) {
            throw "Healthy ownership handover must be fully non-destructive. Round=$round"
        }
    }
    $script:kioskStops.Clear()
    Reset-KioskProbes -Results @($true) -WriteCloseRequestAtProbe 8
    $outcome = Invoke-WatcherSession
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "Final healthy Open session must watch normally despite repeated prior relaunches"
    $finalOwner = Get-ArtemJsonPayload -Path (Get-ArtemKioskWatcherOwnerPath -Paths $paths)
    if ($null -eq $finalOwner -or $finalOwner.schemaVersion -ne 1 -or
        [string]$finalOwner.watcherId -notmatch '^[0-9a-f]{32}$') {
        throw "Repeated relaunches must converge on a single well-formed logical owner"
    }

    # I./J./K. Personal/unrelated Edge bounding, strict Open + fresh/stale/future/
    # malformed heartbeat authority and the #133 soft updater acceptance remain
    # covered green by test-kiosk-process-tree.ps1 and test-kiosk-presence.ps1.

    # Prove the deployed entrypoint wiring: with zero startup timeout the watcher
    # must confirm nothing, exit cleanly and leave no failure behind.
    if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
        & powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $paths.KioskWatchScript `
            -StartupTimeoutSeconds 0
        if ($LASTEXITCODE -ne 0) {
            throw "watch-kiosk.ps1 must exit cleanly when startup is not confirmed"
        }
    }
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated kiosk watcher: transient and sustained presence losses stay alive and non-destructive, explicit close/manual-stop remain prompt and destructive even after long stalls, ownership supersession is non-destructive and single-owner, repeated relaunches do not accumulate owners, and the deployed entrypoint exits cleanly."
