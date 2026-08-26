$ErrorActionPreference = "Stop"

function Update-ArtemProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Get-ArtemRuntimePaths {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "ArtemControlCenter"
    [pscustomobject]@{
        RepoRoot = $repoRoot
        RuntimeRoot = $runtimeRoot
        Logs = Join-Path $runtimeRoot "logs"
        RuntimeEnv = Join-Path $runtimeRoot "runtime.env"
        State = Join-Path $runtimeRoot "runtime-state.json"
        Command = Join-Path $runtimeRoot "runtime-command.json"
        ManualStop = Join-Path $runtimeRoot "manual-stop.json"
        EdgeProfile = Join-Path $runtimeRoot "edge-profile"
        LastKnownGood = Join-Path $runtimeRoot "last-known-good.txt"
        RollbackHead = Join-Path $runtimeRoot "rollback-head.txt"
        CapabilityApplyState = Join-Path $runtimeRoot "capability-apply-state.json"
        UpdateLock = Join-Path $runtimeRoot "update-lock.json"
        UpdateState = Join-Path $runtimeRoot "update-state.json"
        RuntimeScript = Join-Path $repoRoot "scripts\production-runtime.mjs"
        StartScript = Join-Path $repoRoot "scripts\windows\start-production.ps1"
        OpenKioskScript = Join-Path $repoRoot "scripts\windows\open-kiosk.ps1"
        KioskWatchScript = Join-Path $repoRoot "scripts\windows\watch-kiosk.ps1"
        StopScript = Join-Path $repoRoot "scripts\windows\stop-production.ps1"
        UpdateScript = Join-Path $repoRoot "scripts\windows\update-production.ps1"
        DashboardIndex = Join-Path $repoRoot "apps\dashboard\dist\index.html"
        Python = Join-Path $repoRoot ".venv\Scripts\python.exe"
        PanelUrl = "http://127.0.0.1:8787/overview"
        ReadyUrl = "http://127.0.0.1:8787/health/ready"
    }
}

function Initialize-ArtemRuntimeDirectories {
    param([Parameter(Mandatory)]$Paths)
    New-Item -ItemType Directory -Force -Path $Paths.RuntimeRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.Logs | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.EdgeProfile | Out-Null
}

function Get-ArtemJsonPayload {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-ArtemRuntimeState {
    param([Parameter(Mandatory)]$Paths)
    return Get-ArtemJsonPayload -Path $Paths.State
}

function Test-ArtemRuntimeProcess {
    param([Parameter(Mandatory)]$Paths)
    $state = Get-ArtemRuntimeState -Paths $Paths
    if ($null -eq $state -or $null -eq $state.supervisorPid) { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.supervisorPid)"
        return (
            $null -ne $process -and
            $process.Name -ieq "node.exe" -and
            $process.CommandLine -like "*production-runtime.mjs*"
        )
    }
    catch {
        return $false
    }
}

