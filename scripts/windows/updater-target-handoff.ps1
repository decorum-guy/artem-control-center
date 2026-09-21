$ErrorActionPreference = "Stop"

# This file owns only the updater-to-updater process boundary.  It is not a
# browser command surface: callers supply the repository-derived updater path
# and the already-validated transaction identity.

function Write-ArtemTargetHandoffJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Payload
    )
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($Payload | ConvertTo-Json -Depth 4), [Text.Encoding]::ASCII)
    try {
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
        }
        else {
            [IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-ArtemTargetHandoffMutex {
    param([Parameter(Mandatory)]$Paths)
    $bytes = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Paths.UpdateLock).ToLowerInvariant())
    $hash = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($bytes)).Replace("-", "")
    return New-Object -TypeName System.Threading.Mutex -ArgumentList ([object[]]@($false, "Local\ArtemControlCenterUpdateLock-$hash"))
}

function Invoke-ArtemTargetHandoffLockMutation {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][scriptblock]$Mutation
    )
    $mutex = Get-ArtemTargetHandoffMutex -Paths $Paths
    $entered = $false
    try {
        $entered = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
        if (-not $entered) { throw "Software update handoff lease is busy" }
        & $Mutation
    }
    finally {
        if ($entered) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Write-ArtemTargetHandoffEvidence {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidateSet("launched", "arguments-accepted", "lease-accepted", "transcript-started", "target-bootstrap-accepted")][string]$Stage,
        [Parameter(Mandatory)][ValidateSet("success", "child-start-failed", "parameter-binding-failed", "lease-rejected", "bootstrap-failed")][string]$Result
    )
    $evidencePath = Join-Path $Paths.Logs ("update-handoff-{0}.json" -f $LockRequestId)
    Write-ArtemTargetHandoffJson -Path $evidencePath -Payload @{
        schemaVersion = 1
        requestId = $LockRequestId
        stage = $Stage
        result = $Result
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
}

function Get-ArtemTargetHandoffEvidence {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId
    )
    $evidencePath = Join-Path $Paths.Logs ("update-handoff-{0}.json" -f $LockRequestId)
    $payload = Get-ArtemJsonPayload -Path $evidencePath
    if (
        $null -eq $payload -or
        $payload.schemaVersion -ne 1 -or
        [string]$payload.requestId -ne $LockRequestId -or
        [string]$payload.stage -notin @("launched", "arguments-accepted", "lease-accepted", "transcript-started", "target-bootstrap-accepted") -or
        [string]$payload.result -notin @("success", "child-start-failed", "parameter-binding-failed", "lease-rejected", "bootstrap-failed")
    ) {
        return $null
    }
    return $payload
}

function Complete-ArtemTargetHandoffFailure {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId
    )
    $evidencePath = Join-Path $Paths.Logs ("update-handoff-{0}.json" -f $LockRequestId)
    $existing = Get-ArtemJsonPayload -Path $evidencePath
    if (
        $null -ne $existing -and
        [string]$existing.requestId -eq $LockRequestId -and
        [string]$existing.stage -in @("launched", "arguments-accepted", "lease-accepted", "transcript-started") -and
        [string]$existing.result -eq "success"
    ) {
        Write-ArtemTargetHandoffEvidence `
            -Paths $Paths `
            -LockRequestId $LockRequestId `
            -Stage ([string]$existing.stage) `
            -Result "bootstrap-failed"
    }
}

