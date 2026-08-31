param(
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCurrentHead,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedTargetHead,
    [ValidatePattern('^[0-9a-f]{24}$')][string]$RequestId,
    [switch]$Continuation
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "updater-target-handoff.ps1")

if ([string]::IsNullOrWhiteSpace($env:ARTEM_TARGET_HANDOFF_TEST_ROOT)) { exit 20 }
$runtimeRoot = $env:ARTEM_TARGET_HANDOFF_TEST_ROOT
$paths = [pscustomobject]@{
    RepoRoot = $PSScriptRoot
    RuntimeRoot = $runtimeRoot
    Logs = Join-Path $runtimeRoot "logs"
    UpdateLock = Join-Path $runtimeRoot "update-lock.json"
    UpdateTransactionState = Join-Path $runtimeRoot "update-transaction.json"
}

if (-not $Continuation) { exit 21 }
$claim = Claim-ArtemTargetHandoffLease `
    -Paths $paths `
    -LockRequestId $RequestId `
    -Current $ExpectedCurrentHead `
    -Target $ExpectedTargetHead

[IO.File]::WriteAllText(
    (Join-Path $runtimeRoot "child-receipt.json"),
    (@{
        current = $ExpectedCurrentHead
        target = $ExpectedTargetHead
        requestId = $RequestId
        continuation = [bool]$Continuation
        ownerPid = $PID
        protocol = [string]$claim.Protocol
    } | ConvertTo-Json -Compress),
    [Text.Encoding]::ASCII
)

if ($env:ARTEM_TARGET_HANDOFF_TEST_FAIL -eq "1") {
    if ([string]$claim.Protocol -eq "legacy") {
        Restore-ArtemLegacyTargetHandoffLease `
            -Paths $paths `
            -LockRequestId $RequestId `
            -Current $ExpectedCurrentHead `
            -Target $ExpectedTargetHead `
            -ParentPid ([int]$claim.PreviousOwnerPid)
    }
    exit 22
}
Write-ArtemTargetHandoffEvidence -Paths $paths -LockRequestId $RequestId -Stage "target-bootstrap-accepted" -Result "success"
exit 0
