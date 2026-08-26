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
        return (
            $null -ne $process -and
            $process.Name -in @("powershell.exe", "pwsh.exe") -and
            $null -ne $process.CommandLine -and
            $process.CommandLine -like "*update-production.ps1*" -and
            $process.CommandLine -like "*$RequestId*"
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

# Broad panel-owned Edge process group. This is deliberately profile-scoped and
# is the cleanup/shutdown boundary, including background processes with no window.
function Get-ArtemKioskProcesses {
    param([Parameter(Mandatory)]$Paths)
    try {
        return @(
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
                Where-Object {
                    $null -ne $_.CommandLine -and
                    $_.CommandLine -like "*$($Paths.EdgeProfile)*"
                }
        )
    }
    catch {
        return @()
    }
}

# Visible kiosk authority. A process is eligible only after it has crossed the
# dedicated Edge-profile boundary, then it must own an actual top-level window.
function Get-ArtemVisibleKioskProcesses {
    param([Parameter(Mandatory)]$Paths)
    $visible = @()
    foreach ($owned in @(Get-ArtemKioskProcesses -Paths $Paths)) {
        try {
            $process = Get-Process -Id $owned.ProcessId -ErrorAction Stop
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                $visible += $owned
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
    param([Parameter(Mandatory)]$Paths)
    try {
        Get-ArtemKioskProcesses -Paths $Paths |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
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

function Ensure-ArtemKioskVisible {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 20
    )

    if (Test-ArtemKioskVisible -Paths $Paths) {
        Start-ArtemKioskWatcher -Paths $Paths
        return
    }

    # Edge can retain background profile processes after its visible kiosk dies.
    # Clear only the dedicated panel profile before launching one fresh window.
    if (Test-ArtemKioskRunning -Paths $Paths) {
        Stop-ArtemKiosk -Paths $Paths
        $cleanupDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $cleanupDeadline -and (Test-ArtemKioskRunning -Paths $Paths)) {
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
    Start-Process -FilePath $edge -ArgumentList $edgeArguments | Out-Null

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
