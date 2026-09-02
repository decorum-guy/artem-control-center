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

# spawn proves only that Windows created powershell.exe. This body marker is
# deliberately before helper loading; transcript and update state happen later.
$ArtemUpdaterBootstrapStages = @("runtime-spawn-attempted", "runtime-process-created", "script-entered", "helpers-loaded", "paths-initialized", "lease-accepted", "lease-claimed", "transcript-starting", "transcript-started", "authoritative-state-started")
$ArtemUpdaterBootstrapResults = @("recorded", "helper-load-failed", "path-init-failed", "capability-apply-active", "lease-accept-failed", "lease-claim-failed", "transcript-start-failed")
$ArtemBootstrapRuntimeRoot = Join-Path $env:LOCALAPPDATA "ArtemControlCenter"
$ArtemBootstrapEvidencePath = Join-Path $ArtemBootstrapRuntimeRoot "update-bootstrap.json"

function Write-ArtemUpdaterBootstrapEvidence {
    param([string]$Stage, [string]$Result = "recorded")
    if ($ArtemUpdaterBootstrapStages -notcontains $Stage -or $ArtemUpdaterBootstrapResults -notcontains $Result -or $RequestId -notmatch '^[0-9a-f]{24}$') { return }
    try {
        New-Item -ItemType Directory -Force -Path $ArtemBootstrapRuntimeRoot | Out-Null
        $payload = @{ schemaVersion = 1; requestId = $RequestId.ToLowerInvariant(); stage = $Stage; result = $Result; updatedAt = [DateTime]::UtcNow.ToString("o") }
        $temporary = "$ArtemBootstrapEvidencePath.$PID.tmp"
        [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Compress), [Text.Encoding]::ASCII)
        if (Test-Path -LiteralPath $ArtemBootstrapEvidencePath) {
            [IO.File]::Replace($temporary, $ArtemBootstrapEvidencePath, [System.Management.Automation.Language.NullString]::Value)
        } else { [IO.File]::Move($temporary, $ArtemBootstrapEvidencePath) }
    } catch { } finally { Remove-Item -LiteralPath "$ArtemBootstrapEvidencePath.$PID.tmp" -Force -ErrorAction SilentlyContinue }
}

Write-ArtemUpdaterBootstrapEvidence -Stage "script-entered"
try {
    . (Join-Path $PSScriptRoot "runtime-common.ps1")
    . (Join-Path $PSScriptRoot "updater-target-handoff.ps1")
    Write-ArtemUpdaterBootstrapEvidence -Stage "helpers-loaded"
}
catch {
    Write-ArtemUpdaterBootstrapEvidence -Stage "script-entered" -Result "helper-load-failed"
    throw
}

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

