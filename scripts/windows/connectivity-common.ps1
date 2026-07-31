$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Get-ArtemConnectivityPaths {
    $runtime = Get-ArtemRuntimePaths
    [pscustomobject]@{
        Runtime = $runtime
        Config = Join-Path $runtime.RuntimeRoot "connectivity.json"
        State = Join-Path $runtime.RuntimeRoot "connectivity-state.json"
        StopMarker = Join-Path $runtime.RuntimeRoot "connectivity-stop.json"
        StartScript = Join-Path $runtime.RepoRoot "scripts\windows\start-connectivity-tunnel.ps1"
        StopScript = Join-Path $runtime.RepoRoot "scripts\windows\stop-connectivity-tunnel.ps1"
        StatusScript = Join-Path $runtime.RepoRoot "scripts\windows\status-connectivity.ps1"
        TaskName = "Artem Control Center Connectivity"
    }
}

function Protect-ArtemConnectivityFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path `
        /inheritance:r `
        /grant:r `
        "*${currentUserSid}:(F)" `
        "*S-1-5-18:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict ACL for $Path"
    }
}

function Get-ArtemConnectivityConfig {
    param([Parameter(Mandatory)]$Paths)
    if (-not (Test-Path -LiteralPath $Paths.Config)) { return $null }
    try {
        $config = Get-Content -LiteralPath $Paths.Config -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
    foreach ($name in @("sshAlias", "localHaPort", "localBotPort")) {
        if ($null -eq $config.$name) { return $null }
    }
    return $config
}

function Get-ArtemConnectivityState {
    param([Parameter(Mandatory)]$Paths)
    if (-not (Test-Path -LiteralPath $Paths.State)) { return $null }
    try {
        return Get-Content -LiteralPath $Paths.State -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Write-ArtemConnectivityState {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][hashtable]$State
    )
    Initialize-ArtemRuntimeDirectories -Paths $Paths.Runtime
    $State.schemaVersion = 1
    $State.observedAt = [DateTime]::UtcNow.ToString("o")
    $temporary = "$($Paths.State).$PID.tmp"
    try {
        $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding ASCII
        Move-Item -LiteralPath $temporary -Destination $Paths.State -Force
        Protect-ArtemConnectivityFile -Path $Paths.State
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Test-ArtemTcpPort {
    param(
        [string]$HostName = "127.0.0.1",
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMilliseconds = 750
    )
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $result = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
            return $false
        }
        $client.EndConnect($result)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Test-ArtemConnectivityReady {
    param([Parameter(Mandatory)]$Paths)
    $config = Get-ArtemConnectivityConfig -Paths $Paths
    if ($null -eq $config) { return $false }
    return (
        (Test-ArtemTcpPort -Port ([int]$config.localHaPort)) -and
        (Test-ArtemTcpPort -Port ([int]$config.localBotPort))
    )
}

function Test-ArtemConnectivitySupervisor {
    param([Parameter(Mandatory)]$Paths)
    $state = Get-ArtemConnectivityState -Paths $Paths
    if ($null -eq $state -or $null -eq $state.supervisorPid) { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.supervisorPid)"
        return (
            $null -ne $process -and
            $process.Name -ieq "powershell.exe" -and
            $process.CommandLine -like "*start-connectivity-tunnel.ps1*"
        )
    }
    catch {
        return $false
    }
}

function Test-ArtemConnectivitySshProcess {
    param([Parameter(Mandatory)]$Paths)
    $state = Get-ArtemConnectivityState -Paths $Paths
    if ($null -eq $state -or $null -eq $state.sshPid) { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.sshPid)"
        return (
            $null -ne $process -and
            $process.Name -ieq "ssh.exe"
        )
    }
    catch {
        return $false
    }
}

function Write-ArtemConnectivityStopMarker {
    param([Parameter(Mandatory)]$Paths)
    Initialize-ArtemRuntimeDirectories -Paths $Paths.Runtime
    [ordered]@{
        schemaVersion = 1
        reason = "manual_stop"
        createdAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $Paths.StopMarker -Encoding ASCII
    Protect-ArtemConnectivityFile -Path $Paths.StopMarker
}

function Stop-ArtemConnectivityProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [bool]$Manual = $true,
        [int]$TimeoutSeconds = 15
    )
    if ($Manual) { Write-ArtemConnectivityStopMarker -Paths $Paths }
    $state = Get-ArtemConnectivityState -Paths $Paths
    if ($state -and $state.sshPid) {
        Stop-Process -Id ([int]$state.sshPid) -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ArtemConnectivitySupervisor -Paths $Paths)) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($state -and $state.supervisorPid -and (Test-ArtemConnectivitySupervisor -Paths $Paths)) {
        Stop-Process -Id ([int]$state.supervisorPid) -Force -ErrorAction SilentlyContinue
    }
}
