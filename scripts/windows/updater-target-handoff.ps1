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
        [string]$existing.stage -in @("launched", "arguments-accepted")
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
        Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
            $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
            if (
                -not (Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target) -or
                [string]$existing.handoff -ne "target-continuation" -or
                $null -ne $existing.ownerPid
            ) {
                throw "Software update handoff lease does not match the requested revisions"
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
    catch {
        Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "lease-accepted" -Result "lease-rejected"
        throw
    }
    Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "lease-accepted" -Result "success"
}

function Reclaim-ArtemTargetHandoffLease {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target
    )
    Invoke-ArtemTargetHandoffLockMutation -Paths $Paths -Mutation {
        $existing = Get-ArtemJsonPayload -Path $Paths.UpdateLock
        if ($null -ne $existing -and -not (Test-ArtemTargetHandoffLease -Existing $existing -LockRequestId $LockRequestId -Current $Current -Target $Target)) {
            throw "Software update handoff recovery lease does not match the transaction"
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
        return Start-Process -FilePath "powershell.exe" -ArgumentList (New-ArtemTargetContinuationArguments -TargetScript $TargetScript -Current $Current -Target $Target -LockRequestId $LockRequestId) -WorkingDirectory $Paths.RepoRoot -WindowStyle Hidden -Wait -PassThru
    }
    catch {
        Write-ArtemTargetHandoffEvidence -Paths $Paths -LockRequestId $LockRequestId -Stage "launched" -Result "child-start-failed"
        throw
    }
}
