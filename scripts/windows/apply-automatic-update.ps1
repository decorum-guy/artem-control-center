param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetHead,
    [switch]$ContractTest,
    [switch]$PathsContractTest
)

function Get-ArtemAutomaticUpdateResult {
    param($State, [string]$ExpectedRequest, [string]$ExpectedTarget, [string]$PreviousRevision,
        [bool]$TargetHealthy, [bool]$PreviousHealthy, [bool]$TransactionActive, [bool]$LockActive)
    if ($null -eq $State -or [string]$State.requestId -ne $ExpectedRequest -or [string]$State.targetHead -ne $ExpectedTarget) { return $null }
    # A terminal marker precedes updater cleanup. Do not release host ownership
    # to another target while that child still owns its lease/transaction.
    if ($TransactionActive -or $LockActive) { return $null }
    if ([string]$State.status -eq "success" -and [string]$State.result -in @("updated", "up_to_date") -and
        [string]$State.servedRevision -eq $ExpectedTarget -and $TargetHealthy) {
        return [pscustomobject]@{ status = "deployed"; revision = $ExpectedTarget; code = 0 }
    }
    if ([string]$State.status -eq "failed" -and $PreviousHealthy) {
        # The canonical updater publishes this only before starting its update
        # transaction. Request binding + healthy prior build + no lease/marker
        # prove that retrying a transient fetch/preflight failure is safe.
        if ([string]$State.result -eq "pre_update_failed") {
            return [pscustomobject]@{ status = "deferred"; revision = $PreviousRevision; code = 1 }
        }
        $result = if ([string]$State.result -eq "rollback_restored") { "rolled_back" } else { "failed_healthy" }
        return [pscustomobject]@{ status = $result; revision = $PreviousRevision; code = 1 }
    }
    return $null
}

function Get-ArtemAutomaticFailureResult {
    param([bool]$PossibleDispatch, [bool]$TransactionStateKnownClear)
    if (-not $PossibleDispatch -and $TransactionStateKnownClear) {
        # All preceding work was read-only. A cold runtime, wrong branch/origin
        # or dirty checkout blocks this pass without consuming the candidate.
        return [pscustomobject]@{ status = "deferred"; revision = $null; code = 1 }
    }
    return [pscustomobject]@{ status = "uncertain"; revision = $null; code = 2 }
}

function New-ArtemAutomaticResultPayload {
    param([string]$Status, [AllowNull()][object]$Revision)
    # PowerShell's [string] parameter binding can turn $null into "". The Python
    # coordinator requires JSON null for an unknown revision, never empty text.
    $safeRevision = if ($Revision -is [string] -and $Revision -match '^[0-9a-f]{40}$') { $Revision } else { $null }
    return [ordered]@{ status = $Status; revision = $safeRevision; target = "panel" }
}

function Start-ArtemAutomaticUpdater {
    param($Paths, [string]$CurrentHead, [string]$TargetHead, [string]$UpdateRequestId,
        [Parameter(Mandatory)][ref]$PossibleDispatch)
    $scriptArgument = '"{0}"' -f $Paths.UpdateScript
    # Mark possible dispatch BEFORE touching CreateProcess. An exception or an
    # unconfirmed PID cannot prove that Windows did not create a child.
    $PossibleDispatch.Value = $true
    $updater = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $scriptArgument,
        "-ExpectedCurrentHead", $CurrentHead,
        "-ExpectedTargetHead", $TargetHead,
        "-RequestId", $UpdateRequestId
    ) -WorkingDirectory $Paths.RepoRoot -WindowStyle Hidden -PassThru
    if ($null -eq $updater -or $updater.Id -le 0) { throw "updater_spawn_unconfirmed" }
    return $updater
}

# Test loads the actual decision function only; no runtime, process or device IO.
if ($ContractTest) { return }

# Called only by the installed auto-deploy worker after GitHub exact-SHA CI
# verification. This wrapper never replaces the canonical updater transaction.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path (Join-Path (Join-Path $RepoRoot "scripts") "windows") "runtime-common.ps1")
$paths = Get-ArtemRuntimePaths
# Load the real getter from a relocated adapter without starting any processes.
if ($PathsContractTest) { return $paths }
# Every HTTP probe in this wrapper is fixed loopback; never send it via Happ or a system proxy.
[System.Net.WebRequest]::DefaultWebProxy = $null
$requestId = ([guid]::NewGuid().ToString("N").Substring(0, 24)).ToLowerInvariant()
$current = $null
$possibleDispatch = $false
$transactionStateKnownClear = $false

