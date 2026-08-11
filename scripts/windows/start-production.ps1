param(
    [switch]$AutoStart,
    [switch]$NoKiosk,
    [switch]$Wait
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Start-ArtemConnectivityIfConfigured {
    $common = Join-Path $PSScriptRoot "connectivity-common.ps1"
    if (-not (Test-Path -LiteralPath $common)) { return }

    try {
        . $common
        $connectivity = Get-ArtemConnectivityPaths
        $config = Get-ArtemConnectivityConfig -Paths $connectivity
        if ($null -eq $config) { return }
        if (Test-Path -LiteralPath $connectivity.StopMarker) {
            Write-Host "Private connectivity remains stopped by explicit manual request."
            return
        }

        $task = Get-ScheduledTask -TaskName $connectivity.TaskName -ErrorAction SilentlyContinue
        if ($null -eq $task) {
            Write-Warning "Private connectivity is configured but its scheduled task is missing."
            return
        }
        if (-not (Test-ArtemConnectivitySupervisor -Paths $connectivity)) {
            Start-ScheduledTask -TaskName $connectivity.TaskName
            Write-Host "Private connectivity recovery task started."
        }
    }
    catch {
        Write-Warning "Unable to ensure private connectivity: $($_.Exception.Message)"
    }
}

function Sync-ArtemDesktopHelpers {
    $syncScript = Join-Path $PSScriptRoot "sync-desktop-helpers.ps1"
    if (-not (Test-Path -LiteralPath $syncScript)) { return }
    try {
        & $syncScript | Out-Null
    }
    catch {
        Write-Warning "Unable to synchronize desktop helpers: $($_.Exception.Message)"
    }
}

$paths = Get-ArtemRuntimePaths
$taskName = "Artem Control Center Runtime"
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath
Sync-ArtemDesktopHelpers

if ($AutoStart -and (Test-Path -LiteralPath $paths.ManualStop)) {
    Write-Host "Artem Control Center remains stopped by manual request."
    exit 0
}

if (-not $AutoStart) {
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
}

Assert-ArtemProductionPrerequisites -Paths $paths

if (Test-ArtemRuntimeProcess -Paths $paths) {
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 20)) {
        throw "Production runtime process exists but is not ready"
    }
    Start-ArtemConnectivityIfConfigured
    if (-not $NoKiosk) {
        & $paths.OpenKioskScript -AssumeRuntimeReady
    }
    Write-Host "Artem Control Center is already running."
    exit 0
}

if (-not $AutoStart) {
    $scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($scheduledTask) {
        if ($scheduledTask.State -eq "Running") {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
        Remove-Item -LiteralPath $paths.State -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $paths.Command -Force -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $taskName
        if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
            throw "Scheduled production runtime did not become ready within 60 seconds"
        }
        Start-ArtemConnectivityIfConfigured
        if (-not $NoKiosk) {
            & $paths.OpenKioskScript -AssumeRuntimeReady
        }
        Write-Host "Artem Control Center production runtime started through Task Scheduler."
        Write-Host "URL: $($paths.PanelUrl)"
        exit 0
    }
}

Remove-Item -LiteralPath $paths.State -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.Command -Force -ErrorAction SilentlyContinue

$node = (Get-Command node.exe -ErrorAction Stop).Source
$argumentLine = "`"$($paths.RuntimeScript)`""
$runtimeProcess = Start-Process `
    -FilePath $node `
    -ArgumentList $argumentLine `
    -WorkingDirectory $paths.RepoRoot `
    -WindowStyle Hidden `
    -PassThru

if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
    if (-not $runtimeProcess.HasExited) {
        & taskkill.exe /PID $runtimeProcess.Id /T /F | Out-Null
    }
    throw "Production runtime did not become ready within 60 seconds"
}

Start-ArtemConnectivityIfConfigured
if (-not $NoKiosk) {
    & $paths.OpenKioskScript -AssumeRuntimeReady
}

Write-Host "Artem Control Center production runtime started."
Write-Host "PID: $($runtimeProcess.Id)"
Write-Host "URL: $($paths.PanelUrl)"

if ($AutoStart -or $Wait) {
    $runtimeProcess.WaitForExit()
    exit $runtimeProcess.ExitCode
}
