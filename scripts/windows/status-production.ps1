param(
    [switch]$Json
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$state = Get-ArtemRuntimeState -Paths $paths
$task = Get-ScheduledTask -TaskName "Artem Control Center Runtime" -ErrorAction SilentlyContinue

$status = [ordered]@{
    runtimeProcess = Test-ArtemRuntimeProcess -Paths $paths
    panelReady = Test-ArtemPanelReady -Paths $paths
    kioskOpen = Test-ArtemKioskRunning -Paths $paths
    manualStop = Test-Path -LiteralPath $paths.ManualStop
    scheduledTask = $null -ne $task
    scheduledTaskState = if ($task) { [string]$task.State } else { $null }
    supervisorPid = if ($state) { $state.supervisorPid } else { $null }
    agentPid = if ($state) { $state.agentPid } else { $null }
    mode = if ($state) { $state.mode } else { $null }
    revision = if ($state) { $state.revision } else { $null }
    runtimeStatus = if ($state) { $state.status } else { $null }
    observedAt = if ($state) { $state.observedAt } else { $null }
    logs = $paths.Logs
}

if ($Json) {
    $status | ConvertTo-Json -Depth 4
}
else {
    $status.GetEnumerator() | ForEach-Object {
        "{0,-20} {1}" -f $_.Key, $_.Value
    }
}