function Write-Result {
    param([string]$Status, [AllowNull()][object]$Revision, [int]$Code)
    New-ArtemAutomaticResultPayload -Status $Status -Revision $Revision | ConvertTo-Json -Compress
    exit $Code
}

function Test-ExactReady {
    param([string]$Revision)
    if ($Revision -notmatch '^[0-9a-f]{40}$') { return $false }
    try {
        if (-not (Test-ArtemPanelReady -Paths $paths)) { return $false }
        $identity = Get-ArtemServedProductionBuildIdentity -Paths $paths
        return $null -ne $identity -and $identity.Revision -eq $Revision -and $identity.Profile -eq "accepted-v2"
    } catch { return $false }
}

try {
    # Establish this before any other preflight failure: an existing transaction
    # may belong to a previous/unknown updater and requires recovery evidence.
    if (Test-Path -LiteralPath $paths.UpdateTransactionState) { throw "update_recovery_required" }
    $transactionStateKnownClear = $true
    Update-ArtemProcessPath
    Set-Location -LiteralPath $paths.RepoRoot
    $origin = [string](& git.exe remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origin.Trim() -notin @(
        "https://github.com/decorum-guy/artem-control-center.git",
        "https://github.com/decorum-guy/artem-control-center",
        "git@github.com:decorum-guy/artem-control-center.git"
    )) { throw "repository_identity_mismatch" }
    $branch = [string](& git.exe branch --show-current 2>$null)
    if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne "main") { throw "branch_mismatch" }
    $current = [string](& git.exe rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $current.Trim() -notmatch '^[0-9a-f]{40}$') { throw "revision_missing" }
    $current = $current.Trim()
    $dirty = & git.exe status --porcelain --untracked-files=no 2>$null
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw "checkout_dirty" }
    if (Test-Path -LiteralPath $paths.ManualStop) { Write-Result -Status "deferred" -Revision $null -Code 1 }
    if (Test-Path -LiteralPath $paths.UpdateLock) { Write-Result -Status "deferred" -Revision $null -Code 1 }
    if (Test-Path -LiteralPath $paths.UpdateTransactionState) {
        $transactionStateKnownClear = $false
        throw "update_recovery_required"
    }
    if (-not (Test-ExactReady -Revision $current)) { throw "current_runtime_not_healthy" }
    if ($current -eq $ExpectedTargetHead) { Write-Result -Status "up_to_date" -Revision $current -Code 0 }

    # The updater re-fetches origin/main and CAS-checks both revisions before
    # staging. A new push after CI verification cannot silently change target.
    $null = Start-ArtemAutomaticUpdater -Paths $paths -CurrentHead $current `
        -TargetHead $ExpectedTargetHead -UpdateRequestId $requestId `
        -PossibleDispatch ([ref]$possibleDispatch)
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        $state = Get-ArtemJsonPayload -Path $paths.UpdateState
        $ownTerminal = $null -ne $state -and [string]$state.requestId -eq $requestId -and [string]$state.status -in @("success", "failed")
        $targetHealthy = $ownTerminal -and [string]$state.status -eq "success" -and (Test-ExactReady -Revision $ExpectedTargetHead)
        $previousHealthy = $ownTerminal -and [string]$state.status -eq "failed" -and (Test-ExactReady -Revision $current)
        $decision = Get-ArtemAutomaticUpdateResult -State $state -ExpectedRequest $requestId `
            -ExpectedTarget $ExpectedTargetHead -PreviousRevision $current `
            -TargetHealthy $targetHealthy `
            -PreviousHealthy $previousHealthy `
            -TransactionActive (Test-Path -LiteralPath $paths.UpdateTransactionState) `
            -LockActive (Test-Path -LiteralPath $paths.UpdateLock)
        if ($null -ne $decision) { Write-Result -Status $decision.status -Revision $decision.revision -Code $decision.code }
        if ($null -ne $state -and [string]$state.requestId -eq $requestId -and [string]$state.result -eq "rollback_failed") { break }
        # Parent updater exit is not completion: it hands responsibility to a
        # detached target revision. Only request-bound state + readback count.
        Start-Sleep -Seconds 2
    }
    Write-Result -Status "uncertain" -Revision $null -Code 2
}
catch {
    # Re-read only the marker; never infer that a possibly spawned child is
    # absent from the old runtime still being healthy or from a missing PID.
    try {
        if (Test-Path -LiteralPath $paths.UpdateTransactionState) { $transactionStateKnownClear = $false }
    } catch { $transactionStateKnownClear = $false }
    $failure = Get-ArtemAutomaticFailureResult -PossibleDispatch $possibleDispatch `
        -TransactionStateKnownClear $transactionStateKnownClear
    Write-Result -Status $failure.status -Revision $failure.revision -Code $failure.code
}
