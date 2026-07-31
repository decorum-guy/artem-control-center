param(
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$paths = Get-ArtemConnectivityPaths
Initialize-ArtemRuntimeDirectories -Paths $paths.Runtime
Update-ArtemProcessPath

if (-not $AutoStart) {
    $task = Get-ScheduledTask -TaskName $paths.TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw "Connectivity scheduled task is missing. Run install-connectivity-tunnel.ps1."
    }
    Remove-Item -LiteralPath $paths.StopMarker -Force -ErrorAction SilentlyContinue
    if (-not (Test-ArtemConnectivitySupervisor -Paths $paths)) {
        Start-ScheduledTask -TaskName $paths.TaskName
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-ArtemConnectivityReady -Paths $paths) {
            Write-Host "Control Center private connectivity is ready."
            exit 0
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Connectivity task started, but both private forwards did not become ready"
}

if (Test-Path -LiteralPath $paths.StopMarker) {
    exit 0
}
if (Test-ArtemConnectivitySupervisor -Paths $paths) {
    exit 0
}

$config = Get-ArtemConnectivityConfig -Paths $paths
if ($null -eq $config) {
    throw "Connectivity configuration is missing or invalid. Run install-connectivity-tunnel.ps1."
}
if ([string]$config.sshAlias -notmatch '^[A-Za-z0-9._@-]+$') {
    throw "Unsafe SSH alias in connectivity configuration"
}

$ssh = Get-Command ssh.exe -ErrorAction Stop
$supervisorPid = $PID
$attempts = [System.Collections.Generic.List[datetime]]::new()
$logPath = Join-Path $paths.Runtime.Logs ("connectivity-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-ConnectivityLog {
    param([Parameter(Mandatory)][string]$Message)
    $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Set-ConnectivityState {
    param(
        [Parameter(Mandatory)][string]$Status,
        [int]$SshPid = 0,
        [string]$ErrorCode = ""
    )
    $payload = @{
        status = $Status
        supervisorPid = $supervisorPid
        sshPid = if ($SshPid -gt 0) { $SshPid } else { $null }
        sshAlias = [string]$config.sshAlias
        localHaPort = [int]$config.localHaPort
        localBotPort = [int]$config.localBotPort
        haPortReady = Test-ArtemTcpPort -Port ([int]$config.localHaPort)
        botPortReady = Test-ArtemTcpPort -Port ([int]$config.localBotPort)
        error = if ($ErrorCode) { $ErrorCode } else { $null }
    }
    Write-ArtemConnectivityState -Paths $paths -State $payload
}

Write-ConnectivityLog "connectivity supervisor started"
Set-ConnectivityState -Status "starting"

while ($true) {
    if (Test-Path -LiteralPath $paths.StopMarker) {
        Set-ConnectivityState -Status "stopped"
        Write-ConnectivityLog "manual stop marker observed"
        exit 0
    }

    $now = Get-Date
    for ($index = $attempts.Count - 1; $index -ge 0; $index--) {
        if (($now - $attempts[$index]).TotalMinutes -gt 10) {
            $attempts.RemoveAt($index)
        }
    }
    if ($attempts.Count -ge 10) {
        Set-ConnectivityState -Status "failed" -ErrorCode "restart_budget_exhausted"
        Write-ConnectivityLog "restart budget exhausted"
        exit 1
    }
    [void]$attempts.Add($now)

    $attemptId = [guid]::NewGuid().ToString("N").Substring(0, 10)
    $stdoutPath = Join-Path $paths.Runtime.Logs "connectivity-ssh-$attemptId.stdout.log"
    $stderrPath = Join-Path $paths.Runtime.Logs "connectivity-ssh-$attemptId.stderr.log"
    $arguments = @(
        "-N",
        "-T",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        [string]$config.sshAlias
    )

    try {
        $process = Start-Process `
            -FilePath $ssh.Source `
            -ArgumentList $arguments `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
    }
    catch {
        Set-ConnectivityState -Status "degraded" -ErrorCode "ssh_start_failed"
        Write-ConnectivityLog "ssh process could not start"
        Start-Sleep -Seconds 5
        continue
    }

    Write-ConnectivityLog "ssh attempt started pid=$($process.Id)"
    Set-ConnectivityState -Status "starting" -SshPid $process.Id

    $readyDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $readyDeadline -and -not $process.HasExited) {
        if (Test-ArtemConnectivityReady -Paths $paths) { break }
        Start-Sleep -Milliseconds 500
        $process.Refresh()
    }

    if (-not $process.HasExited -and (Test-ArtemConnectivityReady -Paths $paths)) {
        Set-ConnectivityState -Status "running" -SshPid $process.Id
        Write-ConnectivityLog "both local forwards are ready"
        $consecutiveFailures = 0
        while (-not $process.HasExited) {
            if (Test-Path -LiteralPath $paths.StopMarker) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                Set-ConnectivityState -Status "stopped"
                Write-ConnectivityLog "manual stop requested"
                exit 0
            }
            if (Test-ArtemConnectivityReady -Paths $paths) {
                $consecutiveFailures = 0
            }
            else {
                $consecutiveFailures++
                Set-ConnectivityState -Status "degraded" -SshPid $process.Id -ErrorCode "forward_probe_failed"
                if ($consecutiveFailures -ge 3) {
                    Write-ConnectivityLog "forward probes failed three times; restarting ssh"
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                    break
                }
            }
            Start-Sleep -Seconds 5
            $process.Refresh()
        }
    }
    else {
        Write-ConnectivityLog "ssh exited or forwards did not become ready"
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }

    Set-ConnectivityState -Status "degraded" -ErrorCode "ssh_disconnected"
    Start-Sleep -Seconds ([Math]::Min(30, [Math]::Max(2, $attempts.Count * 2)))
}