function Test-ArtemPanelReady {
    param([Parameter(Mandatory)]$Paths)
    try {
        $response = Invoke-WebRequest `
            -Uri $Paths.ReadyUrl `
            -UseBasicParsing `
            -TimeoutSec 3
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Wait-ArtemPanelReady {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ArtemPanelReady -Paths $Paths) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-ArtemStateRecent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$ActiveStatuses,
        [Parameter(Mandatory)][int]$MaxAgeMinutes
    )
    $payload = Get-ArtemJsonPayload -Path $Path
    if ($null -eq $payload -or $payload.schemaVersion -ne 1) { return $false }
    if ([string]$payload.status -notin $ActiveStatuses) { return $false }
    try {
        $updated = [DateTimeOffset]::Parse([string]$payload.updatedAt).ToUniversalTime()
        $age = [DateTimeOffset]::UtcNow - $updated
        return $age.TotalSeconds -ge 0 -and $age.TotalMinutes -le $MaxAgeMinutes
    }
    catch {
        return $false
    }
}

function Test-ArtemCapabilityApplyActive {
    param([Parameter(Mandatory)]$Paths)
    return Test-ArtemStateRecent `
        -Path $Paths.CapabilityApplyState `
        -ActiveStatuses @("queued", "building", "restarting") `
        -MaxAgeMinutes 15
}

function Test-ArtemUpdaterOwnerProcess {
    param(
        [Parameter(Mandatory)][int]$OwnerPid,
        [Parameter(Mandatory)][string]$RequestId
    )
    if ($OwnerPid -le 0 -or $RequestId -notmatch '^[0-9a-f]{24}$') { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction SilentlyContinue
        $hasRequestArgument = $null -ne $process -and $process.CommandLine -like "*-RequestId*"
        return (
            $null -ne $process -and
            $process.Name -in @("powershell.exe", "pwsh.exe") -and
            $null -ne $process.CommandLine -and
            $process.CommandLine -like "*update-production.ps1*" -and
            (-not $hasRequestArgument -or $process.CommandLine -like "*$RequestId*")
        )
    }
    catch {
        return $false
    }
}

function Get-ArtemSoftwareUpdateLock {
    param([Parameter(Mandatory)]$Paths)
    $payload = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if ($null -eq $payload -or $payload.schemaVersion -ne 1 -or $payload.status -ne "updating") {
        return $null
    }
    $requestId = [string]$payload.requestId
    if ($requestId -notmatch '^[0-9a-f]{24}$') { return $null }

    try {
        $updated = [DateTimeOffset]::Parse([string]$payload.updatedAt).ToUniversalTime()
    }
    catch {
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }

    if ($null -ne $payload.ownerPid) {
        try { $ownerPid = [int]$payload.ownerPid }
        catch {
            Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
            return $null
        }
        if (Test-ArtemUpdaterOwnerProcess -OwnerPid $ownerPid -RequestId $requestId) {
            return $payload
        }
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }

    # Before the detached updater claims the lease there is deliberately no PID.
    # Keep that handoff window short. A future timestamp is never allowed to turn
    # this pre-owner lease into an immortal maintenance block.
    $age = [DateTimeOffset]::UtcNow - $updated
    if ($age.TotalSeconds -lt 0 -or $age.TotalMinutes -gt 2) {
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $payload
}

function Test-ArtemSoftwareUpdateActive {
    param([Parameter(Mandatory)]$Paths)
    return $null -ne (Get-ArtemSoftwareUpdateLock -Paths $Paths)
}

function Get-ArtemEdgeExecutable {
    $candidates = @()
    foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($root) {
            $candidates += Join-Path $root "Microsoft\Edge\Application\msedge.exe"
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "Microsoft Edge executable was not found"
}

function Get-ArtemEdgeProcessSnapshot {
    try {
        return @(
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
                Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate
        )
    }
    catch {
        return @()
    }
}

# Only an Edge process whose own command line carries the exact dedicated
# --user-data-dir value can seed panel ownership. Descendants inherit ownership
# through the live process tree; unrelated/personal Edge roots never do.
function Test-ArtemEdgeProfileRoot {
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$Paths
    )
    if ($null -eq $Process.CommandLine) { return $false }
    $profile = "$($Paths.EdgeProfile)"
    if ([string]::IsNullOrWhiteSpace($profile)) { return $false }
    $escapedProfile = [regex]::Escape($profile)
    $pattern = '(?i)(?:^|\s|")--user-data-dir=(?:"?' + $escapedProfile + '"?)(?=\s|$|")'
    return [regex]::IsMatch([string]$Process.CommandLine, $pattern)
}

function Get-ArtemProcessCreationTimeUtc {
    param([Parameter(Mandatory)]$Process)
    if ($null -eq $Process.CreationDate) { return $null }
    try {
        if ($Process.CreationDate -is [DateTimeOffset]) {
            return $Process.CreationDate.ToUniversalTime()
        }
        if ($Process.CreationDate -is [DateTime]) {
            return [DateTimeOffset]::new($Process.CreationDate.ToUniversalTime())
        }
        return [DateTimeOffset]::Parse([string]$Process.CreationDate).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Test-ArtemEdgeChildOfCurrentParent {
    param(
        [Parameter(Mandatory)]$Parent,
        [Parameter(Mandatory)]$Child
    )
    if ([int]$Child.ParentProcessId -ne [int]$Parent.ProcessId) { return $false }

    # ParentProcessId alone can be misleading after PID reuse. When both CIM
    # creation times are available, reject a child that predates the supposed
    # current parent process.
    $parentCreated = Get-ArtemProcessCreationTimeUtc -Process $Parent
    $childCreated = Get-ArtemProcessCreationTimeUtc -Process $Child
    if ($null -ne $parentCreated -and $null -ne $childCreated -and $childCreated -lt $parentCreated) {
        return $false
    }
    return $true
}

function Get-ArtemOwnedEdgeProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes
    )

    if (-not $PSBoundParameters.ContainsKey('Processes')) {
        $Processes = Get-ArtemEdgeProcessSnapshot
    }
    $current = @($Processes | Where-Object { $null -ne $_ -and $null -ne $_.ProcessId })
    if ($current.Count -eq 0) { return @() }

    $owned = @{}
    $depth = @{}
    $queue = New-Object System.Collections.Queue

    foreach ($candidate in $current) {
        if (-not (Test-ArtemEdgeProfileRoot -Process $candidate -Paths $Paths)) { continue }
        $key = [string][int]$candidate.ProcessId
        if ($owned.ContainsKey($key)) { continue }
        $owned[$key] = $candidate
        $depth[$key] = 0
        $queue.Enqueue($candidate)
    }

    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        $parentKey = [string][int]$parent.ProcessId
        foreach ($candidate in $current) {
            $childKey = [string][int]$candidate.ProcessId
            if ($owned.ContainsKey($childKey)) { continue }
            if (-not (Test-ArtemEdgeChildOfCurrentParent -Parent $parent -Child $candidate)) { continue }
            $owned[$childKey] = $candidate
            $depth[$childKey] = [int]$depth[$parentKey] + 1
            $queue.Enqueue($candidate)
        }
    }

    $result = @()
    foreach ($key in $owned.Keys) {
        $process = $owned[$key]
        $result += [pscustomobject]@{
            ProcessId = [int]$process.ProcessId
            ParentProcessId = [int]$process.ParentProcessId
            CommandLine = $process.CommandLine
            CreationDate = $process.CreationDate
            OwnershipDepth = [int]$depth[$key]
        }
    }
    return @($result | Sort-Object OwnershipDepth, ProcessId)
}

# Broad panel-owned Edge process tree. The exact profile-bearing process is only
# the root seed; cleanup/shutdown includes every current descendant in that tree.
function Get-ArtemKioskProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes
    )
    if ($PSBoundParameters.ContainsKey('Processes')) {
        return @(Get-ArtemOwnedEdgeProcesses -Paths $Paths -Processes $Processes)
    }
    return @(Get-ArtemOwnedEdgeProcesses -Paths $Paths)
}

