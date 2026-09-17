$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
$runtimeCommonText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "runtime-common.ps1") -Raw

function Assert-EqualSet {
    param(
        [Parameter(Mandatory)][int[]]$Actual,
        [Parameter(Mandatory)][int[]]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    $actualSorted = @($Actual | Sort-Object)
    $expectedSorted = @($Expected | Sort-Object)
    if (($actualSorted -join ',') -ne ($expectedSorted -join ',')) {
        throw "$Message. Actual=[$($actualSorted -join ',')] Expected=[$($expectedSorted -join ',')]"
    }
}

$profile = "C:\Users\Test User\AppData\Local\ArtemControlCenter\edge-profile"
$paths = [pscustomobject]@{ EdgeProfile = $profile }
$started = [DateTimeOffset]::Parse("2026-08-26T17:00:00Z")

$processes = @(
    [pscustomobject]@{
        ProcessId = 100
        ParentProcessId = 50
        CommandLine = "msedge.exe --kiosk http://127.0.0.1:8787/overview --user-data-dir=`"$profile`""
        CreationDate = $started
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 101
        ParentProcessId = 100
        CommandLine = "msedge.exe --type=renderer --renderer-client-id=1"
        CreationDate = $started.AddSeconds(1)
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 102
        ParentProcessId = 101
        CommandLine = "msedge.exe --type=gpu-process"
        CreationDate = $started.AddSeconds(2)
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 103
        ParentProcessId = 100
        CommandLine = "msedge.exe --type=utility"
        CreationDate = $started.AddMinutes(-2)
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 200
        ParentProcessId = 20
        CommandLine = "msedge.exe --user-data-dir=C:\Users\Test User\PersonalEdge"
        CreationDate = $started
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 201
        ParentProcessId = 200
        CommandLine = "msedge.exe --type=renderer"
        CreationDate = $started.AddSeconds(1)
        SessionId = 2
    },
    [pscustomobject]@{
        ProcessId = 300
        ParentProcessId = 30
        CommandLine = "msedge.exe --user-data-dir=`"$profile-other`""
        CreationDate = $started
        SessionId = 2
    }
)

$owned = @(Get-ArtemKioskProcesses -Paths $paths -Processes $processes)
Assert-EqualSet `
    -Actual @($owned | ForEach-Object { [int]$_.ProcessId }) `
    -Expected @(100, 101, 102) `
    -Message "Owned Edge tree must contain only the exact profile root and its current descendants"

$root = $owned | Where-Object ProcessId -eq 100
$child = $owned | Where-Object ProcessId -eq 101
$grandchild = $owned | Where-Object ProcessId -eq 102
if ($root.OwnershipDepth -ne 0 -or $child.OwnershipDepth -ne 1 -or $grandchild.OwnershipDepth -ne 2) {
    throw "Owned Edge descendants must preserve bounded tree depth"
}
if ($root.SessionId -ne 2 -or $child.SessionId -ne 2 -or $grandchild.SessionId -ne 2) {
    throw "Owned Edge process snapshots must preserve their Windows SessionId"
}

$aligned = Get-ArtemKioskSessionAlignment -Paths $paths -OwnedProcesses $owned -ConsoleSessionId 2
if (-not $aligned.SessionAligned -or ($aligned.ProcessSessionIds -join ',') -ne '2') {
    throw "A dedicated Edge tree entirely in the active console session must be aligned"
}
$wrongSession = Get-ArtemKioskSessionAlignment `
    -Paths $paths `
    -OwnedProcesses @([pscustomobject]@{ SessionId = 0 }) `
    -ConsoleSessionId 2
if ($wrongSession.SessionAligned -or -not $wrongSession.HasWrongSessionProcess) {
    throw "A dedicated Edge tree only in Session 0 must not be accepted for console Session 2"
}
$mixedSession = Get-ArtemKioskSessionAlignment `
    -Paths $paths `
    -OwnedProcesses @([pscustomobject]@{ SessionId = 2 }, [pscustomobject]@{ SessionId = 0 }) `
    -ConsoleSessionId 2
if ($mixedSession.SessionAligned -or -not $mixedSession.HasWrongSessionProcess -or ($mixedSession.ProcessSessionIds -join ',') -ne '0,2') {
    throw "A mixed console and hidden dedicated Edge tree must remain degraded, not fully healthy"
}

# Kiosk visibility is proven by the application presence contract in
# kiosk-presence.ps1. This process-tree fixture covers only ownership and the
# bounded cleanup input; it must not reintroduce window-handle probing.
if ($runtimeCommonText -match 'Get-ArtemVisibleKioskProcesses') {
    throw "Kiosk process ownership must not use deprecated desktop-window probing"
}

$stopped = New-Object System.Collections.Generic.List[int]
Stop-ArtemKiosk `
    -Paths $paths `
    -Processes $processes `
    -ProcessStopper {
        param($ProcessId)
        $stopped.Add([int]$ProcessId) | Out-Null
    }
if (($stopped -join ',') -ne '102,101,100') {
    throw "Cleanup must remain bounded to the owned tree and stop descendants before the profile root. Actual=[$($stopped -join ',')]"
}

$rootGone = @(
    [pscustomobject]@{
        ProcessId = 101
        ParentProcessId = 100
        CommandLine = "msedge.exe --type=renderer"
        CreationDate = $started.AddSeconds(1)
    },
    [pscustomobject]@{
        ProcessId = 100
        ParentProcessId = 77
        CommandLine = "msedge.exe --profile-directory=Default"
        CreationDate = $started.AddMinutes(5)
    }
)
$reusedOwned = @(Get-ArtemKioskProcesses -Paths $paths -Processes $rootGone)
if ($reusedOwned.Count -ne 0) {
    throw "A dead profile root or reused PID without the exact profile seed must not claim an unrelated tree"
}

Write-Host "Validated panel-owned Edge process tree: exact profile ownership, SessionId alignment, unrelated rejection, bounded cleanup and PID-reuse safety."
