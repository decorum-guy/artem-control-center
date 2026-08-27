$ErrorActionPreference = "Stop"

# Pure, bounded recovery decisions shared by the production updater and its
# Windows fixture tests. Side effects (Git, npm, runtime, and kiosk operations)
# remain in update-production.ps1; this file owns only the accepted state
# transitions and their typed outcomes.
function Get-ArtemProductionUpdateDecision {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$CurrentHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetHead,
        [object]$Transaction,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$RollbackCandidate,
        [bool]$ArtifactHealthy = $false,
        [bool]$RuntimeReady = $false,
        [bool]$ServedArtifactHealthy = $false,
        [switch]$Continuation
    )

    if ($Continuation) {
        return [pscustomobject]@{
            Action = "target-phase"
            CurrentHead = $CurrentHead.ToLowerInvariant()
            TargetHead = $TargetHead.ToLowerInvariant()
            RollbackHead = $RollbackCandidate.ToLowerInvariant()
            Reason = "explicit-continuation"
            TransactionPhase = if ($null -ne $Transaction) { [string]$Transaction.phase } else { $null }
        }
    }

    if ($null -ne $Transaction -and [string]$Transaction.phase -eq "rollback") {
        return [pscustomobject]@{
            Action = "blocked"
            CurrentHead = $CurrentHead.ToLowerInvariant()
            TargetHead = $TargetHead.ToLowerInvariant()
            RollbackHead = [string]$Transaction.previousHead
            Reason = "rollback-recovery-required"
            TransactionPhase = [string]$Transaction.phase
        }
    }

    if ($null -ne $Transaction -and [string]$Transaction.targetHead -ne $TargetHead) {
        return [pscustomobject]@{
            Action = "blocked"
            CurrentHead = $CurrentHead.ToLowerInvariant()
            TargetHead = $TargetHead.ToLowerInvariant()
            RollbackHead = [string]$Transaction.previousHead
            Reason = "transaction-target-mismatch"
            TransactionPhase = [string]$Transaction.phase
        }
    }

    if ($CurrentHead -eq $TargetHead) {
        if ($null -eq $Transaction -and $ArtifactHealthy -and $RuntimeReady -and $ServedArtifactHealthy) {
            return [pscustomobject]@{
                Action = "up-to-date"
                CurrentHead = $CurrentHead.ToLowerInvariant()
                TargetHead = $TargetHead.ToLowerInvariant()
                RollbackHead = $RollbackCandidate.ToLowerInvariant()
                Reason = "healthy-deployment"
                TransactionPhase = $null
            }
        }

        return [pscustomobject]@{
            Action = "target-phase"
            CurrentHead = $CurrentHead.ToLowerInvariant()
            TargetHead = $TargetHead.ToLowerInvariant()
            RollbackHead = if ($null -ne $Transaction) { [string]$Transaction.previousHead } else { $RollbackCandidate.ToLowerInvariant() }
            Reason = if ($null -ne $Transaction) { "incomplete-transaction" } else { "repair-required" }
            TransactionPhase = if ($null -ne $Transaction) { [string]$Transaction.phase } else { $null }
        }
    }

    return [pscustomobject]@{
        Action = "bootstrap"
        CurrentHead = $CurrentHead.ToLowerInvariant()
        TargetHead = $TargetHead.ToLowerInvariant()
        RollbackHead = $CurrentHead.ToLowerInvariant()
        Reason = "revision-change"
        TransactionPhase = if ($null -ne $Transaction) { [string]$Transaction.phase } else { $null }
    }
}

function Get-ArtemProductionFailureState {
    param(
        [Parameter(Mandatory)][ValidateSet("build", "artifact-assertion", "restart", "served-verification")][string]$Stage,
        [bool]$RuntimeStopped = $false
    )
    $result = switch ($Stage) {
        "artifact-assertion" { "artifact_assertion_failed" }
        "restart" { "restart_failed" }
        "served-verification" { "served_artifact_mismatch" }
        default { "build_failed" }
    }
    return [pscustomobject]@{
        Status = "failed"
        Result = $result
        TransactionRemains = $true
        RuntimePreserved = -not $RuntimeStopped
    }
}

function Get-ArtemProductionRollbackState {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$RollbackHead,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetHead,
        [bool]$ServedRollbackHealthy = $false,
        [bool]$RollbackFailed = $false
    )
    if ($RollbackFailed -or -not $ServedRollbackHealthy) {
        return [pscustomobject]@{
            Status = "failed"
            Result = "rollback_failed"
            RollbackHead = $RollbackHead.ToLowerInvariant()
            TargetHead = $TargetHead.ToLowerInvariant()
            TargetDeployed = $false
            TransactionRemains = $true
        }
    }
    return [pscustomobject]@{
        Status = "failed"
        Result = "rollback_restored"
        RollbackHead = $RollbackHead.ToLowerInvariant()
        TargetHead = $TargetHead.ToLowerInvariant()
        TargetDeployed = $false
        TransactionRemains = $false
    }
}
