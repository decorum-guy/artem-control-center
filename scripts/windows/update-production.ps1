param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCurrentHead,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetHead,
    [ValidatePattern('^[0-9a-f]{24}$')]
    [string]$RequestId,
    [switch]$Continuation
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Invoke-IsolatedValidation {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$Timestamp,
        [Parameter(Mandatory)][string]$LockRequestId,
        [Parameter(Mandatory)][string]$BuildRoot
    )

    $validationRoot = Join-Path $Paths.RuntimeRoot ("validation-temp\{0}" -f $Timestamp)
    $pytestTemp = Join-Path $validationRoot "pytest"
    $checkDist = Join-Path $BuildRoot "check-dist"
    $productionDist = Join-Path $BuildRoot "production-dist"
    New-Item -ItemType Directory -Force -Path $pytestTemp | Out-Null
    New-Item -ItemType Directory -Force -Path $checkDist | Out-Null
    New-Item -ItemType Directory -Force -Path $productionDist | Out-Null

    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    $previousPytestAddopts = $env:PYTEST_ADDOPTS
    $previousDashboardBuildOutDir = $env:PANEL_DASHBOARD_BUILD_OUT_DIR
    $previousProductionBuildOutDir = $env:PANEL_PRODUCTION_BUILD_OUT_DIR
    try {
        $env:TEMP = $validationRoot
        $env:TMP = $validationRoot
        $pytestTempForPytest = $pytestTemp.Replace('\', '/')
        $isolatedArgs = "--basetemp=`"$pytestTempForPytest`" -p no:cacheprovider"
        $env:PYTEST_ADDOPTS = if ([string]::IsNullOrWhiteSpace($previousPytestAddopts)) {
            $isolatedArgs
        }
        else {
            "$previousPytestAddopts $isolatedArgs"
        }

        Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
        $env:PANEL_DASHBOARD_BUILD_OUT_DIR = $checkDist
        Remove-Item Env:PANEL_PRODUCTION_BUILD_OUT_DIR -ErrorAction SilentlyContinue
        Invoke-CheckedCommand `
            -FilePath "npm.cmd" `
            -Arguments @("run", "check") `
            -Description "full validation"
        Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
        $env:PANEL_PRODUCTION_BUILD_OUT_DIR = $productionDist
        Invoke-CheckedCommand `
            -FilePath "npm.cmd" `
            -Arguments @("run", "build:production") `
            -Description "accepted V2 production dashboard build"
        Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
        return [pscustomobject]@{
            CheckDist = $checkDist
            ProductionDist = $productionDist
        }
    }
    finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
        $env:PYTEST_ADDOPTS = $previousPytestAddopts
        if ($null -eq $previousDashboardBuildOutDir) {
            Remove-Item Env:PANEL_DASHBOARD_BUILD_OUT_DIR -ErrorAction SilentlyContinue
        }
        else {
            $env:PANEL_DASHBOARD_BUILD_OUT_DIR = $previousDashboardBuildOutDir
        }
        if ($null -eq $previousProductionBuildOutDir) {
            Remove-Item Env:PANEL_PRODUCTION_BUILD_OUT_DIR -ErrorAction SilentlyContinue
        }
        else {
            $env:PANEL_PRODUCTION_BUILD_OUT_DIR = $previousProductionBuildOutDir
        }
        Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Write-ArtemUpdateJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Payload
    )
    $temporary = "$Path.$PID.tmp"
    $json = $Payload | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($temporary, $json, [Text.Encoding]::ASCII)
    try {
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($temporary, $Path, $null)
        }
        else {
            [IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Write-ArtemUpdateState {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidateSet("idle", "checking", "updating", "success", "failed")][string]$Status,
        [string]$Result
    )
    $payload = @{
        schemaVersion = 1
        status = $Status
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    if ($Result) { $payload.result = $Result }
    Write-ArtemUpdateJson -Path $Paths.UpdateState -Payload $payload
}

function New-ArtemUpdateLock {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId,
        [string]$Current,
        [string]$Target,
        [switch]$AcceptExisting
    )

    $existing = Get-ArtemSoftwareUpdateLock -Paths $Paths
    if ($AcceptExisting) {
        if (
            $null -eq $existing -or
            [string]$existing.requestId -ne $LockRequestId -or
            [string]$existing.expectedCurrentHead -ne $Current -or
            [string]$existing.expectedTargetHead -ne $Target
        ) {
            throw "Software update handoff lock does not match the requested revisions"
        }
        return
    }
    if ($null -ne $existing) {
        throw "Another Control Center software update is already in progress"
    }

    $payload = @{
        schemaVersion = 1
        status = "updating"
        requestId = $LockRequestId
        expectedCurrentHead = $Current
        expectedTargetHead = $Target
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    $json = $payload | ConvertTo-Json -Depth 4
    try {
        $stream = [IO.File]::Open($Paths.UpdateLock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        throw "Another Control Center software update is already in progress"
    }
}

function Claim-ArtemUpdateLock {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId,
        [string]$Current,
        [string]$Target
    )
    $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if (
        $null -eq $existing -or
        $existing.schemaVersion -ne 1 -or
        [string]$existing.status -ne "updating" -or
        [string]$existing.requestId -ne $LockRequestId
    ) {
        throw "Software update lease disappeared before updater claim"
    }
    if ($Current -and [string]$existing.expectedCurrentHead -ne $Current) {
        throw "Software update current revision changed before updater claim"
    }
    if ($Target -and [string]$existing.expectedTargetHead -ne $Target) {
        throw "Software update target revision changed before updater claim"
    }

    $payload = @{
        schemaVersion = 1
        status = "updating"
        requestId = $LockRequestId
        expectedCurrentHead = [string]$existing.expectedCurrentHead
        expectedTargetHead = [string]$existing.expectedTargetHead
        ownerPid = $PID
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    Write-ArtemUpdateJson -Path $Paths.UpdateLock -Payload $payload
}

function Refresh-ArtemUpdateLock {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId
    )
    $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if (
        $null -eq $existing -or
        $existing.schemaVersion -ne 1 -or
        [string]$existing.status -ne "updating" -or
        [string]$existing.requestId -ne $LockRequestId -or
        [int]$existing.ownerPid -ne $PID
    ) {
        throw "Software update lease ownership was lost"
    }
    $payload = @{
        schemaVersion = 1
        status = "updating"
        requestId = $LockRequestId
        expectedCurrentHead = [string]$existing.expectedCurrentHead
        expectedTargetHead = [string]$existing.expectedTargetHead
        ownerPid = $PID
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    Write-ArtemUpdateJson -Path $Paths.UpdateLock -Payload $payload
}

function Remove-ArtemUpdateLock {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId
    )
    $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if ($null -ne $existing -and [string]$existing.requestId -eq $LockRequestId) {
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
    }
}

function Write-ArtemUpdateTransaction {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidateSet("started", "stopping", "checkout", "handoff", "target-authoritative", "validating", "building", "artifact-ready", "restarting", "verifying", "rollback")][string]$Phase,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId
    )
    Write-ArtemUpdateJson -Path $Paths.UpdateTransactionState -Payload @{
        schemaVersion = 1
        status = "incomplete"
        phase = $Phase
        previousHead = $PreviousHead.ToLowerInvariant()
        targetHead = $TargetHead.ToLowerInvariant()
        requestId = $LockRequestId.ToLowerInvariant()
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
}

function Get-ArtemUpdateTransaction {
    param([Parameter(Mandatory)]$Paths)
    if (-not (Test-Path -LiteralPath $Paths.UpdateTransactionState)) { return $null }
    $payload = Get-ArtemJsonPayload -Path $Paths.UpdateTransactionState
    $validPhases = @("started", "stopping", "checkout", "handoff", "target-authoritative", "validating", "building", "artifact-ready", "restarting", "verifying", "rollback")
    $updatedAt = $null
    try {
        $updatedAt = [DateTimeOffset]::Parse([string]$payload.updatedAt).ToUniversalTime()
    }
    catch {
        $updatedAt = $null
    }
    if (
        $null -eq $payload -or
        $payload.schemaVersion -ne 1 -or
        [string]$payload.status -ne "incomplete" -or
        [string]$payload.phase -notin $validPhases -or
        [string]$payload.previousHead -notmatch '^[0-9a-f]{40}$' -or
        [string]$payload.targetHead -notmatch '^[0-9a-f]{40}$' -or
        [string]$payload.requestId -notmatch '^[0-9a-f]{24}$' -or
        $null -eq $updatedAt -or
        $updatedAt -gt [DateTimeOffset]::UtcNow
    ) {
        throw "Incomplete production update marker is invalid"
    }
    return $payload
}

function Remove-ArtemUpdateTransaction {
    param([Parameter(Mandatory)]$Paths)
    Remove-Item -LiteralPath $Paths.UpdateTransactionState -Force -ErrorAction SilentlyContinue
}

function Assert-ArtemStagedProductionBuild {
    param(
        [Parameter(Mandatory)][string]$DashboardRoot,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision
    )
    if (-not (Test-Path -LiteralPath (Join-Path $DashboardRoot "index.html"))) {
        throw "Target production build has no dashboard index"
    }
    Assert-ArtemProductionBuildIdentity -DashboardRoot $DashboardRoot -ExpectedRevision $ExpectedRevision | Out-Null
}

function Promote-ArtemProductionBuild {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$StagedDashboard
    )
    if (-not (Test-Path -LiteralPath (Join-Path $StagedDashboard "index.html"))) {
        throw "Cannot promote a missing staged production dashboard"
    }

    # Keep the last known-good generated artifact outside the checkout until
    # served-artifact verification has completed. This is a narrow generated
    # directory, never the repository root or a user-owned runtime directory.
    if (Test-Path -LiteralPath $Paths.DashboardDist) {
        if (Test-Path -LiteralPath $Paths.RollbackDashboard) {
            Remove-Item -LiteralPath $Paths.DashboardDist -Recurse -Force
        }
        else {
            Move-Item -LiteralPath $Paths.DashboardDist -Destination $Paths.RollbackDashboard
        }
    }
    Move-Item -LiteralPath $StagedDashboard -Destination $Paths.DashboardDist
}

function Invoke-ArtemRollback {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$RollbackHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][string]$BuildRoot
    )

    Write-ArtemUpdateTransaction `
        -Paths $Paths `
        -Phase "rollback" `
        -PreviousHead $RollbackHead `
        -TargetHead $TargetHead `
        -LockRequestId $LockRequestId
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    Stop-ArtemRuntime -Paths $Paths -Manual $false
    Set-Location -LiteralPath $Paths.RepoRoot
    Invoke-CheckedCommand `
        -FilePath "git.exe" `
        -Arguments @("reset", "--hard", $RollbackHead) `
        -Description "git rollback"
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("ci") -Description "rollback npm ci"
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("run", "setup") -Description "rollback setup"
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId

    $rollbackIdentity = Get-ArtemProductionBuildIdentity -DashboardRoot $Paths.RollbackDashboard
    if ($null -eq $rollbackIdentity -or $rollbackIdentity.Revision -ne $RollbackHead) {
        $rollbackBuildRoot = Join-Path $BuildRoot "rollback-dist"
        New-Item -ItemType Directory -Force -Path $rollbackBuildRoot | Out-Null
        $previousProductionOutDir = $env:PANEL_PRODUCTION_BUILD_OUT_DIR
        try {
            $env:PANEL_PRODUCTION_BUILD_OUT_DIR = $rollbackBuildRoot
            Invoke-CheckedCommand `
                -FilePath "npm.cmd" `
                -Arguments @("run", "build:production") `
                -Description "rollback production build"
        }
        finally {
            if ($null -eq $previousProductionOutDir) {
                Remove-Item Env:PANEL_PRODUCTION_BUILD_OUT_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:PANEL_PRODUCTION_BUILD_OUT_DIR = $previousProductionOutDir
            }
        }
        Assert-ArtemStagedProductionBuild -DashboardRoot $rollbackBuildRoot -ExpectedRevision $RollbackHead
        if (Test-Path -LiteralPath $Paths.DashboardDist) {
            Remove-Item -LiteralPath $Paths.DashboardDist -Recurse -Force
        }
        Move-Item -LiteralPath $rollbackBuildRoot -Destination $Paths.DashboardDist
    }
    elseif (Test-Path -LiteralPath $Paths.DashboardDist) {
        Remove-Item -LiteralPath $Paths.DashboardDist -Recurse -Force
        Move-Item -LiteralPath $Paths.RollbackDashboard -Destination $Paths.DashboardDist
    }
    else {
        Move-Item -LiteralPath $Paths.RollbackDashboard -Destination $Paths.DashboardDist
    }

    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    Ensure-ArtemHealthyVisiblePanel `
        -Paths $Paths `
        -LockRequestId $LockRequestId `
        -ExpectedBuildRevision $RollbackHead | Out-Null
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    $rollbackDecision = Get-ArtemProductionRollbackState `
        -RollbackHead $RollbackHead `
        -TargetHead $TargetHead `
        -ServedRollbackHealthy $true
    if ($rollbackDecision.Result -ne "rollback_restored" -or $rollbackDecision.TargetDeployed) {
        throw "Rollback verification did not restore the known-good deployment"
    }
    Set-Content -LiteralPath $Paths.LastKnownGood -Value $rollbackDecision.RollbackHead -Encoding ASCII
    Write-ArtemUpdateState -Paths $Paths -Status $rollbackDecision.Status -Result $rollbackDecision.Result
    if (-not $rollbackDecision.TransactionRemains) {
        Remove-ArtemUpdateTransaction -Paths $Paths
    }
}

