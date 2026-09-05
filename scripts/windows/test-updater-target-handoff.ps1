$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "updater-target-handoff.ps1")
. (Join-Path $PSScriptRoot "test-updater-target-handoff-legacy-parent.ps1")

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
        UpdateTransactionState = Join-Path $RuntimeRoot "update-transaction.json"
    }
}

function Set-TestHandoffTransaction {
    param([Parameter(Mandatory)]$Paths, [string]$Phase = "handoff", [string]$Status = "incomplete", [string]$TransactionRequest = $request, [string]$UpdatedAt = [DateTime]::UtcNow.ToString("o"))
    Write-ArtemTargetHandoffJson -Path $Paths.UpdateTransactionState -Payload @{
        schemaVersion = 1; status = $Status; phase = $Phase; requestId = $TransactionRequest
        previousHead = $current; targetHead = $target; updatedAt = $UpdatedAt
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

function Set-TestNullHeadLegacyParentLease {
    param([Parameter(Mandatory)]$Paths, [object]$OwnerPid = $PID, [string]$UpdatedAt = [DateTime]::UtcNow.ToString("o"))
    Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
        schemaVersion = 1
        status = "updating"
        requestId = $request
        ownerPid = $OwnerPid
        updatedAt = $UpdatedAt
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
    Set-TestHandoffTransaction -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    $handoff = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ($null -ne $handoff.ownerPid -or [string]$handoff.handoff -ne "target-continuation") {
        throw "Parent did not publish a bounded ownerless target handoff lease"
    }
    $process = Start-ArtemTargetContinuation -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Target continuation child failed" }
    $receipt = Get-ArtemJsonPayload -Path (Join-Path $root "child-receipt.json")
    if ($null -eq $receipt -or [string]$receipt.current -ne $current -or [string]$receipt.target -ne $target -or [string]$receipt.requestId -ne $request -or -not [bool]$receipt.continuation) {
        throw "Target continuation child did not receive the exact handoff arguments"
    }
    $claimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ([int]$claimed.ownerPid -ne [int]$receipt.ownerPid -or $null -ne $claimed.handoff -or [string]$receipt.protocol -ne "explicit") {
        throw "Target continuation child did not atomically claim the handoff lease"
    }
    $evidence = Get-ArtemJsonPayload -Path (Join-Path $paths.Logs ("update-handoff-{0}.json" -f $request))
    if ([string]$evidence.stage -ne "target-bootstrap-accepted" -or [string]$evidence.result -ne "success") {
        throw "Target continuation did not record bounded bootstrap evidence"
    }

    # A fresh ownerless lease rejects every mismatched identity before a child
    # can claim it, including a stale competing parent owner.
    Set-TestParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    Assert-RejectedClaim -Paths $paths -ClaimRequest ("2" * 24) -ClaimCurrent $current -ClaimTarget $target -Label "request id"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent ("c" * 40) -ClaimTarget $target -Label "current revision"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget ("d" * 40) -Label "target revision"
    Set-TestHandoffTransaction -Paths $paths -Phase "checkout"
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{
        schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = $target; ownerPid = 999999; updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "competing owner"

    # If the child claims then exits non-zero, the waiting parent can reclaim
    # the exact transaction lease and therefore still execute rollback.
    Set-TestParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    Publish-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = "1"
    $failed = Start-ArtemTargetContinuation -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    $failed.WaitForExit()
    if ($failed.ExitCode -eq 0) { throw "Target handoff failure fixture unexpectedly succeeded" }
    Reclaim-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target -ExitedChildPid $failed.Id
    $reclaimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ([int]$reclaimed.ownerPid -ne $PID -or [string]$reclaimed.requestId -ne $request) {
        throw "Parent could not reclaim rollback authority after child failure"
    }

    # This is the deployed a2b0 parent shape: its manual parent acquired an
    # owned lease before preflight, so both expected revisions are absent even
    # though the fresh exact handoff transaction contains them.
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = ""
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    $legacy = Start-ArtemLegacyTargetContinuationFixture -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    if ($legacy.ExitCode -ne 0) { throw "Legacy parent continuation child failed" }
    $legacyReceipt = Get-ArtemJsonPayload -Path (Join-Path $root "child-receipt.json")
    $legacyClaimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if (
        [string]$legacyReceipt.protocol -ne "legacy" -or
        [int]$legacyClaimed.ownerPid -ne [int]$legacyReceipt.ownerPid -or
        [int]$legacyClaimed.ownerPid -eq $PID -or
        [string]$legacyClaimed.expectedCurrentHead -ne $current -or
        [string]$legacyClaimed.expectedTargetHead -ne $target -or
        $null -ne $legacyClaimed.handoff
    ) { throw "Legacy parent lease was not atomically claimed by the target child" }

    # Keep supporting the already-tested populated legacy parent while the
    # deployed null-head parent is handled by the narrower predicate above.
    Set-TestParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    $populatedLegacy = Start-ArtemLegacyTargetContinuationFixture -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    if ($populatedLegacy.ExitCode -ne 0) { throw "Populated legacy parent continuation child failed" }
    $populatedReceipt = Get-ArtemJsonPayload -Path (Join-Path $root "child-receipt.json")
    $populatedClaimed = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if (
        [string]$populatedReceipt.protocol -ne "legacy" -or
        [int]$populatedClaimed.ownerPid -ne [int]$populatedReceipt.ownerPid -or
        [string]$populatedClaimed.expectedCurrentHead -ne $current -or
        [string]$populatedClaimed.expectedTargetHead -ne $target
    ) { throw "Populated legacy parent lease was not atomically claimed by the target child" }

    # Every legacy field is independently bounded; a failed real child claim
    # must retain the old parent's lease for its deterministic rollback.
    foreach ($case in @(
        @{ Label = "wrong request"; Request = "2" * 24; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "wrong current"; Request = $request; Current = "c" * 40; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "wrong target"; Request = $request; Current = $current; Target = "d" * 40; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "wrong phase"; Request = $request; Current = $current; Target = $target; Phase = "checkout"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "transaction request"; Request = $request; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = "2" * 24; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "stale transaction"; Request = $request; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.AddMinutes(-3).ToString("o") },
        @{ Label = "future transaction"; Request = $request; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.AddMinutes(1).ToString("o") },
        @{ Label = "stale lock"; Request = $request; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.AddMinutes(-3).ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") },
        @{ Label = "future lock"; Request = $request; Current = $current; Target = $target; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.AddMinutes(1).ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o") }
    )) {
        Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{ schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = $target; ownerPid = $PID; updatedAt = $case.LockAt }
        Set-TestHandoffTransaction -Paths $paths -Phase $case.Phase -TransactionRequest $case.TransactionRequest -UpdatedAt $case.TransactionAt
        Assert-RejectedClaim -Paths $paths -ClaimRequest $case.Request -ClaimCurrent $case.Current -ClaimTarget $case.Target -Label $case.Label
    }
    Set-TestParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    Remove-Item -LiteralPath $paths.UpdateTransactionState -Force
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "missing transaction"
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{ schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = $target; updatedAt = [DateTime]::UtcNow.ToString("o") }
    Set-TestHandoffTransaction -Paths $paths
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "ownerless no-marker"

    # Null-head compatibility is all-or-nothing and still needs every exact
    # transaction and owner proof; no generic loose lease can cross this boundary.
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Remove-Item -LiteralPath $paths.UpdateTransactionState -Force
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "null-head missing transaction"
    foreach ($case in @(
        @{ Label = "null-head stale transaction"; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.AddMinutes(-3).ToString("o"); Owner = $PID; Current = $null; Target = $null },
        @{ Label = "null-head wrong phase"; Phase = "checkout"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = $PID; Current = $null; Target = $null },
        @{ Label = "null-head wrong request"; Phase = "handoff"; TransactionRequest = ("2" * 24); LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = $PID; Current = $null; Target = $null },
        @{ Label = "only current missing"; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = $PID; Current = $null; Target = $target },
        @{ Label = "only target missing"; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = $PID; Current = $current; Target = $null },
        @{ Label = "null-head stale lock"; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.AddMinutes(-3).ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = $PID; Current = $null; Target = $null },
        @{ Label = "invalid owner"; Phase = "handoff"; TransactionRequest = $request; LockAt = [DateTime]::UtcNow.ToString("o"); TransactionAt = [DateTime]::UtcNow.ToString("o"); Owner = "not-a-pid"; Current = $null; Target = $null }
    )) {
        $lease = @{ schemaVersion = 1; status = "updating"; requestId = $request; ownerPid = $case.Owner; updatedAt = $case.LockAt }
        if ($null -ne $case.Current) { $lease.expectedCurrentHead = $case.Current }
        if ($null -ne $case.Target) { $lease.expectedTargetHead = $case.Target }
        Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload $lease
        Set-TestHandoffTransaction -Paths $paths -Phase $case.Phase -TransactionRequest $case.TransactionRequest -UpdatedAt $case.TransactionAt
        Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label $case.Label
    }

    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent ("c" * 40) -ClaimTarget $target -Label "null-head wrong current"
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget ("d" * 40) -Label "null-head wrong target"
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths -Status "completed"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "completed transaction"
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths -Status "failed"
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "failed transaction"
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{ schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = ("c" * 40); expectedTargetHead = $target; ownerPid = $PID; updatedAt = [DateTime]::UtcNow.ToString("o") }
    Set-TestHandoffTransaction -Paths $paths
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "populated mismatched current lock SHA"
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{ schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = ("d" * 40); ownerPid = $PID; updatedAt = [DateTime]::UtcNow.ToString("o") }
    Set-TestHandoffTransaction -Paths $paths
    Assert-RejectedClaim -Paths $paths -ClaimRequest $request -ClaimCurrent $current -ClaimTarget $target -Label "populated mismatched target lock SHA"

    # A real child rejection cannot remove a parent-owned legacy lease.
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = ""
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths -Phase "checkout"
    $rejectedChild = Start-ArtemLegacyTargetContinuationFixture -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    $preserved = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ($rejectedChild.ExitCode -eq 0 -or [int]$preserved.ownerPid -ne $PID) { throw "Rejected legacy child claim removed the parent lease" }

    # A claimed legacy child that exits before target work restores the old
    # parent lease, so the deployed parent can still enter its rollback path.
    Set-TestNullHeadLegacyParentLease -Paths $paths
    Set-TestHandoffTransaction -Paths $paths
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = "1"
    $legacyFailed = Start-ArtemLegacyTargetContinuationFixture -Paths $paths -Current $current -Target $target -LockRequestId $request -TargetScript $childScript
    $legacyRecovered = Get-ArtemJsonPayload -Path $paths.UpdateLock
    if ($legacyFailed.ExitCode -eq 0 -or [int]$legacyRecovered.ownerPid -ne $PID) { throw "Failed legacy child did not restore parent rollback authority" }

    # Matching identity alone never authorizes a parent to overwrite a live
    # unrelated owner after the waited child has exited.
    Write-ArtemTargetHandoffJson -Path $paths.UpdateLock -Payload @{ schemaVersion = 1; status = "updating"; requestId = $request; expectedCurrentHead = $current; expectedTargetHead = $target; ownerPid = 999999; updatedAt = [DateTime]::UtcNow.ToString("o") }
    $reclaimRejected = $false
    try { Reclaim-ArtemTargetHandoffLease -Paths $paths -LockRequestId $request -Current $current -Target $target -ExitedChildPid 999998 }
    catch { $reclaimRejected = $true }
    if (-not $reclaimRejected) { throw "Reclaim overwrote a competing owner" }
}
finally {
    $env:ARTEM_TARGET_HANDOFF_TEST_ROOT = $previousRoot
    $env:ARTEM_TARGET_HANDOFF_TEST_FAIL = $previousFail
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated Windows parent-to-child target handoff, exact arguments, lease claim/rejection, and parent recovery authority."
