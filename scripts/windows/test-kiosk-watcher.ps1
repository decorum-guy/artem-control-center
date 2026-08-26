# Deterministic kiosk watcher regression. The watcher loop's lifecycle policy is
# exercised through injected probes and a stepped fake clock, so no real Edge
# processes, wall-clock sleeps or flaky timing are involved.
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
$script:kioskProbeWriteCloseAt = $null

function Set-KioskProbes {
    param(
        [object[]]$Results,
        [int]$WriteCloseRequestAtProbe = -1
    )
    $script:kioskProbeQueue = @($Results)
    $script:kioskProbeIndex = 0
    $script:kioskProbeWriteCloseAt = $WriteCloseRequestAtProbe
}

# Visibility probes are scripted: each call consumes the next queued result, then
# repeats the last one, and can emit an explicit close request mid-loop so a full
# watch session always reaches a deterministic terminal outcome.
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
    if ($index -eq $script:kioskProbeWriteCloseAt) {
        New-Item -ItemType Directory -Force -Path $paths.RuntimeRoot | Out-Null
        Set-Content -LiteralPath $closeRequestPath -Value "{}" -Encoding ASCII
    }
    return [bool]$result
}

$script:kioskStops = New-Object System.Collections.Generic.List[int]
function Stop-ArtemKiosk {
    param($Paths, [object[]]$Processes, [scriptblock]$ProcessStopper)
    $script:kioskStops.Add([int]$script:kioskProbeIndex) | Out-Null
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

    # A. One transient failed visibility probe during a previously confirmed
    #    session must not destroy the dedicated kiosk.
    $script:kioskStops.Clear()
    Set-KioskProbes -Results @($true, $false, $true) -WriteCloseRequestAtProbe 2
    $outcome = Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PresenceLossGraceSeconds 15 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "A single false presence probe must not end a confirmed kiosk session"
    if ($script:kioskStops.Count -ne 1) {
        throw "Transient presence probe must produce no destructive cleanup before explicit close. Stops=[$($script:kioskStops -join ',')]"
    }
    if ($script:kioskStops[0] -lt 3) {
        throw "Destructive cleanup must happen only for the explicit close request, not the transient loss"
    }

    # B. Temporary presence absence followed by recovery keeps watching safely:
    #    several consecutive failed probes inside the grace window change nothing.
    $script:kioskStops.Clear()
    Set-KioskProbes -Results @($true, $false, $false, $false, $true) -WriteCloseRequestAtProbe 5
    $outcome = Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PresenceLossGraceSeconds 15 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "Recovered presence absence must keep the watcher non-destructive and alive"
    if ($script:kioskStops.Count -ne 1 -or $script:kioskStops[0] -ne 6) {
        throw "Presence-loss grace recovery must clean up only at the later explicit stop. Stops=[$($script:kioskStops -join ',')]"
    }

    # C. Sustained heartbeat/presence absence must exit NON-destructively within
    #    the bounded grace window: panel-owned Edge stays untouched and fresh Open
    #    owns stale-heartbeat removal plus relaunch cleanup.
    $script:kioskStops.Clear()
    Set-KioskProbes -Results @($true, $false)
    $outcome = Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PresenceLossGraceSeconds 15 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
    Assert-WatcherOutcome -Result $outcome -Expected "presence-lost" `
        -Message "Sustained presence absence must exit through the bounded non-destructive path"
    if ($script:kioskStops.Count -ne 0) {
        throw "Sustained presence loss must never trigger destructive Edge termination"
    }
    $absenceSeconds = ($outcome.ExitedAt - $outcome.PresenceLostSince).TotalSeconds
    if ($absenceSeconds -lt 15 -or $absenceSeconds -ge 20) {
        throw "Non-destructive exit must wait the bounded grace window. AbsentSeconds=$absenceSeconds"
    }

    # D. Explicit kiosk-close-request remains prompt and destructive.
    $script:kioskStops.Clear()
    Set-KioskProbes -Results @($true)
    Set-Content -LiteralPath $closeRequestPath -Value "{}" -Encoding ASCII
    $outcome = Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "kiosk-close-request must promptly stop the dedicated kiosk"
    if ($script:kioskStops.Count -ne 1) {
        throw "Explicit close request must perform exactly one destructive cleanup"
    }
    if (Test-Path -LiteralPath $closeRequestPath) {
        throw "Handled kiosk-close-request must be consumed"
    }

    # E. manual-stop marker remains prompt and destructive and is left in place.
    $script:kioskStops.Clear()
    Set-KioskProbes -Results @($true)
    Set-Content -LiteralPath $paths.ManualStop -Value "{}" -Encoding ASCII
    $outcome = Invoke-ArtemKioskWatcherLoop `
        -Paths $paths `
        -StartupTimeoutSeconds 20 `
        -PollIntervalMilliseconds 0 `
        -Clock (New-FakeClock)
    Assert-WatcherOutcome -Result $outcome -Expected "explicit-stop" `
        -Message "manual-stop must promptly stop the dedicated kiosk"
    if ($script:kioskStops.Count -ne 1) {
        throw "manual-stop must perform exactly one destructive cleanup"
    }
    if (-not (Test-Path -LiteralPath $paths.ManualStop)) {
        throw "manual-stop marker must remain owned by its writer"
    }

    # F. Watcher cleanup never touches personal Edge because Stop-ArtemKiosk is
    #    strictly bounded to the exact profile root and its descendants; that
    #    bounding is proven process-by-process in test-kiosk-process-tree.ps1,
    #    and scenarios A-C above prove the watcher now calls it less often.
    # Strict Open (#133), fresh/stale/future/malformed heartbeat rejection and
    # soft updater acceptance are proven in test-kiosk-presence.ps1.

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

Write-Host "Validated kiosk watcher: transient and recovered presence losses are non-destructive, sustained absence exits non-destructively within the bounded grace window, explicit close/manual stop remain prompt and destructive, and the deployed entrypoint exits cleanly."