function Test-ArtemTargetHandoffLease {
    param(
        [object]$Existing,
        [Parameter(Mandatory)][string]$LockRequestId,
        [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Target
    )
    return (
        $null -ne $Existing -and
        $Existing.schemaVersion -eq 1 -and
        [string]$Existing.status -eq "updating" -and
        [string]$Existing.requestId -eq $LockRequestId -and
        [string]$Existing.expectedCurrentHead -eq $Current -and
        [string]$Existing.expectedTargetHead -eq $Target
    )
}

function Test-ArtemTargetHandoffTimestamp {
    param([object]$Value)
    try { $updated = [DateTimeOffset]::Parse([string]$Value).ToUniversalTime() }
    catch { return $false }
    $age = [DateTimeOffset]::UtcNow - $updated
    return $age.TotalSeconds -ge 0 -and $age.TotalMinutes -le 2
}

function Test-ArtemTargetHandoffTransaction {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId,
        [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Target
    )
    $transaction = Get-ArtemJsonPayload -Path $Paths.UpdateTransactionState
    return (
        $null -ne $transaction -and $transaction.schemaVersion -eq 1 -and
        [string]$transaction.status -eq "incomplete" -and [string]$transaction.phase -eq "handoff" -and
        [string]$transaction.requestId -eq $LockRequestId -and [string]$transaction.previousHead -eq $Current -and
        [string]$transaction.targetHead -eq $Target -and
        (Test-ArtemTargetHandoffTimestamp -Value $transaction.updatedAt)
    )
}

function Test-ArtemLegacyTargetHandoffLease {
    param(
        [object]$Existing, [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId, [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Target
    )
    $hasOwner = $null -ne $Existing -and $Existing.PSObject.Properties.Name -contains "ownerPid"
    $hasHandoff = $null -ne $Existing -and $Existing.PSObject.Properties.Name -contains "handoff"
    return (
        (Test-ArtemTargetHandoffLease -Existing $Existing -LockRequestId $LockRequestId -Current $Current -Target $Target) -and
        $hasOwner -and -not $hasHandoff -and -not ($Existing.ownerPid -is [bool]) -and [int]$Existing.ownerPid -gt 0 -and
        (Test-ArtemTargetHandoffTimestamp -Value $Existing.updatedAt) -and
        (Test-ArtemTargetHandoffTransaction -Paths $Paths -LockRequestId $LockRequestId -Current $Current -Target $Target)
    )
}

function Test-ArtemNullHeadLegacyTargetHandoffLease {
    param(
        [object]$Existing, [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$LockRequestId, [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Target
    )
    # The deployed manual parent created its owned lease before preflight, so
    # both revision fields can be absent.  This exception remains bounded by
    # the exact fresh handoff transaction that preflight later published.
    $hasOwner = $null -ne $Existing -and $Existing.PSObject.Properties.Name -contains "ownerPid"
    $hasHandoff = $null -ne $Existing -and $Existing.PSObject.Properties.Name -contains "handoff"
    $currentMissing = $null -eq $Existing.expectedCurrentHead -or [string]::IsNullOrWhiteSpace([string]$Existing.expectedCurrentHead)
    $targetMissing = $null -eq $Existing.expectedTargetHead -or [string]::IsNullOrWhiteSpace([string]$Existing.expectedTargetHead)
    return (
        $null -ne $Existing -and
        $Existing.schemaVersion -eq 1 -and
        [string]$Existing.status -eq "updating" -and
        [string]$Existing.requestId -eq $LockRequestId -and
        $hasOwner -and -not $hasHandoff -and -not ($Existing.ownerPid -is [bool]) -and [int]$Existing.ownerPid -gt 0 -and
        $currentMissing -and $targetMissing -and
        (Test-ArtemTargetHandoffTimestamp -Value $Existing.updatedAt) -and
        (Test-ArtemTargetHandoffTransaction -Paths $Paths -LockRequestId $LockRequestId -Current $Current -Target $Target)
    )
}

function Publish-ArtemTargetHandoffLease {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target
    )
    Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
        $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
        if (-not (Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target) -or [int]$existing.ownerPid -ne $PID) {
            throw "Software update lease ownership was lost before target handoff"
        }
        Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
            schemaVersion = 1
            status = "updating"
            requestId = $LockRequestId
            expectedCurrentHead = $Current
            expectedTargetHead = $Target
            handoff = "target-continuation"
            updatedAt = [DateTime]::UtcNow.ToString("o")
        }
    }
}

function Claim-ArtemTargetHandoffLease {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target
    )
    try {
        $claim = Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
            $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
            $isExplicit = (
                (Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target) -and
                [string]$existing.handoff -eq "target-continuation" -and $null -eq $existing.ownerPid -and
                (Test-ArtemTargetHandoffTimestamp -Value $existing.updatedAt) -and
                (Test-ArtemTargetHandoffTransaction -Paths $Paths -LockRequestId $LockRequestId -Current $Current -Target $Target)
            )
            $isPopulatedLegacy = Test-ArtemLegacyTargetHandoffLease -Existing $existing -Paths $Paths -LockRequestId $LockRequestId -Current $Current -Target $Target
            $isNullHeadLegacy = Test-ArtemNullHeadLegacyTargetHandoffLease -Existing $existing -Paths $Paths -LockRequestId $LockRequestId -Current $Current -Target $Target
            $isLegacy = $isPopulatedLegacy -or $isNullHeadLegacy
            if (-not $isExplicit -and -not $isLegacy) {
                throw "Software update handoff lease does not match the requested revisions"
            }
            $claimResult = [pscustomobject]@{
                Protocol = if ($isLegacy) { "legacy" } else { "explicit" }
                PreviousOwnerPid = if ($isLegacy) { [int]$existing.ownerPid } else { $null }
            }
            Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
                schemaVersion = 1
                status = "updating"
                requestId = $LockRequestId
                expectedCurrentHead = $Current
                expectedTargetHead = $Target
                ownerPid = $PID
                updatedAt = [DateTime]::UtcNow.ToString("o")
            }
            return $claimResult
        }
    }
    catch {
        Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "lease-accepted" -Result "lease-rejected"
        throw
    }
    Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "lease-accepted" -Result "success"
    return $claim
}

