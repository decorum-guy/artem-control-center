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
        RuntimeScript = Join-Path $repoRoot "scripts\production-runtime.mjs"
        StartScript = Join-Path $repoRoot "scripts\windows\start-production.ps1"
        OpenKioskScript = Join-Path $repoRoot "scripts\windows\open-kiosk.ps1"
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

function Get-ArtemRuntimeState {
    param([Parameter(Mandatory)]$Paths)
    if (-not (Test-Path -LiteralPath $Paths.State)) { return $null }
    try {
        return Get-Content -LiteralPath $Paths.State -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
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

function Get-ArtemEdgeExecutable {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "Microsoft Edge executable was not found"
}

function Test-ArtemKioskRunning {
    param([Parameter(Mandatory)]$Paths)
    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"
        return $null -ne ($processes | Where-Object {
            $_.CommandLine -like "*--kiosk*" -and
            $_.CommandLine -like "*$($Paths.EdgeProfile)*"
        } | Select-Object -First 1)
    }
    catch {
        return $false
    }
}

function Stop-ArtemKiosk {
    param([Parameter(Mandatory)]$Paths)
    try {
        Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
            Where-Object {
                $_.CommandLine -like "*--kiosk*" -and
                $_.CommandLine -like "*$($Paths.EdgeProfile)*"
            } |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
    }
    catch {
        Write-Warning "Unable to close the panel-owned Edge kiosk: $($_.Exception.Message)"
    }
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
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
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
    $payload | ConvertTo-Json | Set-Content -LiteralPath $Paths.ManualStop -Encoding UTF8
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
