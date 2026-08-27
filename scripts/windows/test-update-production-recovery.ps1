$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$revisionA = "a" * 40
$revisionB = "b" * 40
$requestId = "0" * 24
$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-update-recovery-{0}" -f [guid]::NewGuid())
$dashboard = Join-Path $root "dashboard"
$runtimeEnv = Join-Path $root "runtime.env"
$capabilityState = Join-Path $root "capability-state.json"
$unknownFile = Join-Path $root "owner-unknown.txt"
$servedRevision = $revisionA

function Assert-RecoveryEqual {
    param(
        [Parameter(Mandatory)]$Actual,
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Actual -ne $Expected) {
        throw "$Message. Actual='$Actual' Expected='$Expected'"
    }
}

function Assert-RecoveryTrue {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

# The real served-identity path is exercised without opening a listener. This
# function replaces only the network primitive; the production comparison and
# health functions remain the ones used by update-production.ps1.
function Invoke-RestMethod {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method,
        [int]$TimeoutSec
    )
    return [pscustomobject]@{
        schemaVersion = "dashboard-build.v1"
        revision = $script:servedRevision
        profile = "accepted-v2"
        buildId = "$($script:servedRevision):accepted-v2"
    }
}

# The health decision is also exercised with only its runtime probes isolated.
function Test-ArtemRuntimeProcess {
    param([Parameter(Mandatory)]$Paths)
    return $true
}
function Test-ArtemPanelReady {
    param([Parameter(Mandatory)]$Paths)
    return $true
}