function Get-ArtemUpdatePreflight {
    param([Parameter(Mandatory)]$Paths)

    Set-Location -LiteralPath $Paths.RepoRoot
    $branch = (& git.exe branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
        throw "Production checkout is not on main"
    }

    $dirty = & git.exe status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the production checkout" }
    if ($dirty) { throw "Production checkout has tracked local changes" }

    Invoke-CheckedCommand `
        -FilePath "git.exe" `
        -Arguments @("fetch", "origin", "main") `
        -Description "git fetch"

    $current = (& git.exe rev-parse HEAD).Trim().ToLowerInvariant()
    $target = (& git.exe rev-parse origin/main).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $current -notmatch '^[0-9a-f]{40}$' -or $target -notmatch '^[0-9a-f]{40}$') {
        throw "Unable to resolve current or target revision"
    }

    if ($current -ne $target) {
        & git.exe merge-base --is-ancestor $current $target
        if ($LASTEXITCODE -eq 1) { throw "Production checkout has diverged from origin/main" }
        if ($LASTEXITCODE -ne 0) { throw "Unable to validate update ancestry" }
    }

    return [pscustomobject]@{ Current = $current; Target = $target }
}

function Ensure-ArtemHealthyVisiblePanel {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedBuildRevision
    )
    Remove-Item -LiteralPath $Paths.ManualStop -Force -ErrorAction SilentlyContinue
    if (-not (Test-ArtemRuntimeProcess -Paths $Paths) -or -not (Wait-ArtemPanelReady -Paths $Paths -TimeoutSeconds 20)) {
        & $Paths.StartScript -NoKiosk -UpdateRequestId $LockRequestId
    }
    if (-not (Wait-ArtemPanelReady -Paths $Paths -TimeoutSeconds 60)) {
        throw "Control Center runtime did not become healthy"
    }
    Assert-ArtemServedProductionBuildIdentity -Paths $Paths -ExpectedRevision $ExpectedBuildRevision | Out-Null
    return [bool](Ensure-ArtemKioskVisible -Paths $Paths -TimeoutSeconds 20)
}

function Invoke-ArtemTargetUpdater {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId
    )
    Write-ArtemUpdateTransaction `
        -Paths $Paths `
        -Phase "handoff" `
        -PreviousHead $PreviousHead `
        -TargetHead $TargetHead `
        -LockRequestId $LockRequestId
    Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    $targetScriptArgument = "`"$($Paths.UpdateScript)`""

    # This is the only continuation entrypoint. The path is derived from the
    # checked-out repository and the exact revision is carried in the locked,
    # bounded transaction state; no browser/user path or ref is accepted.
    $targetProcess = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $targetScriptArgument,
            "-ExpectedCurrentHead",
            $PreviousHead,
            "-ExpectedTargetHead",
            $TargetHead,
            "-RequestId",
            $LockRequestId,
            "-Continuation"
        ) `
        -WorkingDirectory $Paths.RepoRoot `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($null -eq $targetProcess -or $targetProcess.ExitCode -ne 0) {
        throw "Target updater continuation failed"
    }
}

function Get-ArtemRollbackCandidate {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$CurrentHead
    )
    $identity = Get-ArtemProductionBuildIdentity -DashboardRoot $Paths.DashboardDist
    if ($null -ne $identity -and $identity.Revision -ne $CurrentHead) {
        return $identity.Revision
    }
    if (Test-Path -LiteralPath $Paths.LastKnownGood) {
        $lastKnownGood = (Get-Content -LiteralPath $Paths.LastKnownGood -Raw).Trim().ToLowerInvariant()
        if ($lastKnownGood -match '^[0-9a-f]{40}$' -and $lastKnownGood -ne $CurrentHead) {
            return $lastKnownGood
        }
    }
    return $CurrentHead
}

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath

$hasExpected = [bool]$ExpectedCurrentHead -or [bool]$ExpectedTargetHead -or [bool]$RequestId
if ($hasExpected -and (-not $ExpectedCurrentHead -or -not $ExpectedTargetHead -or -not $RequestId)) {
    throw "ExpectedCurrentHead, ExpectedTargetHead and RequestId must be supplied together"
}

if (Test-ArtemCapabilityApplyActive -Paths $paths) {
    throw "Capability Apply is active; software update was not started"
}

if (-not $RequestId) {
    $RequestId = ([guid]::NewGuid().ToString("N").Substring(0, 24)).ToLowerInvariant()
    New-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
}
else {
    New-ArtemUpdateLock `
        -Paths $paths `
        -LockRequestId $RequestId `
        -Current $ExpectedCurrentHead `
        -Target $ExpectedTargetHead `
        -AcceptExisting
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcriptPath = Join-Path $paths.Logs "update-$timestamp-$RequestId-$PID.log"
$transcriptStarted = $false
$currentHead = $null
$targetHead = $null
$transactionStarted = $false
$runtimeStoppedForTransaction = $false
$handoffStarted = $false
$rollbackHead = $null
$buildRoot = $null
$rollbackRestored = $false

try {
    # From the first instruction after lock acquisition onward, every exit is
    # protected by the finally below. This includes transcript startup failure.
    Claim-ArtemUpdateLock `
        -Paths $paths `
        -LockRequestId $RequestId `
        -Current $ExpectedCurrentHead `
        -Target $ExpectedTargetHead
    Start-Transcript -Path $transcriptPath -Force | Out-Null
    $transcriptStarted = $true

    Write-ArtemUpdateState -Paths $paths -Status "checking"
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    $preflight = Get-ArtemUpdatePreflight -Paths $paths
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    $currentHead = $preflight.Current
    $targetHead = $preflight.Target
    $existingTransaction = Get-ArtemUpdateTransaction -Paths $paths

    if ($null -ne $existingTransaction -and [string]$existingTransaction.phase -eq "rollback") {
        throw "An incomplete production rollback requires recovery before another update"
    }

    if (-not $Continuation -and $hasExpected -and (
        $currentHead -ne $ExpectedCurrentHead -or
        $targetHead -ne $ExpectedTargetHead
    )) {
        throw "Update target changed since it was checked in the panel"
    }

    $targetPhase = $false
    $transaction = $existingTransaction
    if ($Continuation) {
        if (-not $hasExpected -or $currentHead -ne $ExpectedTargetHead -or $targetHead -ne $ExpectedTargetHead) {
            throw "Target updater continuation revision proof failed"
        }
        if (
            $null -eq $transaction -or
            [string]$transaction.targetHead -ne $ExpectedTargetHead -or
            [string]$transaction.previousHead -ne $ExpectedCurrentHead
        ) {
            throw "Target updater continuation marker does not match the locked target"
        }
        $decision = Get-ArtemProductionUpdateDecision `
            -CurrentHead $currentHead `
            -TargetHead $targetHead `
            -Transaction $transaction `
            -RollbackCandidate $ExpectedCurrentHead `
            -Continuation
        if ($decision.Action -ne "target-phase") {
            throw "Target updater continuation selected an invalid recovery action"
        }
        Assert-ArtemTargetUpdaterLogic -Paths $paths -ExpectedTargetHead $ExpectedTargetHead
        $currentHead = $decision.CurrentHead
        $targetHead = $decision.TargetHead
        $rollbackHead = $decision.RollbackHead
        $transactionStarted = $true
        $runtimeStoppedForTransaction = $true
        Write-ArtemUpdateState -Paths $paths -Status "updating"
        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "target-authoritative" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId
        $targetPhase = $true
    }
    else {
        $deploymentHealthy = $false
        if ($currentHead -eq $targetHead -and $null -eq $transaction) {
            $deploymentHealthy = Test-ArtemProductionDeploymentHealthy -Paths $paths -ExpectedRevision $targetHead
        }
        $rollbackCandidate = if ($currentHead -eq $targetHead -and $null -eq $transaction) {
            Get-ArtemRollbackCandidate -Paths $paths -CurrentHead $currentHead
        }
        else {
            $currentHead
        }
        $decision = Get-ArtemProductionUpdateDecision `
            -CurrentHead $currentHead `
            -TargetHead $targetHead `
            -Transaction $transaction `
            -RollbackCandidate $rollbackCandidate `
            -ArtifactHealthy $deploymentHealthy `
            -RuntimeReady $deploymentHealthy `
            -ServedArtifactHealthy $deploymentHealthy

        if ($decision.Action -eq "up-to-date") {
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Ensure-ArtemHealthyVisiblePanel `
                -Paths $paths `
                -LockRequestId $RequestId `
                -ExpectedBuildRevision $targetHead | Out-Null
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Set-Content -LiteralPath $paths.LastKnownGood -Value $currentHead -Encoding ASCII
            Write-ArtemUpdateState -Paths $paths -Status "success" -Result "up_to_date"
            Write-Host "Artem Control Center is already up to date and serving $currentHead"
            return
        }

        if ($decision.Action -eq "target-phase") {
            $rollbackHead = $decision.RollbackHead
            $runtimeStoppedForTransaction = $null -ne $transaction -and [string]$transaction.phase -in @("stopping", "checkout", "handoff", "target-authoritative", "validating", "building", "artifact-ready", "restarting", "verifying")
            if ($null -eq $transaction) {
                $rollbackHead = $decision.RollbackHead
                Write-ArtemUpdateTransaction `
                    -Paths $paths `
                    -Phase "started" `
                    -PreviousHead $rollbackHead `
                    -TargetHead $targetHead `
                    -LockRequestId $RequestId
            }
            Assert-ArtemTargetUpdaterLogic -Paths $paths -ExpectedTargetHead $targetHead
            $transactionStarted = $true
            Write-ArtemUpdateState -Paths $paths -Status "updating"
            $targetPhase = $true
        }
        elseif ($decision.Action -eq "bootstrap") {
            Write-ArtemUpdateState -Paths $paths -Status "updating"
            Write-Host "Updating Artem Control Center"
            Write-Host "From: $currentHead"
            Write-Host "To:   $targetHead"

            # From this point the production transaction owns runtime/repo recovery.
            # The old updater performs only the safe checkout/bootstrap handoff.
            $transactionStarted = $true
            $rollbackHead = $decision.RollbackHead
            Write-ArtemUpdateTransaction `
                -Paths $paths `
                -Phase "started" `
                -PreviousHead $rollbackHead `
                -TargetHead $targetHead `
                -LockRequestId $RequestId
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Write-ArtemUpdateTransaction `
                -Paths $paths `
                -Phase "stopping" `
                -PreviousHead $rollbackHead `
                -TargetHead $targetHead `
                -LockRequestId $RequestId
            Stop-ArtemRuntime -Paths $paths -Manual $false
            $runtimeStoppedForTransaction = $true
            Set-Content -LiteralPath $paths.RollbackHead -Value $rollbackHead -Encoding ASCII

            # Merge the exact preflight target, never a moving symbolic ref.
            Invoke-CheckedCommand `
                -FilePath "git.exe" `
                -Arguments @("merge", "--ff-only", $targetHead) `
                -Description "fast-forward update"
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Write-ArtemUpdateTransaction `
                -Paths $paths `
                -Phase "checkout" `
                -PreviousHead $rollbackHead `
                -TargetHead $targetHead `
                -LockRequestId $RequestId

            $handoffStarted = $true
            Invoke-ArtemTargetUpdater `
                -Paths $paths `
                -PreviousHead $rollbackHead `
                -TargetHead $targetHead `
                -LockRequestId $RequestId
            return
        }
        else {
            throw "Production update decision was not actionable: $($decision.Reason)"
        }
    }

    if ($targetPhase) {
        $buildRoot = Join-Path $paths.RuntimeRoot ("update-build-{0}" -f $RequestId)
        if (Test-Path -LiteralPath $buildRoot) {
            Remove-Item -LiteralPath $buildRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "validating" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("ci") -Description "npm ci"
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("run", "setup") -Description "project setup"
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId

        $env:PANEL_AGENT_MODE = "read_only"
        $env:PANEL_WRITES_ENABLED = "false"
        $env:PANEL_COFFEE_TIMING_WRITES_ENABLED = "false"
        $env:PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "false"
        $env:PANEL_COFFEE_ACTIONS_ENABLED = "false"
        $env:PANEL_KIOSK_CONTROLS_ENABLED = "false"

        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "building" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId
        $buildPaths = Invoke-IsolatedValidation `
            -Paths $paths `
            -Timestamp $timestamp `
            -LockRequestId $RequestId `
            -BuildRoot $buildRoot
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Assert-ArtemStagedProductionBuild `
            -DashboardRoot $buildPaths.ProductionDist `
            -ExpectedRevision $targetHead
        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "artifact-ready" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId

        if (-not $runtimeStoppedForTransaction) {
            Stop-ArtemRuntime -Paths $paths -Manual $false
            $runtimeStoppedForTransaction = $true
        }
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Promote-ArtemProductionBuild -Paths $paths -StagedDashboard $buildPaths.ProductionDist
        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "restarting" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        $kioskConfirmed = Ensure-ArtemHealthyVisiblePanel `
            -Paths $paths `
            -LockRequestId $RequestId `
            -ExpectedBuildRevision $targetHead
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Write-ArtemUpdateTransaction `
            -Paths $paths `
            -Phase "verifying" `
            -PreviousHead $rollbackHead `
            -TargetHead $targetHead `
            -LockRequestId $RequestId
        Assert-ArtemProductionBuildIdentity -DashboardRoot $paths.DashboardDist -ExpectedRevision $targetHead | Out-Null
        Assert-ArtemServedProductionBuildIdentity -Paths $paths -ExpectedRevision $targetHead | Out-Null
        Set-Content -LiteralPath $paths.LastKnownGood -Value $targetHead -Encoding ASCII
        Remove-ArtemUpdateTransaction -Paths $paths
        Remove-Item -LiteralPath $paths.RollbackDashboard -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-ArtemUpdateState -Paths $paths -Status "success" -Result "updated"
        if (-not $kioskConfirmed) {
            Write-Warning "Production dashboard is verified, but kiosk presence remains unconfirmed"
        }
        Write-Host "Update successful: $targetHead"
    }
}
catch {
    $failure = $_
    Write-Warning "Update failed: $($failure.Exception.Message)"

    $transactionPayload = Get-ArtemJsonPayload -Path $paths.UpdateTransactionState
    $updatePayload = Get-ArtemJsonPayload -Path $paths.UpdateState
    $childAlreadyHandled = (
        $handoffStarted -and
        (
            ($null -eq $transactionPayload -and $null -ne $updatePayload -and [string]$updatePayload.result -in @("rollback_restored", "rollback_failed")) -or
            ($null -ne $transactionPayload -and [string]$transactionPayload.phase -eq "rollback")
        )
    )
    $childRollbackFailed = $handoffStarted -and $null -ne $transactionPayload -and [string]$transactionPayload.phase -eq "rollback"

    if ($transactionStarted -and $currentHead -and $runtimeStoppedForTransaction -and -not $childAlreadyHandled) {
        try {
            Invoke-ArtemRollback `
                -Paths $paths `
                -RollbackHead $rollbackHead `
                -TargetHead $targetHead `
                -LockRequestId $RequestId `
                -BuildRoot $(if ($buildRoot) { $buildRoot } else { Join-Path $paths.RuntimeRoot ("update-build-{0}" -f $RequestId) })
            $rollbackRestored = $true
            Write-Host "Rollback successful: $rollbackHead"
        }
        catch {
            $rollbackFailure = Get-ArtemProductionRollbackState `
                -RollbackHead $rollbackHead `
                -TargetHead $targetHead `
                -RollbackFailed $true
            Write-ArtemUpdateState -Paths $paths -Status $rollbackFailure.Status -Result $rollbackFailure.Result
            Write-Warning "Automatic rollback also failed: $($_.Exception.Message)"
        }
    }
    elseif ($childRollbackFailed) {
        Write-ArtemUpdateState -Paths $paths -Status "failed" -Result "rollback_failed"
    }
    elseif ($transactionStarted -and -not $childAlreadyHandled) {
        $failureStage = if ($failure.Exception.Message -like "*artifact identity*") {
            "artifact-assertion"
        }
        elseif ($failure.Exception.Message -like "*Served production dashboard artifact*") {
            "served-verification"
        }
        elseif ($failure.Exception.Message -like "*runtime*healthy*" -or $failure.Exception.Message -like "*runtime*stop*") {
            "restart"
        }
        else {
            "build"
        }
        $failureState = Get-ArtemProductionFailureState `
            -Stage $failureStage `
            -RuntimeStopped $runtimeStoppedForTransaction
        Write-ArtemUpdateState -Paths $paths -Status $failureState.Status -Result $failureState.Result
    }
    else {
        Write-ArtemUpdateState -Paths $paths -Status "failed" -Result "pre_update_failed"
    }

    throw $failure
}
finally {
    Remove-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    if ($transcriptStarted) {
        Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        Write-Host "Update log: $transcriptPath"
    }
}
