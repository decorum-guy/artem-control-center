$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "updater-target-handoff.ps1")

$current = "a" * 40
$target = "b" * 40
$request = "1" * 24
$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-target-handoff {0}" -f [guid]::NewGuid())
$previousRoot = $env:ARTEM_TARGET_HANDOFF_TEST_ROOT
$previousFail = $env:ARTEM_TARGET_HANDOFF_TEST_FAIL

function New-TestPaths {
    param([Parameter(Mandatory)][string]$RuntimeRoot)
    $logs = Join-Path $RuntimeRoot "logs"
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    return [pscustomobject]@{
        RepoRoot = $PSScriptRoot
        RuntimeRoot = $RuntimeRoot
        Logs = $logs
        UpdateLock = Join-Path $RuntimeRoot "update-lock.json"
    }
}

function Set-TestParentLease {
    param([Parameter(Mandatory)]$Paths)
    Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
        schemaVersion = 1
        status = "updating"
        requestId = $request
        expectedCurrentHead = $current
        expectedTargetHead = $target
        ownerPid = $PID
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
}

function Assert-RejectedClaim {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$ClaimRequest,
        [Parameter(Mandatory)][string]$ClaimCurrent,
        [Parameter(Mandatory)][string]$ClaimTarget,
        [Parameter(Mandatory)][string]$Label
    )
    $rejected = $false
    try {
        Claim-ArtemTargetHandoffLease -Paths $Paths -LockRequestId $ClaimRequest -Current $ClaimCurrent -Target $ClaimTarget
    }
    catch { $rejected = $true }
    if (-not $rejected) { throw "Target handoff accepted a mismatched $Label" }
}

try {
    $paths = New-TestPaths -RuntimeRoot $root
    $env:ARTEM_TARGET_HANDOFF_TEST_ROOT = $root
    $childDirectory = Join-Path $root "target updater fixture\scripts\windows"
    New-Item -ItemType Directory -Force -Path $childDirectory | Out-Null
    foreach ($name in @("runtime-common.ps1", "updater-target-handoff.ps1", "test-updater-target-handoff-child.ps1")) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $childDirectory $name)
    }
    $childScript = Join-Path $childDirectory "test-updater-target-handoff-child.ps1"

    # The real Start-Process path is deliberate. The fixed child script lives
    # beneath a path with spaces, proving the production launcher's -File form.
    Set-TestParentLease -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    $handoff = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ($null -ne $handoff.ownerPid -or [string]$handoff.handoff -ne "target-continuation") {
        throw "Parent did not publish a bounded ownerless target handoff lease"
    }
    $process = Start-ArtemTargetContinuation -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    if ($process.ExitCode -ne 0) { throw "Target continuation child failed" }
    $receipt = Get-ArtemJsonPayload -Path (Join-Path $root "child-receipt.json")
    if ($null -eq $receipt -or [string]$receipt.current -ne $current -or [string]$receipt.target -ne $target -or [string]$receipt.requestId -ne $request -or -not [bool]$receipt.continuation) {
        throw "Target continuation child did not receive the exact handoff arguments"
    }
    $claimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ([int]$claimed.ownerPid -ne [int]$receipt.ownerPid -or $null -ne $claimed.handoff) {
        throw "Target continuation child did not atomically claim the handoff lease"
    }
    $evidence = Get-ArtemJsonPayload -Path (Join-Path $paths.Logs ("update-handoff-{0}.json" -f $request))
    if ([string]$evidence.stage -ne "target-bootstrap-accepted" -or [string]$evidence.result -ne "success") {
        throw "Target continuation did not record bounded bootstrap evidence"
    }

    # A fresh ownerless lease rejects every mismatched identity before a child
    # can claim it, including a stale competing parent owner.
    Set-TestParentLease -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    Assert-RejectedClaim -Paths $paths -ClaimRequest ("2" * 24) -ClaimCurrent $current -ClaimTarget $target -Label "request id"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent ("c" * 40) -ClaimTarget $target -Label "current revision"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget ("d" * 40) -Label "target revision"
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{
        schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = $target; ownerPid = 999999; updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "competing owner"

    # If the child claims then exits non-zero, the waiting parent can reclaim
    # the exact transaction lease and therefore still execute rollback.
    Set-TestParentLease -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = "1"
    $failed = Start-ArtemTargetContinuation -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    if ($failed.ExitCode -eq 0) { throw "Target handoff failure fixture unexpectedly succeeded" }
    Reclaim-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    $reclaimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ([int]$reclaimed.ownerPid -ne $PID -or [string]$reclaimed.requestId -ne $request) {
        throw "Parent could not reclaim rollback authority after child failure"
    }
}
finally {
    $env:ARTEM_TARGET_HANDOFF_TEST_ROOT = $previousRoot
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = $previousFail
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated Windows parent-to-child target handoff, exact arguments, lease claim/rejection, and parent recovery authority."