function Restore-ArtemLegacyTargetHandoffLease {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [Parameter(Mandatory)][int]$ParentPid
    )
    if ($ParentPid -le 0) { throw "Legacy updater parent identity is invalid" }
    Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
        $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
        if (-not (Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target) -or [int]$existing.ownerPid -ne $PID) {
            throw "Software update child no longer owns the legacy handoff lease"
        }
        Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
            schemaVersion = 1; status = "updating"; requestId = $LockRequestId
            expectedCurrentHead = $Current; expectedTargetHead = $Target; ownerPid = $ParentPid
            updatedAt = [DateTime]::UtcNow.ToString("o")
        }
    }
}

function Reclaim-ArtemTargetHandoffLease {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [int]$ExitedChildPid = 0
    )
    Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
        $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
        if ($null -ne $existing) {
            $exact = Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target
            $ownerless = $exact -and [string]$existing.handoff -eq "target-continuation" -and $null -eq $existing.ownerPid
            $exitedChild = $exact -and $ExitedChildPid -gt 0 -and [int]$existing.ownerPid -eq $ExitedChildPid
            if (-not $ownerless -and -not $exitedChild) {
                throw "Software update handoff recovery lease is not owned by the exited target child"
            }
        }
        Write-ArtemTargetHandoffJson -Path $Paths.UpdateLock -Payload @{
            schemaVersion = 1
            status = "updating"
            requestId = $LockRequestId
            expectedCurrentHead = $Current
            expectedTargetHead = $Target
            ownerPid = $PID
            updatedAt = [DateTime]::UtcNow.ToString("o")
        }
    }
}

function New-ArtemTargetContinuationArguments {
    param(
        [Parameter(Mandatory)][string]$TargetScript,
        [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$LockRequestId
    )
    # Start-Process joins ArgumentList on Windows PowerShell 5.1. The only
    # value that can contain whitespace is the fixed, repository-derived file.
    return @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $TargetScript),
        "-ExpectedCurrentHead", $Current,
        "-ExpectedTargetHead", $Target,
        "-RequestId", $LockRequestId,
        "-Continuation"
    )
}

function Start-ArtemTargetContinuation {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][string]$TargetScript
    )
    Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "launched" -Result "success"
    try {
        return Start-Process -FilePath "powershell.exe" -ArgumentList (New-ArtemTargetContinuationArguments -TargetScript $TargetScript -Current $Current -Target $Target -LockRequestId $LockRequestId) -WorkingDirectory $Paths.RepoRoot -WindowStyle Hidden -PassThru
    }
    catch {
        Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "launched" -Result "child-start-failed"
        throw
    }
}

function Stop-ArtemTargetContinuationForRecovery {
    param(
        [Parameter(Mandatory)]$TargetProcess,
        [int]$TimeoutSeconds = 5
    )
    $TargetProcess.Refresh()
    if ($TargetProcess.HasExited) { return }
    try {
        # Recovery targets the exact Process object returned by Start-Process,
        # never a separately looked-up PID that could have been recycled.
        $TargetProcess.Kill()
    }
    catch {
        $TargetProcess.Refresh()
        if (-not $TargetProcess.HasExited) {
            throw "Target updater continuation could not be stopped for recovery"
        }
        return
    }
    if (-not $TargetProcess.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
        throw "Target updater continuation did not stop within the recovery timeout"
    }
}

function Wait-ArtemTargetContinuationAcceptance {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)]$TargetProcess,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [int]$TimeoutSeconds = 20
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        # A claimed lease is not yet responsibility transfer. The physical
        # #240 failure happened after claim but before this durable marker.
        $evidence = Get-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId
        if (
            $null -ne $evidence -and
            [string]$evidence.stage -eq "target-bootstrap-accepted" -and
            [string]$evidence.result -eq "success"
        ) {
            return $true
        }

        $TargetProcess.Refresh()
        if ($TargetProcess.HasExited) { return $false }

        $lock = Get-ArtemJsonPayload -Path $Paths.UpdateLock
        if (
            $null -ne $lock -and
            (Test-ArtemTargetHandoffLease -Existing $lock -LockRequestId $LockRequestId -Current $Current -Target $Target) -and
            $null -ne $lock.ownerPid -and
            [int]$lock.ownerPid -ne [int]$TargetProcess.Id
        ) {
            return $false
        }
        Start-Sleep -Milliseconds 100
    }
    return $false
}
