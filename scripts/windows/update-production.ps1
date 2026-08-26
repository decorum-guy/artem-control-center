param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCurrentHead,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetHead,
    [ValidatePattern('^[0-9a-f]{24}$')]
    [string]$RequestId
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
        [Parameter(Mandatory)][string]$LockRequestId
    )

    $validationRoot = Join-Path $Paths.RuntimeRoot ("validation-temp\{0}" -f $Timestamp)
    $pytestTemp = Join-Path $validationRoot "pytest"
    New-Item -ItemType Directory -Force -Path $pytestTemp | Out-Null

    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    $previousPytestAddopts = $env:PYTEST_ADDOPTS
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
        Invoke-CheckedCommand `
            -FilePath "npm.cmd" `
            -Arguments @("run", "check") `
            -Description "full validation"
        Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
        Invoke-CheckedCommand `
            -FilePath "npm.cmd" `
            -Arguments @("run", "build:production") `
            -Description "accepted V2 production dashboard build"
        Refresh-ArtemUpdateLock -Paths $Paths -LockRequestId $LockRequestId
    }
    finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
        $env:PYTEST_ADDOPTS = $previousPytestAddopts
        Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Write-ArtemUpdateJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Payload
    )
    $temporary = "$Path.$PID.tmp"
    $Payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding ASCII
    Move-Item -LiteralPath $temporary -Destination $Path -Force
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
        [Parameter(Mandatory)][string]$LockRequestId
    )
    Remove-Item -LiteralPath $Paths.ManualStop -Force -ErrorAction SilentlyContinue
    if (-not (Test-ArtemRuntimeProcess -Paths $Paths) -or -not (Wait-ArtemPanelReady -Paths $Paths -TimeoutSeconds 20)) {
        & $Paths.StartScript -NoKiosk -UpdateRequestId $LockRequestId
    }
    if (-not (Wait-ArtemPanelReady -Paths $Paths -TimeoutSeconds 60)) {
        throw "Control Center runtime did not become healthy"
    }
    Ensure-ArtemKioskVisible -Paths $Paths -TimeoutSeconds 20
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
$transcriptPath = Join-Path $paths.Logs "update-$timestamp.log"
$transcriptStarted = $false
$currentHead = $null
$targetHead = $null
$transactionStarted = $false
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

    if ($hasExpected -and (
        $currentHead -ne $ExpectedCurrentHead -or
        $targetHead -ne $ExpectedTargetHead
    )) {
        throw "Update target changed since it was checked in the panel"
    }

    if ($currentHead -eq $targetHead) {
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Ensure-ArtemHealthyVisiblePanel -Paths $paths -LockRequestId $RequestId
        Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
        Set-Content -LiteralPath $paths.LastKnownGood -Value $currentHead -Encoding ASCII
        Write-ArtemUpdateState -Paths $paths -Status "success" -Result "up_to_date"
        Write-Host "Artem Control Center is already up to date: $currentHead"
        return
    }

    Write-ArtemUpdateState -Paths $paths -Status "updating"
    Write-Host "Updating Artem Control Center"
    Write-Host "From: $currentHead"
    Write-Host "To:   $targetHead"

    # From this point the production transaction owns runtime/repo recovery.
    # Any failure before this flag is set must fail without stopping or rolling
    # back a checkout that was never modified.
    $transactionStarted = $true
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    Stop-ArtemRuntime -Paths $paths -Manual $false
    Set-Content -LiteralPath $paths.RollbackHead -Value $currentHead -Encoding ASCII

    # Merge the exact preflight target, never a moving symbolic ref.
    Invoke-CheckedCommand `
        -FilePath "git.exe" `
        -Arguments @("merge", "--ff-only", $targetHead) `
        -Description "fast-forward update"
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

    Invoke-IsolatedValidation -Paths $paths -Timestamp $timestamp -LockRequestId $RequestId
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
    Ensure-ArtemHealthyVisiblePanel -Paths $paths -LockRequestId $RequestId
    Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId

    Set-Content -LiteralPath $paths.LastKnownGood -Value $targetHead -Encoding ASCII
    Write-ArtemUpdateState -Paths $paths -Status "success" -Result "updated"
    Write-Host "Update successful: $targetHead"
}
catch {
    $failure = $_
    Write-Warning "Update failed: $($failure.Exception.Message)"

    if ($transactionStarted -and $currentHead) {
        try {
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Stop-ArtemRuntime -Paths $paths -Manual $false
            Set-Location -LiteralPath $paths.RepoRoot
            Invoke-CheckedCommand -FilePath "git.exe" -Arguments @("reset", "--hard", $currentHead) -Description "git rollback"
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("ci") -Description "rollback npm ci"
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("run", "setup") -Description "rollback setup"
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Invoke-CheckedCommand -FilePath "npm.cmd" -Arguments @("run", "build:production") -Description "rollback production build"
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Ensure-ArtemHealthyVisiblePanel -Paths $paths -LockRequestId $RequestId
            Refresh-ArtemUpdateLock -Paths $paths -LockRequestId $RequestId
            Set-Content -LiteralPath $paths.LastKnownGood -Value $currentHead -Encoding ASCII
            $rollbackRestored = $true
            Write-ArtemUpdateState -Paths $paths -Status "failed" -Result "rollback_restored"
            Write-Host "Rollback successful: $currentHead"
        }
        catch {
            Write-ArtemUpdateState -Paths $paths -Status "failed" -Result "rollback_failed"
            Write-Warning "Automatic rollback also failed: $($_.Exception.Message)"
        }
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