# Legacy diagnostic only. Real Samsung Edge kiosk windows report HWND 0 for every
# msedge process, so application heartbeat below is the visibility authority.
function Get-ArtemVisibleKioskProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes,
        [scriptblock]$WindowHandleResolver
    )

    $owned = if ($PSBoundParameters.ContainsKey('Processes')) {
        @(Get-ArtemKioskProcesses -Paths $Paths -Processes $Processes)
    }
    else {
        @(Get-ArtemKioskProcesses -Paths $Paths)
    }
    if ($null -eq $WindowHandleResolver) {
        $WindowHandleResolver = {
            param($ProcessId)
            (Get-Process -Id $ProcessId -ErrorAction Stop).MainWindowHandle
        }
    }

    $visible = @()
    foreach ($process in $owned) {
        try {
            $handle = & $WindowHandleResolver ([int]$process.ProcessId)
            if ($null -eq $handle) { continue }
            $handleValue = if ($handle -is [IntPtr]) { $handle.ToInt64() } else { [int64]$handle }
            if ($handleValue -ne 0) {
                $visible += $process
            }
        }
        catch {
            continue
        }
    }
    return @($visible)
}

function Test-ArtemKioskRunning {
    param([Parameter(Mandatory)]$Paths)
    return (Get-ArtemKioskProcesses -Paths $Paths).Count -gt 0
}

function Test-ArtemKioskVisible {
    param([Parameter(Mandatory)]$Paths)
    return (Get-ArtemVisibleKioskProcesses -Paths $Paths).Count -gt 0
}

function Stop-ArtemKiosk {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes,
        [scriptblock]$ProcessStopper
    )
    try {
        $owned = if ($PSBoundParameters.ContainsKey('Processes')) {
            @(Get-ArtemKioskProcesses -Paths $Paths -Processes $Processes)
        }
        else {
            @(Get-ArtemKioskProcesses -Paths $Paths)
        }
        if ($null -eq $ProcessStopper) {
            $ProcessStopper = {
                param($ProcessId)
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            }
        }

        # Stop deepest descendants first so killing the profile root cannot orphan
        # a still-running kiosk child before it has been included in cleanup.
        $ordered = @(
            $owned | Sort-Object -Property `
                @{ Expression = { [int]$_.OwnershipDepth }; Descending = $true }, `
                @{ Expression = { [int]$_.ProcessId }; Descending = $true }
        )
        foreach ($process in $ordered) {
            & $ProcessStopper ([int]$process.ProcessId)
        }
    }
    catch {
        Write-Warning "Unable to close the panel-owned Edge kiosk: $($_.Exception.Message)"
    }
}