$ArtemUpdateActivityMax = 32
$ArtemUpdateActivityCodes = @(
    "started",
    "stopping",
    "checkout",
    "handoff",
    "target-authoritative",
    "validating",
    "building",
    "artifact-ready",
    "restarting",
    "verifying",
    "rollback",
    "completed"
)

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
            # PowerShell 5.1 can bind an untyped $null as its NullString
            # wrapper. File.Replace accepts a real CLR null backup path, not
            # that wrapper, so pass the runtime's actual null value explicitly.
            [IO.File]::Replace(
                $temporary,
                $Path,
                [System.Management.Automation.Language.NullString]::Value
            )
        }
        else {
            [IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-ArtemUpdateActivityHistory {
    param([object]$Value)
    $history = @()
    foreach ($entry in @($Value)) {
        if ($null -eq $entry) { continue }
        $code = [string]$entry.code
        if ($ArtemUpdateActivityCodes -notcontains $code) { continue }
        if ($history.Count -gt 0 -and [string]$history[$history.Count - 1].code -eq $code) {
            continue
        }
        $history += [pscustomobject]@{ code = $code }
    }
    if ($history.Count -gt $ArtemUpdateActivityMax) {
        $history = @($history | Select-Object -Last $ArtemUpdateActivityMax)
    }
    return @($history)
}

function Add-ArtemUpdateActivity {
    param(
        [object]$Existing,
        [Parameter(Mandatory)][string]$Code
    )
    $history = @(Get-ArtemUpdateActivityHistory -Value $Existing)
    if ($ArtemUpdateActivityCodes -notcontains $Code) {
        return $history
    }
    if ($history.Count -eq 0 -or [string]$history[$history.Count - 1].code -ne $Code) {
        $history += [pscustomobject]@{ code = $Code }
    }
    if ($history.Count -gt $ArtemUpdateActivityMax) {
        $history = @($history | Select-Object -Last $ArtemUpdateActivityMax)
    }
    return @($history)
}

function Write-ArtemUpdateState {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidateSet("idle", "checking", "updating", "success", "failed")][string]$Status,
        [string]$Result,
        [string]$CurrentHead,
        [string]$TargetHead,
        [string]$RequestId,
        [string]$Phase,
        [string]$StartedAt,
        [string]$ServedRevision
    )
    $lock = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    $transaction = Get-ArtemJsonPayload -Path $Paths.UpdateTransactionState
    $previousState = Get-ArtemJsonPayload -Path $Paths.UpdateState
    if (-not $RequestId -and $null -ne $lock) { $RequestId = [string]$lock.requestId }
    if (-not $RequestId -and $null -ne $transaction) { $RequestId = [string]$transaction.requestId }
    if (-not $CurrentHead -and $null -ne $lock) { $CurrentHead = [string]$lock.expectedCurrentHead }
    if (-not $CurrentHead -and $null -ne $transaction) { $CurrentHead = [string]$transaction.previousHead }
    if (-not $TargetHead -and $null -ne $lock) { $TargetHead = [string]$lock.expectedTargetHead }
    if (-not $TargetHead -and $null -ne $transaction) { $TargetHead = [string]$transaction.targetHead }
    if (-not $Phase -and $null -ne $transaction) { $Phase = [string]$transaction.phase }
    if (-not $Phase -and $null -ne $previousState) { $Phase = [string]$previousState.phase }
    if (-not $StartedAt -and $null -ne $previousState) { $StartedAt = [string]$previousState.startedAt }
    $payload = @{
        schemaVersion = 1
        status = $Status
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    if ($Result) { $payload.result = $Result }
    if ($CurrentHead -match '^[0-9a-f]{40}$') { $payload.currentHead = $CurrentHead.ToLowerInvariant() }
    if ($TargetHead -match '^[0-9a-f]{40}$') { $payload.targetHead = $TargetHead.ToLowerInvariant() }
    if ($RequestId -match '^[0-9a-f]{24}$') { $payload.requestId = $RequestId.ToLowerInvariant() }
    if ($Phase -in @("started", "stopping", "checkout", "handoff", "target-authoritative", "validating", "building", "artifact-ready", "restarting", "verifying", "rollback")) {
        $payload.phase = $Phase
    }
    if ($StartedAt) { $payload.startedAt = $StartedAt }
    if ($ServedRevision -match '^[0-9a-f]{40}$') { $payload.servedRevision = $ServedRevision.ToLowerInvariant() }
    $history = if ($null -ne $previousState) {
        Get-ArtemUpdateActivityHistory -Value $previousState.events
    }
    else {
        @()
    }
    if ($Phase -in $ArtemUpdateActivityCodes) {
        $history = Add-ArtemUpdateActivity -Existing $history -Code $Phase
    }
    if ($Status -eq "success") {
        $history = Add-ArtemUpdateActivity -Existing $history -Code "completed"
    }
    $payload.events = @($history | Select-Object -Last $ArtemUpdateActivityMax)
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

function Bind-ArtemUpdateLockRevisions {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target
    )
    $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if (
        $null -eq $existing -or
        $existing.schemaVersion -ne 1 -or
        [string]$existing.status -ne "updating" -or
        [string]$existing.requestId -ne $LockRequestId -or
        [int]$existing.ownerPid -ne $PID
    ) {
        throw "Software update lease ownership was lost before preflight binding"
    }
    Write-ArtemUpdateJson -Path $Paths.UpdateLock -Payload @{
        schemaVersion = 1
        status = "updating"
        requestId = $LockRequestId
        expectedCurrentHead = $Current
        expectedTargetHead = $Target
        ownerPid = $PID
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
}

function Assert-ArtemExpectedUpdatePreflight {
    param(
        [switch]$Continuation,
        [switch]$HasExpected,
        [string]$Current,
        [string]$Target,
        [string]$ExpectedCurrent,
        [string]$ExpectedTarget
    )
    if (
        -not $Continuation -and $HasExpected -and (
            $Current -ne $ExpectedCurrent -or
            $Target -ne $ExpectedTarget
        )
    ) {
        throw "Update target changed since it was checked in the panel"
    }
}

function Remove-ArtemUpdateLock {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId
    )
    $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if (
        $null -ne $existing -and
        [string]$existing.requestId -eq $LockRequestId -and
        [int]$existing.ownerPid -eq $PID
    ) {
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
    Write-ArtemUpdateState -Paths $Paths -Status "updating" -Phase $Phase
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
    # Transfer the active parent lease to a bounded, ownerless handoff record
    # before the child starts. The child atomically claims this exact record;
    # it never needs to infer whether the waiting parent remains observable.
    Publish-ArtemTargetHandoffLease `
        -Paths $Paths `
        -LockRequestId $LockRequestId `
        -Current $PreviousHead `
        -Target $TargetHead
    try {
        $targetProcess = Start-ArtemTargetContinuation `
            -Paths $Paths `
            -Current $PreviousHead `
            -Target $TargetHead `
            -LockRequestId $LockRequestId `
            -TargetScript $Paths.UpdateScript
    }
    catch {
        Reclaim-ArtemTargetHandoffLease `
            -Paths $Paths `
            -LockRequestId $LockRequestId `
            -Current $PreviousHead `
            -Target $TargetHead
        throw
    }
    if ($null -eq $targetProcess -or $targetProcess.ExitCode -ne 0) {
        Reclaim-ArtemTargetHandoffLease `
            -Paths $Paths `
            -LockRequestId $LockRequestId `
            -Current $PreviousHead `
            -Target $TargetHead `
            -ExitedChildPid $targetProcess.Id
        Complete-ArtemTargetHandoffFailure -Paths $Paths -LockRequestId $LockRequestId
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

try {
    $paths = Get-ArtemRuntimePaths
    Initialize-ArtemRuntimeDirectories -Paths $paths
    Update-ArtemProcessPath
    Write-ArtemUpdaterBootstrapEvidence -Stage "paths-initialized"
}
catch {
    Write-ArtemUpdaterBootstrapEvidence -Stage "helpers-loaded" -Result "path-init-failed"
    throw
}

$hasExpected = [bool]$ExpectedCurrentHead -or [bool]$ExpectedTargetHead -or [bool]$RequestId
if ($hasExpected -and (-not $ExpectedCurrentHead -or -not $ExpectedTargetHead -or -not $RequestId)) {
    throw "ExpectedCurrentHead, ExpectedTargetHead and RequestId must be supplied together"
}

try {
    if (Test-ArtemCapabilityApplyActive -Paths $paths) {
        Write-ArtemUpdaterBootstrapEvidence -Stage "paths-initialized" -Result "capability-apply-active"
        throw "Capability Apply is active; software update was not started"
    }
}
catch {
    if ($_.Exception.Message -ne "Capability Apply is active; software update was not started") {
        Write-ArtemUpdaterBootstrapEvidence -Stage "paths-initialized" -Result "path-init-failed"
    }
    throw
}

if (-not $RequestId) {
    $RequestId = ([guid]::NewGuid().ToString("N").Substring(0, 24)).ToLowerInvariant()
    New-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
}
else {
    if (-not $Continuation) {
        try {
            New-ArtemUpdateLock `
                -Paths $paths `
                -LockRequestId $RequestId `
                -Current $ExpectedCurrentHead `
                -Target $ExpectedTargetHead `
                -AcceptExisting
            Write-ArtemUpdaterBootstrapEvidence -Stage "lease-accepted"
        }
        catch {
            Write-ArtemUpdaterBootstrapEvidence -Stage "paths-initialized" -Result "lease-accept-failed"
            throw
        }
    }
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
$targetHandoffClaim = $null

try {
    # From the first instruction after lock acquisition onward, every exit is
    # protected by the finally below. This includes transcript startup failure.
    if ($Continuation) {
        Write-ArtemTargetHandoffEvidence -Paths $paths -LockRequestId $RequestId -Stage "arguments-accepted" -Result "success"
        $targetHandoffClaim = Claim-ArtemTargetHandoffLease `
            -Paths $paths `
            -LockRequestId $RequestId `
            -Current $ExpectedCurrentHead `
            -Target $ExpectedTargetHead
    }
    else {
        try {
            Claim-ArtemUpdateLock `
                -Paths $paths `
                -LockRequestId $RequestId `
                -Current $ExpectedCurrentHead `
                -Target $ExpectedTargetHead
            Write-ArtemUpdaterBootstrapEvidence -Stage "lease-claimed"
        }
        catch {
            Write-ArtemUpdaterBootstrapEvidence -Stage "lease-accepted" -Result "lease-claim-failed"
            throw
        }
    }
    Write-ArtemUpdaterBootstrapEvidence -Stage "transcript-starting"
    try { Start-Transcript -Path $transcriptPath -Force | Out-Null }
    catch {
        Write-ArtemUpdaterBootstrapEvidence -Stage "transcript-starting" -Result "transcript-start-failed"
        throw
    }
    $transcriptStarted = $true
    Write-ArtemUpdaterBootstrapEvidence -Stage "transcript-started"
    if ($Continuation) {
        Write-ArtemTargetHandoffEvidence -Paths $paths -LockRequestId $RequestId -Stage "transcript-started" -Result "success"
    }

    Write-ArtemUpdateState -Paths $paths -Status "checking"
    Write-ArtemUpdaterBootstrapEvidence -Stage "authoritative-state-started"
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    $preflight = Get-ArtemUpdatePreflight -Paths $paths
    $currentHead = $preflight.Current
    $targetHead = $preflight.Target
    Assert-ArtemExpectedUpdatePreflight `
        -Continuation:$Continuation `
        -HasExpected:$hasExpected `
        -Current $currentHead `
        -Target $targetHead `
        -ExpectedCurrent $ExpectedCurrentHead `
        -ExpectedTarget $ExpectedTargetHead
    if (-not $Continuation -and -not $hasExpected) {
        # Manual invocations acquire a lease before preflight.  Persist the
        # discovered exact revisions before any handoff can be published.
        Bind-ArtemUpdateLockRevisions -Paths $paths -LockRequestId $RequestId -Current $currentHead -Target $targetHead
    }
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    $existingTransaction = Get-ArtemUpdateTransaction -Paths $paths

    if ($null -ne $existingTransaction -and [string]$existingTransaction.phase -eq "rollback") {
        throw "An incomplete production rollback requires recovery before another update"
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
        Write-ArtemTargetHandoffEvidence -Paths $paths -LockRequestId $RequestId -Stage "target-bootstrap-accepted" -Result "success"
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
            Write-ArtemUpdateState -Paths $paths -Status "success" -Result "up_to_date" -ServedRevision $targetHead
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
        Write-ArtemUpdateState -Paths $paths -Status "success" -Result "updated" -ServedRevision $targetHead
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
    if (
        $Continuation -and
        $null -ne $targetHandoffClaim -and
        [string]$targetHandoffClaim.Protocol -eq "legacy" -and
        -not $transactionStarted
    ) {
        Restore-ArtemLegacyTargetHandoffLease `
            -Paths $paths `
            -LockRequestId $RequestId `
            -Current $ExpectedCurrentHead `
            -Target $ExpectedTargetHead `
            -ParentPid ([int]$targetHandoffClaim.PreviousOwnerPid)
    }
    else {
        Remove-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    }
    if ($transcriptStarted) {
        Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        Write-Host "Update log: $transcriptPath"
    }
}
