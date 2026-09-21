$ErrorActionPreference = "Stop"

$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-update-runtime-reliability-{0}" -f [guid]::NewGuid())
$previousLocalAppData = $env:LOCALAPPDATA
$previousEnvironment = @{}
$stagingNames = @(
    "PANEL_RUNTIME_VENV",
    "PANEL_AGENT_MODE",
    "PANEL_WRITES_ENABLED",
    "PANEL_COFFEE_TIMING_WRITES_ENABLED",
    "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED",
    "PANEL_COFFEE_ACTIONS_ENABLED",
    "PANEL_KIOSK_CONTROLS_ENABLED",
    "PANEL_PRODUCTION_BUILD_OUT_DIR"
)

function Assert-Reliability {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Set-EnvironmentState {
    param([Parameter(Mandatory)][hashtable]$State)
    foreach ($name in $stagingNames) {
        if ($State.ContainsKey($name)) {
            [Environment]::SetEnvironmentVariable($name, [string]$State[$name], "Process")
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
    }
}

function Assert-EnvironmentState {
    param([Parameter(Mandatory)][hashtable]$Expected, [Parameter(Mandatory)][string]$Label)
    foreach ($name in $stagingNames) {
        $actual = [Environment]::GetEnvironmentVariable($name, "Process")
        $present = $null -ne $actual
        $expectedPresent = $Expected.ContainsKey($name)
        Assert-Reliability ($present -eq $expectedPresent) "$Label did not preserve presence for $name"
        if ($expectedPresent) {
            Assert-Reliability ($actual -ceq [string]$Expected[$name]) "$Label did not preserve value for $name"
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $env:LOCALAPPDATA = $root
    foreach ($name in $stagingNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    # Load the actual updater helper definitions, then replace only external
    # process/network seams. The staging function itself remains unmodified.
    . (Join-Path $PSScriptRoot "update-production.ps1") -ContractTest

    $script:stageRoot = Join-Path $root "stage"
    $script:failureDescription = $null
    $script:stagingObserved = $null
    $script:continuationObserved = $null

    function Get-ArtemUpdateStagingPaths {
        param($Paths, $LockRequestId)
        [pscustomobject]@{
            Root = $script:stageRoot
            Source = Join-Path $script:stageRoot "source"
            Build = Join-Path $script:stageRoot "build"
        }
    }
    function Refresh-ArtemUpdateLock { param($Paths, $LockRequestId) }
    function Write-ArtemUpdateTransaction { param($Paths, $Phase, $PreviousHead, $TargetHead, $LockRequestId, $StagingRoot) }
    function Get-ArtemRuntimeVenvPath { param($Paths, $Revision) return (Join-Path $root "target-venv") }
    function Assert-ArtemStagedProductionBuild { param($DashboardRoot, $ExpectedRevision) }
    function Invoke-CheckedCommand {
        param([string]$FilePath, [string[]]$Arguments, [string]$Description)
        if ($Description -eq "target staging worktree") {
            New-Item -ItemType Directory -Force -Path (Join-Path $script:stageRoot "source") | Out-Null
            return
        }
        if ($Description -eq "target production update preflight") {
            $script:stagingObserved = @{
                Mode = $env:PANEL_AGENT_MODE
                Writes = $env:PANEL_WRITES_ENABLED
                BuildOut = $env:PANEL_PRODUCTION_BUILD_OUT_DIR
            }
        }
        if ($Description -eq "accepted V2 production dashboard build") {
            Assert-Reliability ($env:PANEL_PRODUCTION_BUILD_OUT_DIR -like "*production-dist") "Staged build did not receive its owned output directory"
        }
        if ($Description -eq $script:failureDescription) { throw "fixture staging failure" }
    }
    function git.exe {
        param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
        if ($Arguments -contains "remove") {
            Remove-Item -LiteralPath (Join-Path $script:stageRoot "source") -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    function Start-ArtemTargetContinuation {
        param($Paths, $Current, $Target, $LockRequestId, $TargetScript)
        $script:continuationObserved = @{}
        foreach ($name in $stagingNames) {
            $script:continuationObserved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        }
        return [pscustomobject]@{ Id = 1 }
    }

    $paths = [pscustomobject]@{ RuntimeRoot = $root; RepoRoot = $root }
    $previousHead = "a" * 40
    $targetHead = "b" * 40
    $requestId = "0" * 24

    # A. Non-empty owner values are representable by the production Windows
    # PowerShell process environment and survive successful staging exactly.
    $present = @{
        PANEL_RUNTIME_VENV = "owner-runtime-venv"
        PANEL_AGENT_MODE = "production"
        PANEL_WRITES_ENABLED = "true"
        PANEL_COFFEE_TIMING_WRITES_ENABLED = "owner-timing"
        PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "owner-notifications"
        PANEL_COFFEE_ACTIONS_ENABLED = "owner-actions"
        PANEL_KIOSK_CONTROLS_ENABLED = "owner-kiosk"
        PANEL_PRODUCTION_BUILD_OUT_DIR = "owner-build"
    }
    Set-EnvironmentState -State $present
    $script:failureDescription = $null
    Invoke-ArtemTargetStaging -Paths $paths -PreviousHead $previousHead -TargetHead $targetHead -LockRequestId $requestId | Out-Null
    Assert-Reliability ($script:stagingObserved.Mode -eq "read_only" -and $script:stagingObserved.Writes -eq "false") "Staging did not receive the safe read-only environment"
    Assert-EnvironmentState -Expected $present -Label "Successful staging"
    Start-ArtemTargetContinuation -Paths $paths -Current $previousHead -Target $targetHead -LockRequestId $requestId -TargetScript "fixture" | Out-Null
    foreach ($name in $stagingNames) {
        Assert-Reliability ($script:continuationObserved[$name] -ceq [string]$present[$name]) "Continuation inherited staging value for $name"
    }

    # B. Absent variables remain absent after staging; no mode can leak into a
    # target continuation merely because preflight created it.
    $absent = @{}
    Set-EnvironmentState -State $absent
    Invoke-ArtemTargetStaging -Paths $paths -PreviousHead $previousHead -TargetHead $targetHead -LockRequestId $requestId | Out-Null
    Assert-EnvironmentState -Expected $absent -Label "Absent-variable staging"
    Start-ArtemTargetContinuation -Paths $paths -Current $previousHead -Target $targetHead -LockRequestId $requestId -TargetScript "fixture" | Out-Null
    foreach ($name in $stagingNames) {
        Assert-Reliability ($null -eq $script:continuationObserved[$name]) "Continuation received an absent staging variable: $name"
    }

    # C. Every failure path after staging starts still restores the exact state.
    Set-EnvironmentState -State $present
    $script:failureDescription = "target production update preflight"
    $failed = $false
    try {
        Invoke-ArtemTargetStaging -Paths $paths -PreviousHead $previousHead -TargetHead $targetHead -LockRequestId $requestId | Out-Null
    }
    catch { $failed = $true }
    Assert-Reliability $failed "Fixture staging failure was not surfaced"
    Assert-EnvironmentState -Expected $present -Label "Failed staging"

    # Durable mode guard is intentionally file-only. Fresh fixture installs
    # remain valid, while a missing/invalid file entry rejects before shutdown.
    $runtimeEnv = Join-Path $root "runtime.env"
    $modePaths = [pscustomobject]@{ RuntimeEnv = $runtimeEnv }
    Set-Content -LiteralPath $runtimeEnv -Value "PANEL_AGENT_MODE=fixtures" -Encoding ASCII
    Assert-Reliability ((Assert-ArtemDurableRuntimeMode -Paths $modePaths) -eq "fixtures") "Explicit fixture mode must remain valid"
    [Environment]::SetEnvironmentVariable("PANEL_AGENT_MODE", "production", "Process")
    Set-Content -LiteralPath $runtimeEnv -Value "PANEL_WRITES_ENABLED=true" -Encoding ASCII
    $missingRejected = $false
    try { Assert-ArtemDurableRuntimeMode -Paths $modePaths | Out-Null } catch { $missingRejected = $_.Exception.Message -eq "runtime_config_incomplete" }
    Assert-Reliability $missingRejected "Inherited mode must not satisfy durable updater configuration"
    Set-Content -LiteralPath $runtimeEnv -Value "PANEL_AGENT_MODE=unknown" -Encoding ASCII
    $invalidRejected = $false
    try { Assert-ArtemDurableRuntimeMode -Paths $modePaths | Out-Null } catch { $invalidRejected = $_.Exception.Message -eq "runtime_config_incomplete" }
    Assert-Reliability $invalidRejected "Invalid durable mode must use the fixed safe result"

    # The port helper queries all listening connections before filtering. This
    # uses a real Windows TcpListener so an absent listener is not confused
    # with CmdletizationQuery_NotFound_LocalPort from a filtered cmdlet query.
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $testPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    try {
        Assert-Reliability (-not (Test-ArtemPanelPortReleased -Port $testPort)) "An active listener must keep the tested port unavailable"
    }
    finally {
        $listener.Stop()
    }
    $portReleased = $false
    $releaseDeadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $releaseDeadline) {
        if (Test-ArtemPanelPortReleased -Port $testPort) {
            $portReleased = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    Assert-Reliability $portReleased "A closed listener must make the tested port available"

    # A genuine query failure is distinct from an empty successful query and
    # must remain fail-closed.
    function Get-NetTCPConnection { throw "fixture query failure" }
    Assert-Reliability (-not (Test-ArtemPanelPortReleased -Port $testPort)) "A connection query failure must fail closed"

    # C1-C5. Exercise the post-update handoff with fake process/task seams;
    # no Edge, kiosk, or real supervisor is spawned by this contract test.
    $script:events = New-Object System.Collections.Generic.List[string]
    $script:taskAvailable = $true
    $script:taskState = "Running"
    $script:supervisorCount = 1
    $script:panelReady = $true
    $script:kioskVisible = $true
    $script:startFails = $false
    $handoffRequest = "a" * 24
    function Get-ScheduledTask {
        param([string]$TaskName)
        if (-not $script:taskAvailable) { return $null }
        return [pscustomobject]@{ State = $script:taskState }
    }
    function Get-ArtemProductionRuntimeSupervisors {
        $result = @()
        for ($index = 0; $index -lt $script:supervisorCount; $index++) { $result += [pscustomobject]@{ ProcessId = 100 + $index } }
        return $result
    }
    function Test-ArtemPanelReady { param($Paths) return $script:panelReady }
    function Stop-ArtemRuntime {
        param($Paths, $Manual)
        [void]$script:events.Add("stop")
        $script:supervisorCount = 0
        $script:panelReady = $false
        $script:taskState = "Ready"
    }
    function Wait-ArtemRuntimeHandoffStopped {
        param($Paths, $TimeoutSeconds)
        [void]$script:events.Add("absence-confirmed")
        return $script:supervisorCount -eq 0
    }
    function Wait-ArtemInteractiveRuntimeTaskAvailable {
        param($TimeoutSeconds)
        [void]$script:events.Add("task-available")
        return $script:taskAvailable -and $script:taskState -ne "Running"
    }
    function Start-ScheduledTask {
        param([string]$TaskName)
        [void]$script:events.Add("task-start")
        if ($script:startFails) { throw "fixture task start failure" }
        $script:taskState = "Running"
        $script:supervisorCount = 1
        $script:panelReady = $true
    }
    function Test-ArtemKioskVisible { param($Paths) return $script:kioskVisible }
    function Restore-ArtemPostUpdateRuntime {
        param($Paths, $LockRequestId, $TimeoutSeconds)
        [void]$script:events.Add("backend-fallback")
        if ($LockRequestId -ne $handoffRequest) { throw "fallback lost the exact update request id" }
        $script:supervisorCount = 1
        $script:panelReady = $true
        return $true
    }

    # Case 1: a Running task plus healthy updater-owned runtime uses a clean
    # handoff; no second supervisor appears before the old one is absent.
    Assert-Reliability (Invoke-ArtemPostUpdateInteractiveRecovery -Paths $paths -LockRequestId $handoffRequest -TimeoutSeconds 1) "Healthy post-update handoff did not recover kiosk"
    Assert-Reliability (($script:events -join ",") -eq "stop,absence-confirmed,task-available,task-start") "Handoff order must stop, prove absence, then start task"
    Assert-Reliability ($script:supervisorCount -eq 1) "Handoff created competing supervisors"

    # Case 3: unavailable task leaves healthy runtime untouched.
    $script:events.Clear(); $script:taskAvailable = $false; $script:taskState = "Ready"; $script:supervisorCount = 1; $script:panelReady = $true
    Assert-Reliability (-not (Invoke-ArtemPostUpdateInteractiveRecovery -Paths $paths -LockRequestId $handoffRequest -TimeoutSeconds 1)) "Unavailable task must return bounded warning"
    Assert-Reliability ($script:events.Count -eq 0 -and $script:supervisorCount -eq 1) "Unavailable task destroyed a healthy runtime"

    # Case 4: one failed task start creates no retry storm and restores one
    # ready backend before returning its advisory false result.
    $script:events.Clear(); $script:taskAvailable = $true; $script:taskState = "Ready"; $script:supervisorCount = 1; $script:panelReady = $true; $script:kioskVisible = $true; $script:startFails = $true
    Assert-Reliability (-not (Invoke-ArtemPostUpdateInteractiveRecovery -Paths $paths -LockRequestId $handoffRequest -TimeoutSeconds 1)) "Task start failure must remain advisory"
    Assert-Reliability ((@($script:events | Where-Object { $_ -eq "task-start" }).Count -eq 1)) "Task start failure retried the interactive task"
    Assert-Reliability (($script:events -join ",") -eq "stop,absence-confirmed,task-available,task-start,backend-fallback") "Failed task start did not use the bounded backend fallback"
    Assert-Reliability ($script:supervisorCount -eq 1 -and $script:panelReady) "Task start failure left the accepted backend stopped"

    # Case 5: a Scheduled Task can restore the backend but still fail to make
    # the kiosk visible. The advisory timeout must preserve one ready backend.
    $script:events.Clear(); $script:taskAvailable = $true; $script:taskState = "Ready"; $script:supervisorCount = 1; $script:panelReady = $true; $script:kioskVisible = $false; $script:startFails = $false
    Assert-Reliability (-not (Invoke-ArtemPostUpdateInteractiveRecovery -Paths $paths -LockRequestId $handoffRequest -TimeoutSeconds 1)) "Missing kiosk must remain advisory"
    Assert-Reliability ((@($script:events | Where-Object { $_ -eq "backend-fallback" }).Count -eq 1)) "Missing kiosk did not pass through backend preservation"
    Assert-Reliability ($script:supervisorCount -eq 1 -and $script:panelReady) "Missing kiosk left the accepted backend stopped"

    # Running task helper itself never calls Stop-ScheduledTask or restarts it.
    $script:events.Clear(); $script:startFails = $false; $script:taskState = "Running"; $script:kioskVisible = $true
    Assert-Reliability (-not (Start-ArtemInteractiveRuntimeTask -Paths $paths)) "Running task must not be restarted"
    Assert-Reliability ($script:events.Count -eq 0) "Running task recovery issued a competing task start"
}
finally {
    foreach ($name in $stagingNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated staging environment restoration, durable runtime-mode guard, and bounded one-supervisor post-update handoff with backend preservation."