function Start-ArtemKioskWatcher {
    param([Parameter(Mandatory)]$Paths)
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-WindowStyle", "Hidden",
            "-ExecutionPolicy", "Bypass",
            "-File", $Paths.KioskWatchScript
        ) `
        -WindowStyle Hidden | Out-Null
}

# Legacy fallback. kiosk-presence.ps1 is sourced at the end of this file and
# replaces both visibility functions with application-heartbeat authority.
function Ensure-ArtemKioskVisible {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 20
    )

    if (Test-ArtemKioskVisible -Paths $Paths) {
        Start-ArtemKioskWatcher -Paths $Paths
        return
    }

    if (Test-ArtemKioskRunning -Paths $Paths) {
        $cleanupDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $cleanupDeadline -and (Test-ArtemKioskRunning -Paths $Paths)) {
            Stop-ArtemKiosk -Paths $Paths
            Start-Sleep -Milliseconds 200
        }
        if (Test-ArtemKioskRunning -Paths $Paths) {
            throw "Panel Edge background processes did not close"
        }
    }

    Remove-Item `
        -LiteralPath (Join-Path $Paths.RuntimeRoot "kiosk-close-request.json") `
        -Force `
        -ErrorAction SilentlyContinue

    $edge = Get-ArtemEdgeExecutable
    $edgeArguments = @(
        "--kiosk",
        $Paths.PanelUrl,
        "--edge-kiosk-type=fullscreen",
        "--user-data-dir=$($Paths.EdgeProfile)",
        "--no-first-run",
        "--disable-session-crashed-bubble",
        "--disable-features=msEdgeSidebarV2"
    )
    Start-Process `
        -FilePath $edge `
        -ArgumentList $edgeArguments `
        -WindowStyle Maximized | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ArtemKioskVisible -Paths $Paths) {
            Start-ArtemKioskWatcher -Paths $Paths
            return
        }
        Start-Sleep -Milliseconds 250
    }

    Stop-ArtemKiosk -Paths $Paths
    throw "Control Center kiosk window did not become visible"
}

function Write-ArtemRuntimeCommand {
    param(
        [Parameter(Mandatory)]$Paths,
        [ValidateSet("hide", "shutdown")]
        [string]$Action,
        [bool]$Manual = $true
    )
    Initialize-ArtemRuntimeDirectories -Paths $Paths
    $payload = [ordered]@{
        schemaVersion = 1
        action = $Action
        manual = $Manual
        requestedAt = [DateTime]::UtcNow.ToString("o")
        requestedBy = "windows-helper"
    }
    $temporary = "$($Paths.Command).tmp"
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding ASCII
    Move-Item -LiteralPath $temporary -Destination $Paths.Command -Force
}

function Write-ArtemManualStopMarker {
    param([Parameter(Mandatory)]$Paths)
    Initialize-ArtemRuntimeDirectories -Paths $Paths
    $payload = [ordered]@{
        schemaVersion = 1
        reason = "manual_shutdown"
        createdAt = [DateTime]::UtcNow.ToString("o")
    }
    $payload | ConvertTo-Json | Set-Content -LiteralPath $Paths.ManualStop -Encoding ASCII
}

function Stop-ArtemRuntime {
    param(
        [Parameter(Mandatory)]$Paths,
        [bool]$Manual = $true,
        [int]$TimeoutSeconds = 20
    )
    $state = Get-ArtemRuntimeState -Paths $Paths
    $running = Test-ArtemRuntimeProcess -Paths $Paths

    if ($Manual) { Write-ArtemManualStopMarker -Paths $Paths }
    Stop-ArtemKiosk -Paths $Paths

    if (-not $running) {
        Remove-Item -LiteralPath $Paths.Command -Force -ErrorAction SilentlyContinue
        return
    }

    Write-ArtemRuntimeCommand -Paths $Paths -Action "shutdown" -Manual $Manual
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ArtemRuntimeProcess -Paths $Paths)) { return }
        Start-Sleep -Milliseconds 300
    }

    if ($null -ne $state.supervisorPid) {
        & taskkill.exe /PID $state.supervisorPid /T /F | Out-Null
    }
    if (Test-ArtemRuntimeProcess -Paths $Paths) {
        throw "Production runtime did not stop"
    }
}

function Assert-ArtemProductionPrerequisites {
    param([Parameter(Mandatory)]$Paths)
    Update-ArtemProcessPath
    if (-not (Test-Path -LiteralPath $Paths.RuntimeScript)) {
        throw "Production runtime script is missing: $($Paths.RuntimeScript)"
    }
    if (-not (Test-Path -LiteralPath $Paths.Python)) {
        throw "Python environment is missing. Run npm run setup."
    }
    if (-not (Test-Path -LiteralPath $Paths.DashboardIndex)) {
        throw "Dashboard build is missing. Run npm run build."
    }
    $null = Get-Command node.exe -ErrorAction Stop
}

$kioskPresenceScript = Join-Path $PSScriptRoot "kiosk-presence.ps1"
if (Test-Path -LiteralPath $kioskPresenceScript) {
    . $kioskPresenceScript
}
