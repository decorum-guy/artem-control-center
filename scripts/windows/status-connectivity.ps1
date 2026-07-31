param(
    [switch]$Json
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$paths = Get-ArtemConnectivityPaths
$config = Get-ArtemConnectivityConfig -Paths $paths
$state = Get-ArtemConnectivityState -Paths $paths
$task = Get-ScheduledTask -TaskName $paths.TaskName -ErrorAction SilentlyContinue

$status = [ordered]@{
    configured = $null -ne $config
    supervisorProcess = Test-ArtemConnectivitySupervisor -Paths $paths
    sshProcess = Test-ArtemConnectivitySshProcess -Paths $paths
    ready = Test-ArtemConnectivityReady -Paths $paths
    manualStop = Test-Path -LiteralPath $paths.StopMarker
    scheduledTask = $null -ne $task
    scheduledTaskState = if ($task) { [string]$task.State } else { $null }
    sshAlias = if ($config) { [string]$config.sshAlias } else { $null }
    localHaPort = if ($config) { [int]$config.localHaPort } else { $null }
    localBotPort = if ($config) { [int]$config.localBotPort } else { $null }
    haPortReady = if ($config) { Test-ArtemTcpPort -Port ([int]$config.localHaPort) } else { $false }
    botPortReady = if ($config) { Test-ArtemTcpPort -Port ([int]$config.localBotPort) } else { $false }
    supervisorPid = if ($state) { $state.supervisorPid } else { $null }
    sshPid = if ($state) { $state.sshPid } else { $null }
    status = if ($state) { $state.status } else { $null }
    error = if ($state) { $state.error } else { $null }
    observedAt = if ($state) { $state.observedAt } else { $null }
    logs = $paths.Runtime.Logs
}

if ($Json) {
    $status | ConvertTo-Json -Depth 5
}
else {
    $status.GetEnumerator() | ForEach-Object {
        "{0,-22} {1}" -f $_.Key, $_.Value
    }
}