try {
    New-Item -ItemType Directory -Force -Path $dashboard | Out-Null
    Set-Content -LiteralPath (Join-Path $dashboard "index.html") -Value "target" -Encoding ASCII
    @{
        schemaVersion = "dashboard-build.v1"
        revision = $revisionB
        profile = "accepted-v2"
        buildId = "$revisionB`:accepted-v2"
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dashboard "dashboard-build.json") -Encoding ASCII

    $healthPaths = [pscustomobject]@{
        DashboardDist = $dashboard
        ProductionBuildUrl = "http://fixture.invalid/production-build"
    }

    # A. Ctrl+C after checkout: the next decision resumes B and retains A as
    # the rollback candidate instead of treating equal Git heads as complete.
    $checkoutTransaction = [pscustomobject]@{
        status = "incomplete"
        phase = "checkout"
        previousHead = $revisionA
        targetHead = $revisionB
        requestId = $requestId
    }
    $interrupted = Get-ArtemProductionUpdateDecision `
        -CurrentHead $revisionB `
        -TargetHead $revisionB `
        -Transaction $checkoutTransaction `
        -RollbackCandidate $revisionA
    Assert-RecoveryEqual -Actual $interrupted.Action -Expected "target-phase" -Message "Interrupted checkout must resume target phase"
    Assert-RecoveryEqual -Actual $interrupted.TargetHead -Expected $revisionB -Message "Interrupted checkout target must remain B"
    Assert-RecoveryEqual -Actual $interrupted.RollbackHead -Expected $revisionA -Message "Interrupted checkout rollback candidate must remain A"
    Assert-RecoveryEqual -Actual $interrupted.Reason -Expected "incomplete-transaction" -Message "Interrupted checkout must be identified as incomplete"

    # B. Same-SHA stale, missing, and malformed artifacts all select repair.
    # First make the on-disk identity stale and run the real deployment-health
    # function used by update-production.ps1 before consulting the shared
    # recovery decision.
    @{
        schemaVersion = "dashboard-build.v1"
        revision = $revisionA
        profile = "accepted-v2"
        buildId = "{0}:accepted-v2" -f $revisionA
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dashboard "dashboard-build.json") -Encoding ASCII
    $staleHealth = Test-ArtemProductionDeploymentHealthy -Paths $healthPaths -ExpectedRevision $revisionB
    Assert-RecoveryTrue -Condition (-not $staleHealth) -Message "Stale disk artifact must fail production deployment health"
    $stale = Get-ArtemProductionUpdateDecision `
        -CurrentHead $revisionB `
        -TargetHead $revisionB `
        -RollbackCandidate $revisionA `
        -ArtifactHealthy $false `
        -RuntimeReady $true `
        -ServedArtifactHealthy $false
    Assert-RecoveryEqual -Actual $stale.Action -Expected "target-phase" -Message "Same-SHA stale artifact must select repair"
    Assert-RecoveryEqual -Actual $stale.Reason -Expected "repair-required" -Message "Same-SHA stale artifact must require repair"
    Remove-Item -LiteralPath (Join-Path $dashboard "dashboard-build.json") -Force
    Assert-RecoveryTrue -Condition ($null -eq (Get-ArtemProductionBuildIdentity -DashboardRoot $dashboard)) -Message "Missing artifact marker must fail identity lookup"
    Set-Content -LiteralPath (Join-Path $dashboard "dashboard-build.json") -Value "not-json" -Encoding ASCII
    Assert-RecoveryTrue -Condition ($null -eq (Get-ArtemProductionBuildIdentity -DashboardRoot $dashboard)) -Message "Malformed artifact marker must fail identity lookup"
    @{
        schemaVersion = "dashboard-build.v1"
        revision = $revisionB
        profile = "accepted-v2"
        buildId = "$revisionB`:accepted-v2"
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dashboard "dashboard-build.json") -Encoding ASCII

    # C. Only the complete conjunction can produce up-to-date.
    $script:servedRevision = $revisionB
    Assert-RecoveryTrue `
        -Condition (Test-ArtemProductionDeploymentHealthy -Paths $healthPaths -ExpectedRevision $revisionB) `
        -Message "Matching disk/runtime/served B must be production healthy"
    $healthy = Get-ArtemProductionUpdateDecision `
        -CurrentHead $revisionB `
        -TargetHead $revisionB `
        -RollbackCandidate $revisionA `
        -ArtifactHealthy $true `
        -RuntimeReady $true `
        -ServedArtifactHealthy $true
    Assert-RecoveryEqual -Actual $healthy.Action -Expected "up-to-date" -Message "Only a complete healthy deployment may be up-to-date"
    foreach ($case in @(
        @{ name = "disk artifact"; artifact = $false; runtime = $true; served = $true },
        @{ name = "runtime readiness"; artifact = $true; runtime = $false; served = $true },
        @{ name = "served artifact"; artifact = $true; runtime = $true; served = $false }
    )) {
        $incomplete = Get-ArtemProductionUpdateDecision `
            -CurrentHead $revisionB `
            -TargetHead $revisionB `
            -RollbackCandidate $revisionA `
            -ArtifactHealthy $case.artifact `
            -RuntimeReady $case.runtime `
            -ServedArtifactHealthy $case.served
        Assert-RecoveryEqual -Actual $incomplete.Action -Expected "target-phase" -Message "Incomplete $($case.name) health must not be up-to-date"
    }

    # F. Real disk/served identity comparison: B on disk and A served is
    # unhealthy; matching B is healthy; an incomplete active dashboard is not.
    Assert-ArtemProductionBuildIdentity -DashboardRoot $dashboard -ExpectedRevision $revisionB | Out-Null
    $script:servedRevision = $revisionA
    $servedMismatch = $false
    try {
        Assert-ArtemServedProductionBuildIdentity `
            -Paths ([pscustomobject]@{ ProductionBuildUrl = "http://fixture.invalid/production-build" }) `
            -ExpectedRevision $revisionB | Out-Null
    }
    catch {
        $servedMismatch = $true
    }
    Assert-RecoveryTrue -Condition $servedMismatch -Message "Served A against disk/target B must fail identity assertion"
    Assert-RecoveryTrue `
        -Condition (-not (Test-ArtemProductionDeploymentHealthy -Paths $healthPaths -ExpectedRevision $revisionB)) `
        -Message "Deployment health must reject served A against target B"
    $script:servedRevision = $revisionB
    Assert-RecoveryTrue `
        -Condition (Test-ArtemProductionDeploymentHealthy -Paths $healthPaths -ExpectedRevision $revisionB) `
        -Message "Deployment health must accept matching disk/runtime/served B"
    Remove-Item -LiteralPath (Join-Path $dashboard "index.html") -Force
    Assert-RecoveryTrue `
        -Condition (-not (Test-ArtemProductionDeploymentHealthy -Paths $healthPaths -ExpectedRevision $revisionB)) `
        -Message "Deployment health must reject a marker-only incomplete dashboard"

    # A zero-exit build command is not enough: the real staged-artifact
    # assertion must reject a wrong target marker.
    New-Item -ItemType File -Force -Path (Join-Path $dashboard "index.html") | Out-Null
    $wrongMarkerRejected = $false
    try {
        Assert-ArtemStagedProductionBuild -DashboardRoot $dashboard -ExpectedRevision $revisionA | Out-Null
    }
    catch {
        $wrongMarkerRejected = $true
    }
    Assert-RecoveryTrue -Condition $wrongMarkerRejected -Message "Staged artifact assertion must reject a wrong target marker"

    # D. Pre-promotion failures remain incomplete and preserve the old runtime
    # when it has not yet been stopped.
    $buildFailure = Get-ArtemProductionFailureState -Stage "build" -RuntimeStopped $false
    Assert-RecoveryEqual -Actual $buildFailure.Status -Expected "failed" -Message "Build failure must be terminally failed"
    Assert-RecoveryEqual -Actual $buildFailure.Result -Expected "build_failed" -Message "Build failure result must be explicit"
    Assert-RecoveryTrue -Condition $buildFailure.TransactionRemains -Message "Build failure must retain incomplete transaction state"
    Assert-RecoveryTrue -Condition $buildFailure.RuntimePreserved -Message "Pre-promotion build failure must preserve runtime"
    $markerFailure = Get-ArtemProductionFailureState -Stage "artifact-assertion" -RuntimeStopped $false
    Assert-RecoveryEqual -Actual $markerFailure.Result -Expected "artifact_assertion_failed" -Message "Marker assertion failure must not be success"

    # E. Post-promotion verification failure can restore A, but never deploy B.
    $promotionFailure = Get-ArtemProductionRollbackState `
        -RollbackHead $revisionA `
        -TargetHead $revisionB `
        -ServedRollbackHealthy $false
    Assert-RecoveryEqual -Actual $promotionFailure.Result -Expected "rollback_failed" -Message "Post-promotion verification failure must block B success"
    Assert-RecoveryTrue -Condition $promotionFailure.TransactionRemains -Message "Post-promotion verification failure must retain incomplete state"
    $rollback = Get-ArtemProductionRollbackState `
        -RollbackHead $revisionA `
        -TargetHead $revisionB `
        -ServedRollbackHealthy $true
    Assert-RecoveryEqual -Actual $rollback.Result -Expected "rollback_restored" -Message "Verified rollback must restore A"
    Assert-RecoveryEqual -Actual $rollback.RollbackHead -Expected $revisionA -Message "Rollback target must be A"
    Assert-RecoveryTrue -Condition (-not $rollback.TargetDeployed) -Message "Rollback must never report B deployed"
    Assert-RecoveryTrue -Condition (-not $rollback.TransactionRemains) -Message "Only verified rollback may clear incomplete state"
    $rollbackFailure = Get-ArtemProductionRollbackState `
        -RollbackHead $revisionA `
        -TargetHead $revisionB `
        -RollbackFailed $true
    Assert-RecoveryEqual -Actual $rollbackFailure.Result -Expected "rollback_failed" -Message "Failed rollback must remain explicit"
    Assert-RecoveryTrue -Condition $rollbackFailure.TransactionRemains -Message "Failed rollback must retain incomplete state"

    # G. Recovery decisions are side-effect free with respect to protected and
    # unknown files, and the real generated-artifact promotion helper only moves
    # the dashboard directories it owns. No cleanup primitive is needed to reach
    # any recovery decision.
    Set-Content -LiteralPath $runtimeEnv -Value "PANEL_AGENT_MODE=production" -Encoding ASCII
    Set-Content -LiteralPath $capabilityState -Value "protected" -Encoding ASCII
    Set-Content -LiteralPath $unknownFile -Value "owner data" -Encoding ASCII
    Get-ArtemProductionUpdateDecision -CurrentHead $revisionB -TargetHead $revisionB -RollbackCandidate $revisionA | Out-Null
    Get-ArtemProductionFailureState -Stage "build" | Out-Null
    Get-ArtemProductionRollbackState -RollbackHead $revisionA -TargetHead $revisionB -RollbackFailed $true | Out-Null

    $promotedDashboard = Join-Path $root "promoted-dashboard"
    $stagedDashboard = Join-Path $root "staged-dashboard"
    $promotionRollback = Join-Path $root "promotion-rollback"
    New-Item -ItemType Directory -Force -Path $promotedDashboard, $stagedDashboard | Out-Null
    Set-Content -LiteralPath (Join-Path $promotedDashboard "index.html") -Value "old" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $stagedDashboard "index.html") -Value "new" -Encoding ASCII
    Promote-ArtemProductionBuild `
        -Paths ([pscustomobject]@{
            DashboardDist = $promotedDashboard
            RollbackDashboard = $promotionRollback
        }) `
        -StagedDashboard $stagedDashboard
    Assert-RecoveryTrue -Condition (Test-Path -LiteralPath (Join-Path $promotedDashboard "index.html")) -Message "Promotion must leave the new dashboard active"
    Assert-RecoveryTrue -Condition (Test-Path -LiteralPath (Join-Path $promotionRollback "index.html")) -Message "Promotion must retain the old dashboard for rollback"
    foreach ($protected in @($runtimeEnv, $capabilityState, $unknownFile)) {
        Assert-RecoveryTrue -Condition (Test-Path -LiteralPath $protected) -Message "Recovery decision removed protected/unknown file: $protected"
    }
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated executable production recovery decisions: interrupted checkout, same-SHA repair/healthy conjunction, pre-promotion failures, post-promotion rollback, served identity mismatch, incomplete dashboard rejection, and protected-file preservation."
